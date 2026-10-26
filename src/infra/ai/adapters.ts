import { NdjsonParser, SseParser } from './sseParser';
import { createTimeoutSignal, httpError, isAbortError, pumpStream } from './streamClient';
import { AiError, ChatCallOptions, ChatRequest, ProviderAdapter, ProviderContext } from './types';

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) {
    throw new AiError('接口地址为空', 'unsupported');
  }
  if (b.endsWith('/' + p)) {
    return b;
  }
  return `${b}/${p}`;
}

function jsonHeaders(ctx: ProviderContext, withBearer = true): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (withBearer && ctx.apiKey) {
    headers.authorization = `Bearer ${ctx.apiKey}`;
  }
  return headers;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: ProviderContext,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (isAbortError(err)) {
      throw new AiError('请求已取消', 'aborted');
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new AiError(cause?.message || (err as Error).message || '网络请求失败', 'network');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw httpError(res.status, text);
  }
  return res;
}

function isEventStream(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('text/event-stream');
}

function isNdjson(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/x-ndjson') || ct.includes('application/jsonl');
}

/** 某些网关会忽略 stream 参数直接返回完整 JSON，这里做兜底 */
async function readJsonFallback(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as Record<string, any>;
    const content = json?.choices?.[0]?.message?.content ?? json?.content?.[0]?.text ?? json?.message?.content ?? '';
    if (typeof content === 'string' && content) {
      return content;
    }
  } catch {
    // 落到统一报错
  }
  throw new AiError('服务端返回了无法识别的响应', 'bad-response', res.status, text.slice(0, 300));
}

function normalizeAbort(err: unknown, timeout: { didTimeout: () => boolean }): unknown {
  if (err instanceof AiError) {
    if (err.code === 'aborted') {
      return timeout.didTimeout() ? new AiError('请求超时', 'timeout') : err;
    }
    return err;
  }
  if (isAbortError(err)) {
    return timeout.didTimeout() ? new AiError('请求超时', 'timeout') : new AiError('请求已取消', 'aborted');
  }
  return err;
}

/**
 * OpenAI 兼容：OpenAI / DeepSeek / Qwen / Moonshot / 自建网关
 */
export const openaiCompatibleAdapter: ProviderAdapter = {
  id: 'openai-compatible',
  requiresApiKey: true,
  async chat(req: ChatRequest, ctx: ProviderContext, opts: ChatCallOptions) {
    const url = /\/chat\/completions$/.test(ctx.baseUrl) ? ctx.baseUrl : joinUrl(ctx.baseUrl, 'chat/completions');
    const timeout = createTimeoutSignal(opts.signal, ctx.timeoutMs);
    try {
      const res = await postJson(
        url,
        jsonHeaders(ctx),
        {
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          stream: true,
        },
        ctx,
        timeout.signal,
      );

      if (!isEventStream(res)) {
        return { text: await readJsonFallback(res) };
      }

      const parser = new SseParser();
      let text = '';
      const handle = (data: string) => {
        if (data === '[DONE]') {
          return;
        }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        if (json?.error) {
          throw new AiError(String(json.error?.message ?? '模型服务返回错误'), 'server');
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          opts.onDelta?.(delta);
        }
      };

      await pumpStream(res, (chunk) => {
        for (const ev of parser.push(chunk)) {
          handle(ev.data);
        }
      });
      for (const ev of parser.flush()) {
        handle(ev.data);
      }

      if (!text.trim()) {
        throw new AiError('模型没有返回任何内容', 'bad-response');
      }
      return { text };
    } catch (err) {
      throw normalizeAbort(err, timeout);
    } finally {
      timeout.dispose();
    }
  },
};

/**
 * Anthropic Messages API
 */
export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  requiresApiKey: true,
  async chat(req: ChatRequest, ctx: ProviderContext, opts: ChatCallOptions) {
    const url = /\/messages$/.test(ctx.baseUrl) ? ctx.baseUrl : joinUrl(ctx.baseUrl, 'messages');
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));

    const timeout = createTimeoutSignal(opts.signal, ctx.timeoutMs);
    try {
      const res = await postJson(
        url,
        { ...jsonHeaders(ctx, false), 'x-api-key': ctx.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        {
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(system ? { system } : {}),
          messages,
          stream: true,
        },
        ctx,
        timeout.signal,
      );

      if (!isEventStream(res)) {
        return { text: await readJsonFallback(res) };
      }

      const parser = new SseParser();
      let text = '';
      const handle = (event: string | undefined, data: string) => {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        const type = json?.type ?? event;
        if (type === 'error') {
          throw new AiError(String(json?.error?.message ?? '模型服务返回错误'), 'server');
        }
        if (type === 'content_block_delta' && json?.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
          text += json.delta.text;
          opts.onDelta?.(json.delta.text);
        }
      };

      await pumpStream(res, (chunk) => {
        for (const ev of parser.push(chunk)) {
          handle(ev.event, ev.data);
        }
      });
      for (const ev of parser.flush()) {
        handle(ev.event, ev.data);
      }

      if (!text.trim()) {
        throw new AiError('模型没有返回任何内容', 'bad-response');
      }
      return { text };
    } catch (err) {
      throw normalizeAbort(err, timeout);
    } finally {
      timeout.dispose();
    }
  },
};

