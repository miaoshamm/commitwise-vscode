import * as vscode from 'vscode';
import { AppDeps, handleError } from '../app/context';
import { pickRepository, RepoHandle } from '../infra/git/repoLocator';

interface HistoryItem extends vscode.QuickPickItem {
  index: number;
  message: string;
}

/**
 * 提交信息历史：环形保留最近 10 条，写回 / 复制 / 单条删除。
 *
 * 入口是「CommitCraft: 提交信息历史」命令。
 * 选某条 → 写回源代码管理输入框（与生成走同一条路径，会备份当前草稿）。
 * 点右侧垃圾桶 → 删除该条并刷新列表（不退出面板）。
 */
export async function showHistory(deps: AppDeps): Promise<void> {
  const buildItems = (): HistoryItem[] => {
    const list = deps.history.list();
    return list.map((e, idx) => ({
      label: ((e.message.split('\n')[0] || '(空)').slice(0, 60)) || '(空)',
      description: `${e.repoName} · ${e.branch}`,
      detail: `${new Date(e.time).toLocaleString('zh-CN', { hour12: false })} · ${e.model}`,
      index: idx,
      message: e.message,
      buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: '删除该条' }],
    }));
  };

  const list = deps.history.list();
  if (list.length === 0) {
    void vscode.window.showInformationMessage('还没有生成过的提交信息历史。');
    return;
  }

  const qp = vscode.window.createQuickPick<HistoryItem>();
  qp.title = 'CommitCraft · 提交信息历史';
  qp.placeholder = '选择一条写回源代码管理输入框；点右侧垃圾桶删除';
  qp.matchOnDetail = true;
  qp.items = buildItems();

  const picked = await new Promise<HistoryItem | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
    });
    qp.onDidTriggerItemButton(async (e) => {
      const item = e.item as HistoryItem;
      await deps.history.removeAt(item.index);
      // 删完后列表整体重排（索引会变），重画 items
      const next = buildItems();
      qp.items = next;
      if (next.length === 0) {
        qp.hide();
        void vscode.window.showInformationMessage('历史已清空。');
      }
    });
    qp.show();
  });
  qp.dispose();

  if (!picked) {
    return;
  }

  let repo: RepoHandle | undefined;
  try {
    repo = await pickRepository(deps.runner);
  } catch (err) {
    handleError(deps, err);
    return;
  }
  if (!repo) {
    deps.statusBar.idle();
    void vscode.window.showWarningMessage('没有找到 Git 仓库。');
    return;
  }

  const outcome = deps.inputBridge.write(repo, picked.message);
  deps.statusBar.succeeded(outcome === 'input-box' ? '已写入输入框' : '已复制');
  if (outcome === 'input-box') {
    void vscode.window.showInformationMessage(`已写回历史提交信息（${picked.label}）`, '恢复原草稿');
  } else {
    void vscode.window.showInformationMessage('当前仓库未提供 SCM 输入框，提交信息已复制到剪贴板。');
  }
}
