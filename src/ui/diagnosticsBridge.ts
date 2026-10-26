import * as vscode from 'vscode';
import { ReviewIssue, Severity } from '../domain/review/reviewIssue';

const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  high: vscode.DiagnosticSeverity.Warning,
  medium: vscode.DiagnosticSeverity.Information,
  low: vscode.DiagnosticSeverity.Hint,
};

/**
 * 把审查问题落到编辑器里。
 *
 * 只处理能精确到新增行的条目——文件级问题没有可靠的行号，
 * 随便挑一行打波浪线会误导用户。
 */
export class DiagnosticsBridge implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('commitCraft');

  apply(root: string, issues: ReviewIssue[]): number {
    this.collection.clear();
    const rootUri = vscode.Uri.file(root);
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const issue of issues) {
      if (issue.anchor !== 'line' || typeof issue.line !== 'number') {
        continue;
      }
      const uri = vscode.Uri.joinPath(rootUri, issue.file);
      const key = uri.toString();
      const lineIndex = Math.max(0, issue.line - 1);

      const message = issue.detail ? `${issue.title}\n\n${issue.detail}` : issue.title;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER),
        message,
        SEVERITY_MAP[issue.severity],
      );
      diagnostic.source = 'CommitCraft';
      diagnostic.code = `${issue.severity}/${issue.category}`;

      const arr = byFile.get(key) ?? [];
      arr.push(diagnostic);
      byFile.set(key, arr);
    }

    for (const [key, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.parse(key), diagnostics);
    }
    return byFile.size;
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
