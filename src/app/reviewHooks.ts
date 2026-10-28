import * as vscode from 'vscode';
import { reviewToMarkdown } from '../domain/review/reviewMarkdown';
import { applySuggestionToWorkspace } from '../ui/reviewSuggestionApply';
import { ReviewPanelHooks } from '../ui/reviewPanel';
import { AppDeps } from './context';

/**
 * Webview 报告上四个按钮的回调。
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
    onApply: async (issueId) => {
      const review = deps.review.get();
      if (!review) {
        return 'failed' as const;
      }
      const issue = review.issues.find((i) => i.id === issueId);
      if (!issue) {
        return 'failed' as const;
      }
      return applySuggestionToWorkspace(review.root, issue, deps.logger);
    },
    // 面板订阅运行状态：审查开始时显示横幅并禁用 rerun，结束时自动恢复
    subscribeRunning: (cb) =>
      deps.review.onDidChange(() => {
        cb(deps.review.isRunning());
      }),
  };
}
