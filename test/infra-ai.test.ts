import { afterEach, describe, expect, it, vi } from 'vitest';
import { NdjsonParser, SseParser } from '../src/infra/ai/sseParser';
import { anthropicAdapter, ollamaAdapter, openaiCompatibleAdapter, joinUrl } from '../src/infra/ai/adapters';
import { callModel } from '../src/infra/ai/callModel';
import { AiError } from '../src/infra/ai/types';
import { ResolvedConfig } from '../src/infra/config/configTypes';

function streamResponse(chunks: string[], contentType: string, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

const ctx = { baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', timeoutMs: 5000 };
const req = {
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  temperature: 0.2,
  maxTokens: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SseParser', () => {
  it('跨 chunk 拼接不完整帧', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":')).toEqual([]);
    const events = parser.push('1}\n\n');
    expect(events).toEqual([{ event: undefined, data: '{"a":1}', id: undefined }]);
  });

  it('一个 chunk 中包含多个事件', () => {
    const parser = new SseParser();
    const events = parser.push('data: a\n\ndata: b\n\n');
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('支持 CRLF 换行', () => {
    const parser = new SseParser();
    const events = parser.push('event: ping\r\ndata: x\r\n\r\n');
    expect(events[0]).toMatchObject({ event: 'ping', data: 'x' });
  });

  it('忽略注释行，多行 data 用换行连接', () => {
    const parser = new SseParser();
    const events = parser.push(': keep-alive\ndata: l1\ndata: l2\n\n');
    expect(events[0].data).toBe('l1\nl2');
  });

  it('flush 吐出没有空行收尾的残留帧', () => {
    const parser = new SseParser();
    parser.push('data: tail');
    expect(parser.flush()).toEqual([{ event: undefined, data: 'tail', id: undefined }]);
  });

  it('空帧被忽略', () => {
    const parser = new SseParser();
    expect(parser.push('\n\n')).toEqual([]);
  });
});

describe('NdjsonParser', () => {
  it('逐行解析并保留残行', () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(parser.flush()).toEqual([]);
  });

  it('忽略损坏行', () => {
    const parser = new NdjsonParser();
    expect(parser.push('not json\n{"a":2}\n')).toEqual([{ a: 2 }]);
  });
});

describe('joinUrl', () => {
  it('拼接路径且不重复斜杠', () => {
    expect(joinUrl('https://x.com/v1/', '/chat/completions')).toBe('https://x.com/v1/chat/completions');
    expect(joinUrl('https://x.com/v1/chat/completions', 'chat/completions')).toBe('https://x.com/v1/chat/completions');
  });
});

describe('openaiCompatibleAdapter', () => {
  it('解析多帧 SSE 增量', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse(
          [
            'data: {"choices":[{"delta":{"content":"feat"}}]}\n\ndata: {"choices":[{"delta":{"con',
            'tent":"(api): 新增导出"}}]}\n\ndata: [DONE]\n\n',
          ],
          'text/event-stream',
        ),
      ),
    );

    const deltas: string[] = [];
    const out = await openaiCompatibleAdapter.chat(req, ctx, { onDelta: (d) => deltas.push(d) });
    expect(out.text).toBe('feat(api): 新增导出');
    expect(deltas).toEqual(['feat', '(api): 新增导出']);
  });

  it('401 映射为 auth 错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })),
    );
    await expect(openaiCompatibleAdapter.chat(req, ctx, {})).rejects.toMatchObject({ code: 'auth', status: 401 });
  });

  it('网关忽略 stream 返回整包 JSON 时也能兜住', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'fix: 修复' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const out = await openaiCompatibleAdapter.chat(req, ctx, {});
    expect(out.text).toBe('fix: 修复');
  });

  it('空响应报 bad-response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['data: [DONE]\n\n'], 'text/event-stream')));
    await expect(openaiCompatibleAdapter.chat(req, ctx, {})).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('anthropicAdapter', () => {
  it('使用 x-api-key 并解析 text_delta', async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse(
        [
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ],
        'text/event-stream',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await anthropicAdapter.chat(req, ctx, {});
    expect(out.text).toBe('你好');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('error 事件转为 AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse(
          ['event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n'],
          'text/event-stream',
        ),
      ),
    );
    await expect(anthropicAdapter.chat(req, ctx, {})).rejects.toBeInstanceOf(AiError);
  });
});

describe('ollamaAdapter', () => {
  it('解析 NDJSON 流', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse(
          ['{"message":{"content":"chore"},"done":false}\n{"message":{"content":": 升级依赖"}', ',"done":false}\n{"done":true}\n'],
          'application/x-ndjson',
        ),
      ),
    );
    const out = await ollamaAdapter.chat(req, ctx, {});
    expect(out.text).toBe('chore: 升级依赖');
  });
});

describe('callModel', () => {
  const baseConfig: ResolvedConfig = {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    autoFetchModels: true,
    availableModels: [],
    apiKey: 'k',
    temperature: 0.2,
    maxTokens: 100,
    requestTimeoutMs: 5000,
    maxRetries: 1,
    apiKeyEnv: '',
    language: 'zh-CN',
    commit: {
      format: 'conventional',
      language: 'zh-CN',
      templateId: 'builtin-conventional-zh',
      maxSubjectLength: 72,
      includeBody: true,
      recentCommitCount: 5,
      confirmBeforeInsert: false,
    },
    diff: { maxTotalChars: 48000, maxFileChars: 20000, excludeGlobs: [], redactSecrets: true },
    review: { templateId: 'builtin-review-standard', minSeverity: 'low', maxIssues: 30, showDiagnostics: true },
    customTemplates: [],
  };

  it('可重试错误在未输出内容时重试', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response('{"error":{"message":"rate limited"}}', { status: 429 });
        }
        return streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'], 'text/event-stream');
      }),
    );

    const result = await callModel({
      config: baseConfig,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.text).toBe('ok');
    expect(result.attempts).toBe(2);
  }, 10000);

  it('认证错误不重试', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('{"error":{"message":"bad key"}}', { status: 401 });
      }),
    );

    await expect(callModel({ config: baseConfig, messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'auth',
    });
    expect(calls).toBe(1);
  });

  it('已输出内容后不再重试', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n'));
            // 先让消费方拿到第一段内容，再让连接断掉
            setTimeout(() => controller.error(new Error('connection reset')), 30);
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    await expect(
      callModel({ config: baseConfig, messages: [{ role: 'user', content: 'x' }], onDelta: () => undefined }),
    ).rejects.toBeInstanceOf(AiError);
    expect(calls).toBe(1);
  });

  it('不支持的服务商直接报错', async () => {
    await expect(
      callModel({
        config: { ...baseConfig, provider: 'nope' as never },
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});
