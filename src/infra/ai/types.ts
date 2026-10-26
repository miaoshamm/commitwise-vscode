export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
}

export type AiErrorCode =
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad-request'
  | 'aborted'
  | 'bad-response'
  | 'unsupported';

export class AiError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly code: AiErrorCode,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiError';
    this.retryable = code === 'rate-limit' || code === 'network' || code === 'server' || code === 'timeout';
  }

  /** 面向用户的中文提示 */
  toUserMessage(): string {
    switch (this.code) {
      case 'auth':
        return 'API 密钥无效或已过期，请执行「CommitCraft: 设置 API 密钥」重新填写';
      case 'rate-limit':
        return '触发了服务商的速率限制，请稍后重试';
      case 'timeout':
        return '请求超时，可在设置中调大 commitCraft.requestTimeoutMs，或减少暂存区变更量';
      case 'network':
        return `网络请求失败：${this.message}`;
      case 'server':
        return `模型服务返回 ${this.status ?? ''} 错误，稍后重试；若持续失败请检查网关地址`;
      case 'aborted':
        return '请求已取消';
      case 'bad-request':
        return `请求被拒绝：${this.detail || this.message}。请检查模型名称与参数是否符合该服务商要求`;
      case 'bad-response':
        return `模型返回内容无法解析：${this.message}`;
      default:
        return this.message;
    }
  }
}

export interface ProviderContext {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface ChatCallOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly requiresApiKey: boolean;
  chat(req: ChatRequest, ctx: ProviderContext, opts: ChatCallOptions): Promise<{ text: string }>;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
}
