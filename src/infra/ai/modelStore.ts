import * as vscode from 'vscode';
import { listModels, ModelInfo, supportsModelList } from './modelCatalog';

export interface CachedModels {
  provider: string;
  baseUrl: string;
  fetchedAt: number;
  models: ModelInfo[];
}

const KEY = 'commitCraft.modelCache.v1';
/** 超过这个时间认为是「旧数据」，下次选择模型时静默刷新一次 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function norm(url: string): string {
  return (url ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

export interface FetchModelsOptions {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 模型列表缓存。
 *
 * 存在 globalState 里而不是 settings.json：这是可再生的探测结果，
 * 不该出现在用户的配置文件里，更不该随 Settings Sync 扩散。
 */
export class ModelStore implements vscode.Disposable {
  private cache: CachedModels | undefined;

  constructor(private readonly memento: vscode.Memento) {
    this.cache = memento.get<CachedModels>(KEY);
  }

  /** 命中缓存返回模型列表（不检查是否过期，过期由 needsRefresh 判断） */
  get(provider: string, baseUrl: string): ModelInfo[] | undefined {
    const c = this.cache;
    if (!c || c.provider !== provider || norm(c.baseUrl) !== norm(baseUrl)) {
      return undefined;
    }
    return c.models;
  }

  /** 缓存是否需要在后台刷新 */
  needsRefresh(provider: string, baseUrl: string): boolean {
    const c = this.cache;
    if (!c || c.provider !== provider || norm(c.baseUrl) !== norm(baseUrl)) {
      return true;
    }
    return Date.now() - c.fetchedAt > CACHE_TTL_MS;
  }

  get fetchedAt(): number | undefined {
    return this.cache?.fetchedAt;
  }

  /** 真正发起请求并写缓存；失败时抛 AiError，不写缓存 */
  async fetch(opts: FetchModelsOptions): Promise<ModelInfo[]> {
    if (!supportsModelList(opts.provider)) {
      return listModels(opts);
    }
    const models = await listModels(opts);
    this.cache = {
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      fetchedAt: Date.now(),
      models,
    };
    await this.memento.update(KEY, this.cache);
    return models;
  }

  async clear(): Promise<void> {
    this.cache = undefined;
    await this.memento.update(KEY, undefined);
  }

  dispose(): void {
    // 无资源需要释放，保留接口一致性
  }
}
