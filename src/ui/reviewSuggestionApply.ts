import * as vscode from 'vscode';
import { ReviewIssue } from '../domain/review/reviewIssue';
import { Logger } from '../infra/log/logger';

export type ApplyOutcome = 'applied' | 'cancelled' | 'failed' | 'skipped';

/**
 * 把模型的审查建议应用到对应代码行。
 *
 * 用户在报告面板或编辑器 Quick Fix 上触发，统一走这条入口：
 *   1. 打开文件（只读，不抢焦点）→  2. 计算目标行范围 →
 *   3. 弹确认预览（替换整行 / 在下方插入 / 取消）→  4. WorkspaceEdit 落地，进入撤销栈。
 *
 * 绝不静默改写：模型建议与实际代码可能错位，必须先预览。
 * 文件级问题（无行号）不在此处理，由调用方过滤。
 */
export async function applySuggestionToWorkspace(
  root: string,
  issue: ReviewIssue,
  logger: Logger,
): Promise<ApplyOutcome> {
  if (!issue.line || !issue.suggestion) {
    return 'skipped';
  }

  const uri = vscode.Uri.joinPath(vscode.Uri.file(root), issue.file);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showWarningMessage(`无法打开文件：${issue.file}（可能已被移动或删除）`);
    return 'failed';
  }

  // 行号越界时落到最后一行，避免编辑失败
  const lineIdx = Math.min(Math.max(0, issue.line - 1), Math.max(0, doc.lineCount - 1));
  const target = doc.lineAt(lineIdx);

  const preview = issue.suggestion.length > 240
    ? issue.suggestion.slice(0, 240) + '…'
    : issue.suggestion;
  const action = await vscode.window.showInformationMessage(
    `CommitCraft 建议修复「${issue.file}:${issue.line}」\n\n原行：${target.text}\n\n建议：\n${preview}`,
    { modal: true },
    '替换该行',
    '在下方插入',
  );
  if (action !== '替换该行' && action !== '在下方插入') {
    return 'cancelled';
  }

  const edit = new vscode.WorkspaceEdit();
  if (action === '替换该行') {
    edit.replace(uri, target.range, issue.suggestion);
  } else if (lineIdx + 1 < doc.lineCount) {
    // 在目标行下方插入新行（保留缩进层级不容易，保持建议原样 + 换行）
    edit.insert(uri, new vscode.Position(lineIdx + 1, 0), `${issue.suggestion}\n`);
  } else {
    // 已经是最后一行，追加到文件末尾
    const endLine = doc.lineAt(doc.lineCount - 1);
    edit.insert(uri, endLine.range.end, `\n${issue.suggestion}`);
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    logger.error(`应用建议失败：WorkspaceEdit 被拒绝（${issue.file}:${issue.line}）`);
    void vscode.window.showErrorMessage('应用建议失败，编辑未被写入。');
    return 'failed';
  }

  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(target.range.start, target.range.start),
    viewColumn: vscode.ViewColumn.One,
  });
  logger.info(`已应用审查建议：${issue.file}:${issue.line}（${action}）`);
  return 'applied';
}
