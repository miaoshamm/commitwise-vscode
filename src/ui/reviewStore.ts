import * as vscode from 'vscode';
import { ReviewReportSource } from '../domain/review/reviewMarkdown';
import { Severity } from '../domain/review/reviewIssue';

export interface StoredReview extends ReviewReportSource {
  /** 仓库根目录绝对路径 */
  root: string;
}

const KEY = 'commitCraft.lastReview.v1';

export function totalOf(counts: Record<Severity, number>): number {
  return counts.high + counts.medium + counts.low;
}

/**
 * 审查结果的唯一存放点。
 *
 * 之所以要落盘到 workspaceState：Webview 面板关掉就没了，
 * 而用户经常是「审核完先去改代码，回头再对一遍清单」。
 * 侧边栏视图、详细报告、状态栏、复制的 Markdown 全部读这一份数据。
 */
export class ReviewStore implements vscode.Disposable {
  private current: StoredReview | undefined;
  private readonly emitter = new vscode.EventEmitter<StoredReview | undefined>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {
    const stored = memento.get<StoredReview>(KEY);
    this.current = stored && Array.isArray(stored.issues) ? stored : undefined;
  }

  get(): StoredReview | undefined {
    return this.current;
  }

  async save(review: StoredReview): Promise<void> {
    this.current = review;
    await this.memento.update(KEY, review);
    this.emitter.fire(this.current);
  }

  async clear(): Promise<void> {
    this.current = undefined;
    await this.memento.update(KEY, undefined);
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
