import { AiError } from './types';

/** 逐块读取响应体，交给解析器 */
export async function pumpStream(res: Response, onChunk: (text: string) => void): Promise<void> {
  if (!res.body) {
    throw new AiError('响应没有可读的流式内容', 'bad-response', res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        onChunk(decoder.decode(value, { stream: true }));
      }
    }
    const tail = decoder.decode();
    if (tail) {
      onChunk(tail);
    }
  } catch (err) {
    if (isAbortError(err)) {
      throw new AiError('请求已取消', 'aborted');
    }
    throw new AiError(`读取响应流失败：${(err as Error).message}`, 'network');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 忽略
    }
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as { name?: string }).name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
  );
}

const STATUS_MAP: Record<number, AiError['code']> = {
  400: 'bad-request',
  401: 'auth',
  403: 'auth',
  404: 'bad-request',
  408: 'timeout',
  422: 'bad-request',
  429: 'rate-limit',
};

export function httpError(status: number, bodyText: string): AiError {
  const code = STATUS_MAP[status] ?? (status >= 500 ? 'server' : 'bad-request');
  const detail = extractErrorMessage(bodyText);
  const summary = detail ? `${status} ${detail}` : String(status);
  return new AiError(summary, code, status, detail);
}

function extractErrorMessage(body: string): string {
  const text = body.trim();
  if (!text) {
    return '';
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const err = json.error as Record<string, unknown> | string | undefined;
    if (typeof err === 'string') {
      return err;
    }
    if (err && typeof err === 'object' && typeof err.message === 'string') {
      return err.message;
    }
    if (typeof json.message === 'string') {
      return json.message;
    }
  } catch {
    // 非 JSON，直接截断返回
  }
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

/** 把外部取消信号与超时合并成一个 AbortSignal */
export function createTimeoutSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}
