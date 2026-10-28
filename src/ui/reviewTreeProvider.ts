import * as vscode from 'vscode';
import { Category, ReviewIssue, Severity, SEVERITY_ORDER } from '../domain/review/reviewIssue';
import { ReviewStore, StoredReview, totalOf } from './reviewStore';

export const REVIEW_VIEW_ID = 'commitCraft.reviewIssues';

const SEVERITY_LABEL: Record<Severity, string> = { high: '高', medium: '中', low: '低' };

const SEVERITY_ICON: Record<Severity, { id: string; color: string }> = {
  high: { id: 'error', color: 'errorForeground' },
  medium: { id: 'warning', color: 'editorWarning.foreground' },
  low: { id: 'info', color: 'descriptionForeground' },
};

const CATEGORY_LABEL: Record<Category, string> = {
  bug: '缺陷',
  security: '安全',
  performance: '性能',
  style: '风格',
  maintainability: '可维护性',
  test: '测试',
  compat: '兼容性',
};

export type ReviewTreeNode =
  | { kind: 'file'; file: string; issues: ReviewIssue[] }
  | { kind: 'issue'; root: string; issue: ReviewIssue }
  | { kind: 'section'; id: string; label: string; description?: string }
  | { kind: 'note'; text: string }
  | { kind: 'empty'; label: string; description?: string };

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

function issueTooltip(issue: ReviewIssue): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown(`**${SEVERITY_LABEL[issue.severity]} · ${CATEGORY_LABEL[issue.category]}**\n\n`);
  md.appendMarkdown(`${issue.title}\n\n`);
  if (issue.detail) {
    md.appendMarkdown(`${issue.detail}\n\n`);
  }
  if (issue.suggestion) {
    md.appendMarkdown(`**建议**\n\n\`\`\`\n${issue.suggestion}\n\`\`\`\n`);
  }
  md.appendMarkdown(`\n位置：\`${issue.file}${issue.line ? ':' + issue.line : '（文件级）'}\``);
  return md;
}

/**
 * 侧边栏的审查问题清单。
 *
 * 这是「审查结果在哪里看」的主入口：不依赖 Webview 是否还开着，
 * 每次审查完自动刷新，点条目直接跳到对应行。
 */
export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReviewTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: ReviewStore) {
    this.subscription = store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getReview(): StoredReview | undefined {
    return this.store.get();
  }

  getTreeItem(node: ReviewTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'empty': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        item.contextValue = 'commitCraft.empty';
        return item;
      }
      case 'section': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'commitCraft.section';
        return item;
      }
      case 'note': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('dash');
        item.tooltip = node.text;
        return item;
      }
      case 'file': {
        const worst = node.issues.reduce<Severity>(
          (acc, i) => (SEVERITY_ORDER[i.severity] < SEVERITY_ORDER[acc] ? i.severity : acc),
          'low',
        );
        const item = new vscode.TreeItem(baseName(node.file), vscode.TreeItemCollapsibleState.Expanded);
        const dir = dirName(node.file);
        item.description = `${dir ? dir + '  ' : ''}${node.issues.length} 个问题`;
        item.tooltip = `${node.file}\n最严重：${SEVERITY_LABEL[worst]}`;
        item.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor(SEVERITY_ICON[worst].color));
        item.contextValue = 'commitCraft.file';
        return item;
      }
      case 'issue': {
        const issue = node.issue;
        const icon = SEVERITY_ICON[issue.severity];
        const item = new vscode.TreeItem(issue.title, vscode.TreeItemCollapsibleState.None);
        item.description = `${issue.line ? 'L' + issue.line : '文件级'} · ${CATEGORY_LABEL[issue.category]}`;
        item.tooltip = issueTooltip(issue);
        item.iconPath = new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color));
        item.contextValue = `commitCraft.issue.${issue.severity}`;
        item.command = {
          command: 'commitCraft.goToIssue',
          title: '跳转到问题所在行',
          arguments: [{ root: node.root, file: issue.file, line: issue.line }],
        };
        return item;
      }
    }
  }

  getChildren(element?: ReviewTreeNode): ReviewTreeNode[] {
    const review = this.store.get();

    if (!element) {
      if (!review) {
        return [];
      }
      if (totalOf(review.counts) === 0) {
        return [{ kind: 'empty', label: '未发现需要处理的问题', description: review.model }];
      }
      const files = review.byFile.map((group) => ({
        file: group.file,
        issues: group.issues,
      }));
      // 问题按级别从高到低排列文件，方便先看高危
      files.sort((a, b) => {
        const wa = a.issues[0]?.severity ?? 'low';
        const wb = b.issues[0]?.severity ?? 'low';
        return SEVERITY_ORDER[wa] - SEVERITY_ORDER[wb] || a.file.localeCompare(b.file);
      });
      const nodes: ReviewTreeNode[] = files.map((f) => ({ kind: 'file' as const, file: f.file, issues: f.issues }));
      if (review.notices.length > 0) {
        nodes.push({
          kind: 'section',
          id: 'notices',
          label: '审查说明',
          description: `${review.notices.length} 条`,
        });
      }
      return nodes;
    }

    if (element.kind === 'file') {
      return element.issues.map((issue) => ({ kind: 'issue' as const, root: review?.root ?? '', issue }));
    }
    if (element.kind === 'section') {
      return (review?.notices ?? []).map((text) => ({ kind: 'note' as const, text }));
    }
    return [];
  }

  /** 侧边栏视图标题右侧的统计文案 */
  describe(): { description?: string; message?: string; title?: string } {
    const review = this.store.get();
    if (!review) {
      // 没有历史结果时也可能正在跑第一次审查
      return { description: this.store.isRunning() ? '审查中…' : undefined };
    }
    if (this.store.isRunning()) {
      return { description: '审查中…', message: `${review.repoName} · ${review.branch}` };
    }
    const total = totalOf(review.counts);
    const time = new Date(review.savedAt).toLocaleTimeString('zh-CN', { hour12: false });
    return {
      description: total === 0 ? `无问题 · ${time}` : `${total} 个问题 · ${time}`,
      message: `${review.repoName} · ${review.branch}`,
      title: 'CommitCraft 审查问题',
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
