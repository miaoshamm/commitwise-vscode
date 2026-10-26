import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isLikelyChatModel,
  listModels,
  pickDefaultModel,
  sortModels,
  supportsModelList,
} from '../src/infra/ai/modelCatalog';
import { AiError } from '../src/infra/ai/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listModels', () => {
  it('OpenAI 兼容：解析 data[].id 并带上 Bearer', async () => {
    let seen: { url: string; auth?: string } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any) => {
        seen = { url, auth: init?.headers?.authorization };
        return json({ data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }, { id: 'text-embedding-3-small' }] });
      }),
    );

    const models = await listModels({ provider: 'openai-compatible', baseUrl: 'https://api.x.com/v1', apiKey: 'k' });
    expect(seen?.url).toBe('https://api.x.com/v1/models');
    expect(seen?.auth).toBe('Bearer k');
    expect(models.map((m) => m.id)).toContain('gpt-4o-mini');
    // 对话模型排在 embedding 前面
    expect(models[0].id).toBe('gpt-4o-mini');
    expect(models[0].note).toBe('openai');
  });

  it('baseUrl 末尾多余斜杠不会产生双斜杠', async () => {
    let url = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        url = u;
        return json({ data: [{ id: 'a' }] });
      }),
    );
    await listModels({ provider: 'openai-compatible', baseUrl: 'https://api.x.com/v1///', apiKey: 'k' });
    expect(url).toBe('https://api.x.com/v1/models');
  });

  it('Anthropic：使用 x-api-key 与版本头，display_name 作为说明', async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: any) => {
        headers = init.headers;
        return json({ data: [{ id: 'claude-3-5-haiku-latest', display_name: 'Claude Haiku' }] });
      }),
    );
    const models = await listModels({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant' });
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBeTruthy();
    expect(headers.authorization).toBeUndefined();
    expect(models[0]).toEqual({ id: 'claude-3-5-haiku-latest', note: 'Claude Haiku' });
  });

  it('Ollama：走 /api/tags，且容错带 /api 的 baseUrl', async () => {
    let url = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        url = u;
        return json({ models: [{ name: 'qwen2.5-coder:7b', size: 4 * 1024 * 1024 * 1024, details: { parameter_size: '7B' } }] });
      }),
    );
    const models = await listModels({ provider: 'ollama', baseUrl: 'http://localhost:11434/api' });
    expect(url).toBe('http://localhost:11434/api/tags');
    expect(models[0].id).toBe('qwen2.5-coder:7b');
    expect(models[0].note).toContain('7B');
  });

  it('401 归类为密钥错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'invalid api key' } }, 401)));
    await expect(
      listModels({ provider: 'openai-compatible', baseUrl: 'https://api.x.com/v1', apiKey: 'bad' }),
    ).rejects.toMatchObject({ code: 'auth' });
  });

  it('404 归类为「该地址没有模型列表接口」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'not found' }, 404)));
    const err = await listModels({ provider: 'openai-compatible', baseUrl: 'https://gw.local/v1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('unsupported');
    expect((err as AiError).message).toContain('模型列表');
  });

  it('Azure 直接拒绝并说明原因', async () => {
    const err = await listModels({ provider: 'azure-openai', baseUrl: 'https://x.openai.azure.com/openai' }).catch((e) => e);
    expect((err as AiError).code).toBe('unsupported');
    expect((err as AiError).message).toContain('deployment');
  });

  it('接口地址为空时给出明确错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    await expect(listModels({ provider: 'openai-compatible', baseUrl: '' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('supportsModelList', () => {
  it('只有 Azure 不支持', () => {
    expect(supportsModelList('openai-compatible')).toBe(true);
    expect(supportsModelList('anthropic')).toBe(true);
    expect(supportsModelList('ollama')).toBe(true);
    expect(supportsModelList('azure-openai')).toBe(false);
  });
});

describe('sortModels / pickDefaultModel', () => {
  it('去重且对话模型优先', () => {
    const sorted = sortModels([
      { id: 'text-embedding-3-large' },
      { id: 'whisper-1' },
      { id: 'gpt-4o-mini' },
      { id: 'gpt-4o-mini' },
      { id: 'deepseek-chat' },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['gpt-4o-mini', 'deepseek-chat', 'text-embedding-3-large', 'whisper-1']);
  });

  it('识别非对话模型', () => {
    expect(isLikelyChatModel('gpt-4o')).toBe(true);
    expect(isLikelyChatModel('text-embedding-ada-002')).toBe(false);
    expect(isLikelyChatModel('dall-e-3')).toBe(false);
  });

  it('优先返回建议列表里存在的模型', () => {
    const models = [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }];
    expect(pickDefaultModel(models, ['gpt-4o-mini', 'gpt-4o'])).toBe('gpt-4o-mini');
  });

  it('建议都不存在时退到第一个对话模型', () => {
    const models = [{ id: 'text-embedding-3-small' }, { id: 'some-chat-model' }];
    expect(pickDefaultModel(models, ['gpt-4o'])).toBe('some-chat-model');
  });

  it('空列表返回 undefined', () => {
    expect(pickDefaultModel([], ['x'])).toBeUndefined();
  });
});
