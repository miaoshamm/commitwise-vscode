import * as vscode from 'vscode';
import { AppDeps } from '../app/context';
import { reviewPanelHooks } from '../app/reviewHooks';
import { reviewToMarkdown } from '../domain/review/reviewMarkdown';
import { gotoIssue, ReviewPanel } from '../ui/reviewPanel';
import { REVIEW_VIEW_ID } from '../ui/reviewTreeProvider';

/** 打开（或聚焦）详细报告面板。没有结果时引导用户先跑一次审查 */
export async function showReviewReport(deps: AppDeps): Promise<void> {
  const review = deps.review.get();
  if (!review) {
    const action = await vscode.window.showInformationMessage('还没有审查结果。', '审查暂存区代码');
    if (action === '审查暂存区代码') {
      await vscode.commands.executeCommand('commitCraft.reviewStagedChanges');
    }
    return;
  }
  ReviewPanel.show(review, reviewPanelHooks(deps));
}

/** 聚焦侧边栏的问题清单 */
export async function revealReviewView(): Promise<void> {
  await vscode.commands.executeCommand(`${REVIEW_VIEW_ID}.focus`);
}

export async function copyReviewMarkdown(deps: AppDeps): Promise<void> {
  const review = deps.review.get();
  if (!review) {
    void vscode.window.showInformationMessage('还没有审查结果可复制。');
    return;
  }
  await vscode.env.clipboard.writeText(reviewToMarkdown(review));
  const action = await vscode.window.showInformationMessage('审查报告已复制为 Markdown。', '打开报告');
  if (action === '打开报告') {
    ReviewPanel.show(review, reviewPanelHooks(deps));
  }
}

export async function clearReview(deps: AppDeps): Promise<void> {
  if (!deps.review.get()) {
    void vscode.window.showInformationMessage('当前没有审查结果。');
    return;
  }
  await deps.review.clear();
  deps.diagnostics.clear();
  ReviewPanel.disposeAll();
  deps.statusBar.setReviewTotal(undefined);
  deps.statusBar.idle();
  void vscode.window.showInformationMessage('已清空审查结果、报告面板与编辑器标记。');
}

/** 侧边栏 / 报告里点击问题条目时跳转 */
export async function openIssueAt(args: { root: string; file: string; line?: number }): Promise<void> {
  if (!args || !args.root || !args.file) {
    return;
  }
  await gotoIssue(args);
}