/**
 * Azure OpenAI：模型名即 deployment 名
 */
export const azureOpenaiAdapter: ProviderAdapter = {
  id: 'azure-openai',
  requiresApiKey: true,
  async chat(req: ChatRequest, ctx: ProviderContext, opts: ChatCallOptions) {
    const apiVersion = '2024-06-01';
    const url = /\/chat\/completions/.test(ctx.baseUrl)
      ? ctx.baseUrl
      : `${joinUrl(ctx.baseUrl, `openai/deployments/${encodeURIComponent(req.model)}/chat/completions`)}?api-version=${apiVersion}`;

    const timeout = createTimeoutSignal(opts.signal, ctx.timeoutMs);
    try {
      const res = await postJson(
        url,
        { ...jsonHeaders(ctx, false), 'api-key': ctx.apiKey ?? '' },
        {
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          stream: true,
        },
        ctx,
        timeout.signal,
      );

      if (!isEventStream(res)) {
        return { text: await readJsonFallback(res) };
      }

      const parser = new SseParser();
      let text = '';
      await pumpStream(res, (chunk) => {
        for (const ev of parser.push(chunk)) {
          if (ev.data === '[DONE]') {
            continue;
          }
          try {
            const json = JSON.parse(ev.data);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              text += delta;
              opts.onDelta?.(delta);
            }
          } catch {
            // 忽略无法解析的帧
          }
        }
      });

      if (!text.trim()) {
        throw new AiError('模型没有返回任何内容', 'bad-response');
      }
      return { text };
    } catch (err) {
      throw normalizeAbort(err, timeout);
    } finally {
      timeout.dispose();
    }
  },
};

/**
 * Ollama 本地服务：NDJSON 流，无需密钥
 */
export const ollamaAdapter: ProviderAdapter = {
  id: 'ollama',
  requiresApiKey: false,
  async chat(req: ChatRequest, ctx: ProviderContext, opts: ChatCallOptions) {
    const url = /\/api\/chat$/.test(ctx.baseUrl) ? ctx.baseUrl : joinUrl(ctx.baseUrl, 'api/chat');
    const timeout = createTimeoutSignal(opts.signal, ctx.timeoutMs);
    try {
      const res = await postJson(
        url,
        jsonHeaders(ctx),
        {
          model: req.model,
          messages: req.messages,
          stream: true,
          options: { temperature: req.temperature, num_predict: req.maxTokens },
        },
        ctx,
        timeout.signal,
      );

      if (!isNdjson(res) && !isEventStream(res)) {
        return { text: await readJsonFallback(res) };
      }

      const parser = new NdjsonParser();
      let text = '';
      const handle = (obj: unknown) => {
        const json = obj as { message?: { content?: string }; error?: string };
        if (json?.error) {
          throw new AiError(json.error, 'server');
        }
        const delta = json?.message?.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          opts.onDelta?.(delta);
        }
      };

      await pumpStream(res, (chunk) => {
        for (const obj of parser.push(chunk)) {
          handle(obj);
        }
      });
      for (const obj of parser.flush()) {
        handle(obj);
      }

      if (!text.trim()) {
        throw new AiError('模型没有返回任何内容', 'bad-response');
      }
      return { text };
    } catch (err) {
      throw normalizeAbort(err, timeout);
    } finally {
      timeout.dispose();
    }
  },
};

export const ADAPTERS: Record<string, ProviderAdapter> = {
  [openaiCompatibleAdapter.id]: openaiCompatibleAdapter,
  [anthropicAdapter.id]: anthropicAdapter,
  [azureOpenaiAdapter.id]: azureOpenaiAdapter,
  [ollamaAdapter.id]: ollamaAdapter,
};

export function getAdapter(id: string): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new AiError(`不支持的服务商类型：${id}`, 'unsupported');
  }
  return adapter;
}
