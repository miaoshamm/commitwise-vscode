import * as vscode from 'vscode';
import { RepoHandle } from '../infra/git/repoLocator';

export type WriteOutcome = 'input-box' | 'clipboard';

/**
 * 写入 SCM 输入框。
 *
 * `inputBox.value = text` 不支持撤销，所以写入前必须自己备份原草稿，
 * 否则用户手写了一半的提交信息会被无声覆盖。
 */
export class ScmInputBridge {
  private readonly backups = new Map<string, string>();
  private lastRoot: string | undefined;

  constructor(private readonly onBackupChange: (hasBackup: boolean) => void) {}

  write(repo: RepoHandle, message: string): WriteOutcome {
    const previous = repo.getDraft();
    this.backups.set(repo.root, previous);
    this.lastRoot = repo.root;
    this.onBackupChange(true);

    if (repo.hasInputBox) {
      repo.setDraft(message);
      return 'input-box';
    }

    void vscode.env.clipboard.writeText(message);
    return 'clipboard';
  }

  hasBackup(root?: string): boolean {
    if (root) {
      return this.backups.has(root);
    }
    return this.backups.size > 0;
  }

  /** 恢复上一次被覆盖的草稿，返回恢复的仓库根目录 */
  restore(repo: RepoHandle): string | undefined {
    const previous = this.backups.get(repo.root);
    if (previous === undefined) {
      return undefined;
    }
    if (repo.hasInputBox) {
      repo.setDraft(previous);
    } else {
      void vscode.env.clipboard.writeText(previous);
    }
    this.backups.delete(repo.root);
    if (this.backups.size === 0) {
      this.onBackupChange(false);
    }
    return repo.root;
  }

  peek(): { root: string; value: string } | undefined {
    if (!this.lastRoot) {
      return undefined;
    }
    const value = this.backups.get(this.lastRoot);
    return value === undefined ? undefined : { root: this.lastRoot, value };
  }
}
