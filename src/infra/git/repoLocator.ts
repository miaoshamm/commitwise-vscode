import * as vscode from 'vscode';
import { findRepoRoot } from './diffCollector';
import { GitRunner } from './gitRunner';

interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  repositories: GitRepository[];
}

interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  state: { HEAD?: { name?: string } };
}

export interface RepoHandle {
  root: string;
  /** 是否拿到了 SCM 输入框（决定生成结果能直接写入还是只能复制） */
  hasInputBox: boolean;
  getDraft(): string;
  setDraft(value: string): void;
}

async function getGitAPI(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports?.getAPI(1);
  } catch {
    return undefined;
  }
}

/**
 * 定位要操作的仓库：
 * 1. 优先使用内置 Git 扩展的仓库列表（可拿到 SCM 输入框，生成结果能直接写入）
 * 2. Git 扩展不可用时，退回 CLI 探测工作区目录
 * 3. 多个仓库时让用户选择
 */
export async function pickRepository(runner: GitRunner): Promise<RepoHandle | undefined> {
  const api = await getGitAPI();
  const repos = api?.repositories ?? [];

  if (repos.length === 1) {
    return wrap(repos[0]);
  }

  if (repos.length > 1) {
    const picked = await vscode.window.showQuickPick(
      repos.map((r) => ({
        label: `$(repo) ${vscode.workspace.asRelativePath(r.rootUri)}`,
        description: r.state.HEAD?.name ?? '',
        repo: r,
      })),
      { placeHolder: '选择要操作的 Git 仓库' },
    );
    return picked ? wrap(picked.repo) : undefined;
  }

  // 退回 CLI
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    const root = await findRepoRoot(runner, folder.uri.fsPath);
    if (root) {
      return {
        root,
        hasInputBox: false,
        getDraft: () => '',
        setDraft: () => undefined,
      };
    }
  }

  return undefined;
}

function wrap(repo: GitRepository): RepoHandle {
  return {
    root: repo.rootUri.fsPath,
    hasInputBox: true,
    getDraft: () => repo.inputBox.value ?? '',
    setDraft: (value: string) => {
      repo.inputBox.value = value;
    },
  };
}
