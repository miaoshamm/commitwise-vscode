import * as vscode from 'vscode';
import { ReviewStore } from './reviewStore';
import { ReviewIssue } from '../domain/review/reviewIssue';

/**
 * 把 CommitCraft 标记的诊断变成可操作的 Quick Fix。
 *
 * 编辑器里出现波浪线 → 鼠标悬停看到问题 → 灯泡提供
 *   · 「CommitCraft: 应用建议 — {标题}」（命中时）
 *   · 「CommitCraft: 打开审查报告」
 * 两个动作，与报告面板的「应用建议」按钮共用同一条落地逻辑。
 */
export class ReviewCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly store: ReviewStore) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const review = this.store.get();
    if (!review) {
      return [];
    }

    const ccDiagnostics = context.diagnostics.filter((d) => d.source === 'CommitCraft');
    const relative = this.relativePath(document.uri, review.root);
    if (!relative) {
      return [];
    }

    const matches = this.matchIssues(review.issues, relative, range);
    const actions: vscode.CodeAction[] = [];

    for (const issue of matches) {
      if (!issue.suggestion || !issue.line) {
        continue;
      }
      const action = new vscode.CodeAction(
        `CommitCraft: 应用建议 — ${issue.title}`,
        vscode.CodeActionKind.QuickFix,
      );
      action.command = {
        command: 'commitCraft.applySuggestion',
        title: '应用建议',
        arguments: [issue.id],
      };
      action.diagnostics = ccDiagnostics;
      actions.push(action);
    }

    const openReport = new vscode.CodeAction('CommitCraft: 打开审查报告', vscode.CodeActionKind.QuickFix);
    openReport.command = { command: 'commitCraft.showReviewReport', title: '打开审查报告' };
    actions.push(openReport);

    return actions;
  }

  /** 规范化文档路径与仓库根的相对路径，处理大小写与斜杠差异 */
  private relativePath(uri: vscode.Uri, root: string): string | undefined {
    const rootUri = vscode.Uri.file(root);
    const rootPath = rootUri.path.replace(/\/$/, '');
    const docPath = uri.path;
    if (!docPath.toLowerCase().startsWith(rootPath.toLowerCase())) {
      return undefined;
    }
    return docPath.slice(rootPath.length).replace(/^\/+/, '');
  }

  /** 找到落在编辑器选区内、且带有建议的行级问题 */
  private matchIssues(issues: ReviewIssue[], relative: string, range: vscode.Range | vscode.Selection): ReviewIssue[] {
    return issues.filter(
      (i) =>
        i.file === relative &&
        typeof i.line === 'number' &&
        i.line - 1 >= range.start.line &&
        i.line - 1 <= range.end.line,
    );
  }
}
