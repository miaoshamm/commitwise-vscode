import { AiError } from './types';
import { createTimeoutSignal, isAbortError } from './streamClient';

export interface ModelInfo {
  id: string;
  /** 服务商给出的展示名 / 额外说明 */
  note?: string;
}

export interface ListModelsOptions {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Azure 没有公开的模型列表接口（deployment 属于管理面），只能手填 */
export function supportsModelList(provider: string): boolean {
  return provider === 'openai-compatible' || provider === 'anthropic' || provider === 'ollama';
}

function join(base: string, path: string): string {
  const b = (base ?? '').trim().replace(/\/+$/, '');
  if (!b) {
    throw new AiError('接口地址为空，无法获取模型列表', 'unsupported');
  }
  return `${b}/${path.replace(/^\/+/, '')}`;
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const timeout = createTimeoutSignal(signal, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers, signal: timeout.signal });
    } catch (err) {
      if (isAbortError(err)) {
        throw new AiError('获取模型列表已取消', 'aborted');
      }
      if (timeout.didTimeout()) {
        throw new AiError('获取模型列表超时', 'timeout');
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new AiError(cause?.message || (err as Error).message || '网络请求失败', 'network');
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let detail = body.trim();
      try {
        const json = JSON.parse(body);
        detail = json?.error?.message ?? json?.message ?? detail;
      } catch {
        // 保留原文
      }
      if (res.status === 404) {
        throw new AiError(`该地址没有模型列表接口（404）：${url}`, 'unsupported', 404, detail);
      }
      if (res.status === 401 || res.status === 403) {
        throw new AiError('密钥无效，无法获取模型列表', 'auth', res.status, detail);
      }
      throw new AiError(`${res.status} ${detail}`.trim(), res.status >= 500 ? 'server' : 'bad-request', res.status, detail);
    }
    return await res.json();
  } finally {
    timeout.dispose();
  }
}

/** OpenAI / Anthropic 的 /models 结构兼容：{ data: [{ id, ... }] } */
function fromDataArray(json: any): ModelInfo[] {
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  const out: ModelInfo[] = [];
  for (const item of arr) {
    const id = typeof item?.id === 'string' ? item.id : typeof item?.name === 'string' ? item.name : typeof item === 'string' ? item : '';
    if (!id) {
      continue;
    }
    const note =
      typeof item?.display_name === 'string'
        ? item.display_name
        : typeof item?.owned_by === 'string' && item.owned_by
          ? item.owned_by
          : undefined;
    out.push({ id, note });
  }
  return out;
}

function fromOllama(json: any): ModelInfo[] {
  const arr = Array.isArray(json?.models) ? json.models : [];
  const out: ModelInfo[] = [];
  for (const item of arr) {
    const id = typeof item?.name === 'string' ? item.name : typeof item?.model === 'string' ? item.model : '';
    if (!id) {
      continue;
    }
    const size = typeof item?.size === 'number' ? `${(item.size / 1024 / 1024 / 1024).toFixed(1)}GB` : '';
    const params = typeof item?.details?.parameter_size === 'string' ? item.details.parameter_size : '';
    out.push({ id, note: [params, size].filter(Boolean).join(' · ') || undefined });
  }
  return out;
}

/**
 * 拉取服务商可用的模型列表。纯 fetch，不依赖 vscode，便于单测。
 * 失败时抛 AiError，由调用方决定是提示还是静默降级。
 */
export async function listModels(opts: ListModelsOptions): Promise<ModelInfo[]> {
  const timeoutMs = Math.min(opts.timeoutMs ?? 15000, 30000);
  const { provider, baseUrl, apiKey, signal } = opts;

  if (!supportsModelList(provider)) {
    throw new AiError(
      provider === 'azure-openai'
        ? 'Azure OpenAI 不提供模型列表接口，请手动填写 deployment 名称'
        : `服务商 ${provider} 不支持自动获取模型列表`,
      'unsupported',
    );
  }

  if (provider === 'ollama') {
    // Ollama 的 baseUrl 可能被填成 http://host:11434/api，这里做容错
    const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/, '');
    const json = await getJson(join(base, 'api/tags'), { accept: 'application/json' }, timeoutMs, signal);
    return sortModels(fromOllama(json), provider);
  }

  if (provider === 'anthropic') {
    const json = await getJson(
      join(baseUrl, 'models?limit=1000'),
      {
        accept: 'application/json',
        'x-api-key': apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      timeoutMs,
      signal,
    );
    return sortModels(fromDataArray(json), provider);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const json = await getJson(join(baseUrl, 'models'), headers, timeoutMs, signal);
  return sortModels(fromDataArray(json), provider);
}

/** 明显不是对话模型的家族，排在最后（不直接丢弃，用户可能就要用） */
const NON_CHAT = [
  'embedding',
  'embed',
  'whisper',
  'tts',
  'dall-e',
  'moderation',
  'image',
  'audio',
  'rerank',
  'transcribe',
  'speech',
  'diffusion',
  'stable-diffusion',
  'bge-',
  'text-embedding',
  'aqa',
];

/** 适合本插件（写提交信息 / 审代码）的偏好关键词，命中越靠前 */
const PREFERRED = ['coder', 'gpt-4', 'claude', 'deepseek', 'qwen', 'glm', 'o3', 'o4', 'sonnet', 'haiku', 'llama3'];

export function isLikelyChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT.some((k) => lower.includes(k));
}

function rank(id: string): number {
  const lower = id.toLowerCase();
  if (!isLikelyChatModel(id)) {
    return 100;
  }
  const idx = PREFERRED.findIndex((k) => lower.includes(k));
  return idx >= 0 ? idx : 50;
}

export function sortModels(models: ModelInfo[], provider = 'openai-compatible'): ModelInfo[] {
  const seen = new Set<string>();
  const unique = models.filter((m) => {
    if (seen.has(m.id)) {
      return false;
    }
    seen.add(m.id);
    return true;
  });
  return unique.sort((a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    if (ra !== rb) {
      return ra - rb;
    }
    return a.id.localeCompare(b.id, 'en');
  });
}

/**
 * 从模型列表里挑一个「最可能好用」的默认模型：
 * 优先推荐列表里出现过的偏好模型，其次第一个对话模型。
 */
export function pickDefaultModel(models: ModelInfo[], suggestions: string[] = []): string | undefined {
  if (models.length === 0) {
    return undefined;
  }
  for (const s of suggestions) {
    if (models.some((m) => m.id === s)) {
      return s;
    }
  }
  const chat = models.find((m) => isLikelyChatModel(m.id));
  return (chat ?? models[0]).id;
}
