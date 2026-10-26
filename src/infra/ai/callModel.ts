import { ResolvedConfig } from '../config/configTypes';
import { getAdapter } from './adapters';
import { AiError, ChatMessage, ProviderAdapter } from './types';

export interface CallModelOptions {
  config: ResolvedConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onRetry?: (attempt: number, error: AiError, delayMs: number) => void;
  maxTokens?: number;
  logger?: { warn(msg: string): void; debug(msg: string): void };
}

export interface CallModelResult {
  text: string;
  attempts: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiError('请求已取消', 'aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiError('请求已取消', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * 统一调用入口：选适配器 → 调用 → 失败退避重试。
 *
 * 重试前提：错误可重试 且 **尚未输出任何内容**。
 * 一旦流式内容已经开始吐字，重试会导致用户看到重复片段，宁可报错。
 */
export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  const { config } = opts;
  const adapter: ProviderAdapter = getAdapter(config.provider);
  const maxRetries = Math.max(0, config.maxRetries);
  let emitted = false;

  const wrappedDelta = opts.onDelta
    ? (delta: string) => {
        emitted = true;
        opts.onDelta!(delta);
      }
    : undefined;

  let lastError: AiError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new AiError('请求已取消', 'aborted');
    }
    try {
      opts.logger?.debug(`调用 ${config.provider} / ${config.model}（第 ${attempt + 1} 次）`);
      const { text } = await adapter.chat(
        {
          model: config.model,
          messages: opts.messages,
          temperature: config.temperature,
          maxTokens: opts.maxTokens ?? config.maxTokens,
        },
        { baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.requestTimeoutMs },
        { signal: opts.signal, onDelta: wrappedDelta },
      );
      return { text, attempts: attempt + 1 };
    } catch (err) {
      lastError = err instanceof AiError ? err : new AiError((err as Error).message, 'unsupported');
      const canRetry = lastError.retryable && !emitted && attempt < maxRetries;
      if (!canRetry) {
        throw lastError;
      }
      const delay = Math.min(8000, 600 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
      opts.logger?.warn(`请求失败（${lastError.code}），${delay}ms 后重试：${lastError.message}`);
      opts.onRetry?.(attempt + 1, lastError, delay);
      await sleep(delay, opts.signal);
      emitted = false;
    }
  }

  throw lastError ?? new AiError('未知错误', 'unsupported');
}

/** 「测试连接」用：只发一句最短的指令 */
export async function pingModel(config: ResolvedConfig, signal?: AbortSignal): Promise<{ ok: boolean; sample: string; ms: number }> {
  const started = Date.now();
  const { text } = await callModel({
    config,
    messages: [
      { role: 'system', content: '你是一个测试端点，只回复 OK。' },
      { role: 'user', content: '回复 OK' },
    ],
    maxTokens: 16,
    signal,
  });
  return { ok: true, sample: text.trim().slice(0, 40), ms: Date.now() - started };
}
