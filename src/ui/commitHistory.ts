import * as vscode from 'vscode';

export interface HistoryEntry {
  /** 完整提交信息（含正文） */
  message: string;
  /** 生成时使用的模型 */
  model: string;
  /** 生成时间戳 */
  time: number;
  /** 仓库名（根目录 base name） */
  repoName: string;
  /** 分支 */
  branch: string;
}

const KEY = 'commitCraft.history.v1';
const MAX = 10;

/**
 * 最近生成的提交信息环形缓冲（最多 10 条）。
 *
 * 写入 SCM 输入框的成功结果入栈，重开仓库 / 切窗口后仍可找回；
 * 误清空输入框、或者想复用之前那条，运行「提交信息历史」即可。
 */
export class CommitHistory implements vscode.Disposable {
  constructor(private readonly memento: vscode.Memento) {}

  list(): HistoryEntry[] {
    const raw = this.memento.get<HistoryEntry[]>(KEY);
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.message === 'string') : [];
  }

  async push(entry: HistoryEntry): Promise<void> {
    const list = this.list();
    list.unshift(entry);
    if (list.length > MAX) {
      list.length = MAX;
    }
    await this.memento.update(KEY, list);
  }

  async removeAt(index: number): Promise<void> {
    const list = this.list();
    if (index < 0 || index >= list.length) {
      return;
    }
    list.splice(index, 1);
    await this.memento.update(KEY, list);
  }

  async clear(): Promise<void> {
    await this.memento.update(KEY, undefined);
  }

  dispose(): void {}
}
