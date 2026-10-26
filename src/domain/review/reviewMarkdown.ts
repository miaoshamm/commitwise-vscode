import { ReviewIssue, Severity } from './reviewIssue';

export interface ReviewReportSource {
  savedAt: number;
  repoName: string;
  branch: string;
  providerLabel: string;
  model: string;
  elapsedMs: number;
  summary: string;
  issues: ReviewIssue[];
  byFile: Array<{ file: string; issues: ReviewIssue[] }>;
  counts: Record<Severity, number>;
  notices: string[];
  truncated: boolean;
  totalBeforeLimit: number;
}

const SEVERITY_LABEL: Record<Severity, string> = { high: '高', medium: '中', low: '低' };

const CATEGORY_LABEL: Record<string, string> = {
  bug: '缺陷',
  security: '安全',
  performance: '性能',
  style: '风格',
  maintainability: '可维护性',
  test: '测试',
  compat: '兼容性',
};

function stamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把审查结果导出为 Markdown，便于贴到 PR / 群里 / 记录到文档。
 * 纯函数，可单测。
 */
export function reviewToMarkdown(src: ReviewReportSource): string {
  const total = src.counts.high + src.counts.medium + src.counts.low;
  const lines: string[] = [];

  lines.push(`# CommitCraft 代码审查报告`, '');
  lines.push(`- 仓库：${src.repoName}（${src.branch}）`);
  lines.push(`- 模型：${src.providerLabel} / ${src.model}`);
  lines.push(`- 时间：${stamp(src.savedAt)} · 用时 ${(src.elapsedMs / 1000).toFixed(1)}s`);
  lines.push(`- 结果：共 ${total} 条（高 ${src.counts.high} / 中 ${src.counts.medium} / 低 ${src.counts.low}）`, '');

  if (src.summary) {
    lines.push('## 摘要', '', src.summary, '');
  }

  if (src.notices.length > 0) {
    lines.push('## 审查说明', '');
    for (const n of src.notices) {
      lines.push(`- ${n}`);
    }
    lines.push('');
  }

  if (src.issues.length === 0) {
    lines.push('未发现需要处理的问题。');
    return lines.join('\n');
  }

  if (src.truncated) {
    lines.push(`> 共 ${src.totalBeforeLimit} 条问题，此处仅列出前 ${src.issues.length} 条。`, '');
  }

  lines.push('## 问题清单', '');
  for (const group of src.byFile) {
    lines.push(`### ${group.file}`, '');
    for (const issue of group.issues) {
      const loc = issue.line ? `第 ${issue.line} 行` : '文件级';
      lines.push(`- **[${SEVERITY_LABEL[issue.severity]}][${CATEGORY_LABEL[issue.category] ?? issue.category}] ${issue.title}**（${loc}）`);
      if (issue.detail) {
        lines.push(`  ${issue.detail}`);
      }
      if (issue.suggestion) {
        lines.push('', '  ```', ...issue.suggestion.split('\n').map((l) => `  ${l}`), '  ```');
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
