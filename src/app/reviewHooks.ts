import * as vscode from 'vscode';
import { reviewToMarkdown } from '../domain/review/reviewMarkdown';
import { ReviewPanelHooks } from '../ui/reviewPanel';
import { AppDeps } from './context';

/**
 * Webview 报告上三个按钮的回调。
 *
 * 单独成文件是因为 reviewStaged（产出结果）和 commands（用户主动打开报告）
 * 都要用它，放在任一方向都会造成循环依赖。
 */
export function reviewPanelHooks(deps: AppDeps): ReviewPanelHooks {
  return {
    onCopy: async (review) => {
      await vscode.env.clipboard.writeText(reviewToMarkdown(review));
    },
    onRerun: async () => {
      await vscode.commands.executeCommand('commitCraft.reviewStagedChanges');
    },
    onShowTree: async () => {
      await vscode.commands.executeCommand('commitCraft.revealReviewView');
    },
  };
}
