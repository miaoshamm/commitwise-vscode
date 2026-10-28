import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { maybeShowOnboarding, syncReviewContext, syncStatusBar } from './app/statusSync';
import { createDeps } from './container';
import { ReviewPanel } from './ui/reviewPanel';
import { ReviewCodeActionProvider } from './ui/reviewCodeActionProvider';
import { SettingsPanel } from './ui/settingsPanel';
import { REVIEW_VIEW_ID } from './ui/reviewTreeProvider';

let deps: ReturnType<typeof createDeps> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const created = createDeps(context);
  deps = created;

  context.subscriptions.push(created.logger, created.statusBar, created.diagnostics, created.review, created.reviewView, created.history);

  // 侧边栏问题清单：审查结果的主入口
  const treeView = vscode.window.createTreeView(REVIEW_VIEW_ID, {
    treeDataProvider: created.reviewView,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  const syncView = () => {
    const info = created.reviewView.describe();
    treeView.description = info.description;
    treeView.message = info.message;
    void syncReviewContext(created);
  };
  syncView();
  context.subscriptions.push(created.review.onDidChange(() => syncView()));

  registerCommands(context, created);

  // 编辑器灯泡：审查诊断上的「应用建议」Quick Fix 与「打开报告」
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new ReviewCodeActionProvider(created.review),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  void vscode.commands.executeCommand('setContext', 'commitCraft.requesting', false);
  void vscode.commands.executeCommand('setContext', 'commitCraft.hasDraftBackup', false);

  syncStatusBar(created);
  created.statusBar.idle();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('commitCraft')) {
        created.logger.info('配置已更新');
        syncStatusBar(created);
        created.statusBar.idle();
      }
    }),
  );

  created.logger.info(`CommitCraft 已激活（VSCode ${vscode.version}）`);

  // 首次使用引导（只弹一次）；失败不影响激活
  void maybeShowOnboarding(created, context.globalState).catch((err) => {
    created.logger.warn(`引导提示失败：${(err as Error)?.message ?? err}`);
  });
}

export function deactivate(): void {
  ReviewPanel.disposeAll();
  SettingsPanel.disposeAll();
  deps = undefined;
}
