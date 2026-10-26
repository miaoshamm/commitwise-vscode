import { describe, expect, it } from 'vitest';
import { ReviewReportSource, reviewToMarkdown } from '../src/domain/review/reviewMarkdown';

function makeSource(over: Partial<ReviewReportSource> = {}): ReviewReportSource {
  return {
    savedAt: new Date('2026-10-24T11:00:00').getTime(),
    repoName: 'demo',
    branch: 'feat/x',
    providerLabel: 'DeepSeek',
    model: 'deepseek-chat',
    elapsedMs: 4200,
    summary: '新增了一处导出，存在硬编码令牌。',
    issues: [],
    byFile: [],
    counts: { high: 0, medium: 0, low: 0 },
    notices: [],
    truncated: false,
    totalBeforeLimit: 0,
    ...over,
  };
}

describe('reviewToMarkdown', () => {
  it('包含抬头信息与统计', () => {
    const md = reviewToMarkdown(makeSource({ counts: { high: 1, medium: 2, low: 0 } }));
    expect(md).toContain('# CommitCraft 代码审查报告');
    expect(md).toContain('demo（feat/x）');
    expect(md).toContain('DeepSeek / deepseek-chat');
    expect(md).toContain('共 3 条（高 1 / 中 2 / 低 0）');
    expect(md).toContain('新增了一处导出');
  });

  it('按文件分组输出问题、行号、建议代码块', () => {
    const md = reviewToMarkdown(
      makeSource({
        issues: [
          {
            id: 'i1',
            file: 'src/a.ts',
            line: 12,
            severity: 'high',
            category: 'security',
            title: '硬编码密钥',
            detail: '会随仓库泄露',
            suggestion: 'const k = process.env.K',
            anchor: 'line',
          },
          {
            id: 'i2',
            file: 'src/a.ts',
            severity: 'low',
            category: 'style',
            title: '命名不规范',
            detail: '',
            anchor: 'file',
          },
        ],
        byFile: [
          {
            file: 'src/a.ts',
            issues: [
              {
                id: 'i1',
                file: 'src/a.ts',
                line: 12,
                severity: 'high',
                category: 'security',
                title: '硬编码密钥',
                detail: '会随仓库泄露',
                suggestion: 'const k = process.env.K',
                anchor: 'line',
              },
              {
                id: 'i2',
                file: 'src/a.ts',
                severity: 'low',
                category: 'style',
                title: '命名不规范',
                detail: '',
                anchor: 'file',
              },
            ],
          },
        ],
        counts: { high: 1, medium: 0, low: 1 },
      }),
    );
    expect(md).toContain('### src/a.ts');
    expect(md).toContain('[高][安全] 硬编码密钥**（第 12 行）');
    expect(md).toContain('```');
    expect(md).toContain('const k = process.env.K');
    // 文件级问题标注为「文件级」而不是编造行号
    expect(md).toContain('[低][风格] 命名不规范**（文件级）');
  });

  it('无问题时给出明确结论', () => {
    const md = reviewToMarkdown(makeSource());
    expect(md).toContain('未发现需要处理的问题。');
    expect(md).not.toContain('## 问题清单');
  });

  it('列出审查说明与截断提示', () => {
    const issue = {
      id: 'i1',
      file: 'src/a.ts',
      line: 3,
      severity: 'high' as const,
      category: 'bug' as const,
      title: '空指针',
      detail: '',
      anchor: 'line' as const,
    };
    const md = reviewToMarkdown(
      makeSource({
        notices: ['1 条问题指向未知文件，已忽略'],
        truncated: true,
        totalBeforeLimit: 40,
        issues: [issue],
        byFile: [{ file: 'src/a.ts', issues: [issue] }],
        counts: { high: 1, medium: 0, low: 0 },
      }),
    );
    expect(md).toContain('## 审查说明');
    expect(md).toContain('1 条问题指向未知文件，已忽略');
    expect(md).toContain('共 40 条问题，此处仅列出前 1 条');
  });
});
