import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/domain/diff/diffModel';
import { mapIssuesToDiff } from '../src/domain/review/issueMapper';
import {
  extractJson,
  normalizeCategory,
  normalizeLine,
  normalizeSeverity,
  parseReviewResponse,
  ReviewIssue,
} from '../src/domain/review/reviewIssue';
import { RENAME_PATCH, SINGLE_FILE_PATCH } from './fixtures';

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  id: 'i',
  file: 'src/a.ts',
  line: 3,
  severity: 'high',
  category: 'bug',
  title: '问题',
  detail: '',
  anchor: 'line',
  ...over,
});

describe('extractJson', () => {
  it('直接解析纯 JSON', () => {
    const r = extractJson('{"a":1}');
    expect(r.value).toEqual({ a: 1 });
    expect(r.repaired).toBe(false);
  });

  it('剥掉 Markdown 代码块', () => {
    const r = extractJson('```json\n{"a":1}\n```');
    expect(r.value).toEqual({ a: 1 });
    expect(r.repaired).toBe(true);
  });

  it('从解释文字中截取 JSON', () => {
    const r = extractJson('好的，结果如下：\n{"summary":"x","issues":[]}\n希望有帮助。');
    expect((r.value as { summary: string }).summary).toBe('x');
  });

  it('修复尾随逗号', () => {
    const r = extractJson('{"issues":[{"a":1},]}');
    expect(r.value).toBeDefined();
  });

  it('完全无法解析时返回错误', () => {
    const r = extractJson('这不是 JSON');
    expect(r.value).toBeUndefined();
    expect(r.error).toBeTruthy();
  });
});

describe('normalize', () => {
  it('严重级别名归一', () => {
    expect(normalizeSeverity('Critical')).toBe('high');
    expect(normalizeSeverity('warning')).toBe('medium');
    expect(normalizeSeverity('nit')).toBe('low');
    expect(normalizeSeverity(undefined)).toBe('medium');
  });

  it('类别别名归一', () => {
    expect(normalizeCategory('correctness')).toBe('bug');
    expect(normalizeCategory('vuln')).toBe('security');
    expect(normalizeCategory('weird')).toBe('maintainability');
  });

  it('行号容错', () => {
    expect(normalizeLine(42)).toBe(42);
    expect(normalizeLine('L42')).toBe(42);
    expect(normalizeLine(0)).toBeUndefined();
    expect(normalizeLine(undefined)).toBeUndefined();
  });
});

describe('parseReviewResponse', () => {
  it('整形规范条目', () => {
    const raw = JSON.stringify({
      summary: '整体还行',
      issues: [
        {
          file: './src/a.ts',
          line: 3,
          severity: 'Critical',
          category: 'correctness',
          title: '空指针',
          detail: '可能为 null',
          suggestion: '加判空',
        },
      ],
    });
    const out = parseReviewResponse(raw);
    expect(out.result?.summary).toBe('整体还行');
    expect(out.result?.issues[0]).toMatchObject({
      file: 'src/a.ts',
      line: 3,
      severity: 'high',
      category: 'bug',
      anchor: 'line',
    });
  });

  it('丢弃缺字段的条目并计数', () => {
    const raw = JSON.stringify({ issues: [{ file: 'a.ts' }, { title: '没有文件' }, { file: 'b.ts', title: 'ok' }] });
    const out = parseReviewResponse(raw);
    expect(out.result?.issues).toHaveLength(1);
    expect(out.dropped).toBe(2);
  });

  it('容忍直接返回数组', () => {
    const out = parseReviewResponse('[{"file":"src/a.ts","title":"x"}]');
    expect(out.result?.issues).toHaveLength(1);
  });

  it('无 issues 字段视为空', () => {
    const out = parseReviewResponse('{"summary":"很干净"}');
    expect(out.result?.issues).toEqual([]);
  });
});

describe('mapIssuesToDiff', () => {
  const files = parseDiff(SINGLE_FILE_PATCH);
  const opts = { minSeverity: 'low' as const, maxIssues: 30 };

  it('行号落在新增行则精确定位', () => {
    const mapped = mapIssuesToDiff({ summary: '', issues: [issue({ line: 3 })] }, files, 0, opts);
    expect(mapped.issues[0].anchor).toBe('line');
    expect(mapped.issues[0].line).toBe(3);
  });

  it('行号不在新增行则降级为文件级', () => {
    const mapped = mapIssuesToDiff({ summary: '', issues: [issue({ line: 2 })] }, files, 0, opts);
    expect(mapped.issues[0].anchor).toBe('file');
    expect(mapped.issues[0].line).toBeUndefined();
    expect(mapped.dropped.outOfRange).toBe(1);
  });

  it('文件不在暂存区则丢弃', () => {
    const mapped = mapIssuesToDiff({ summary: '', issues: [issue({ file: 'src/ghost.ts' })] }, files, 0, opts);
    expect(mapped.issues).toHaveLength(0);
    expect(mapped.dropped.unknownFile).toBe(1);
  });

  it('按后缀容错匹配路径', () => {
    const mapped = mapIssuesToDiff({ summary: '', issues: [issue({ file: 'a.ts', line: 3 })] }, files, 0, opts);
    expect(mapped.issues).toHaveLength(1);
    expect(mapped.issues[0].file).toBe('src/a.ts');
  });

  it('重命名文件可用旧路径命中', () => {
    const renameFiles = parseDiff(RENAME_PATCH);
    const mapped = mapIssuesToDiff({ summary: '', issues: [issue({ file: 'src/old.ts', line: 1 })] }, renameFiles, 0, opts);
    expect(mapped.issues[0].file).toBe('src/utils/renamed.ts');
  });

  it('按最低级别过滤', () => {
    const mapped = mapIssuesToDiff(
      { summary: '', issues: [issue({ severity: 'high' }), issue({ severity: 'low', line: 1 })] },
      files,
      0,
      { minSeverity: 'high', maxIssues: 30 },
    );
    expect(mapped.issues).toHaveLength(1);
    expect(mapped.counts).toEqual({ high: 1, medium: 0, low: 0 });
  });

  it('超过上限时截断并标记', () => {
    const many = Array.from({ length: 10 }, (_, i) => issue({ id: `i${i}`, line: i % 2 === 0 ? 1 : 3 }));
    const mapped = mapIssuesToDiff({ summary: '', issues: many }, files, 0, { minSeverity: 'low', maxIssues: 4 });
    expect(mapped.issues).toHaveLength(4);
    expect(mapped.truncated).toBe(true);
    expect(mapped.totalBeforeLimit).toBe(10);
  });

  it('按文件分组且按级别排序', () => {
    const mapped = mapIssuesToDiff(
      {
        summary: 's',
        issues: [issue({ severity: 'low', line: 1 }), issue({ severity: 'high', line: 3 })],
      },
      files,
      0,
      opts,
    );
    expect(mapped.issues[0].severity).toBe('high');
    expect(mapped.byFile).toHaveLength(1);
    expect(mapped.byFile[0].file).toBe('src/a.ts');
    expect(mapped.byFile[0].issues).toHaveLength(2);
  });
});
