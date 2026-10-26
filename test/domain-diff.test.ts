import { describe, expect, it } from 'vitest';
import { addedLineNumbers, parseDiff, renderFilePatch } from '../src/domain/diff/diffModel';
import { globToRegExp, matchesAnyGlob } from '../src/domain/diff/glob';
import { prepareDiff, truncateFile } from '../src/domain/diff/prepareDiff';
import { redactSecrets } from '../src/domain/diff/redact';
import { charBudgetFor, checkBudget, estimateTokens } from '../src/domain/diff/tokenBudget';
import { MULTI_FILE_PATCH, RENAME_PATCH, SECRET_PATCH, SINGLE_FILE_PATCH, bigPatch } from './fixtures';

describe('parseDiff', () => {
  it('解析单文件修改，行号正确', () => {
    const files = parseDiff(SINGLE_FILE_PATCH);
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.path).toBe('src/a.ts');
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    expect(f.hunks).toHaveLength(1);
    expect([...addedLineNumbers(f)].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('识别新增文件、二进制文件与 lockfile', () => {
    const files = parseDiff(MULTI_FILE_PATCH);
    expect(files.map((f) => f.path)).toEqual(['src/new.ts', 'package-lock.json', 'assets/logo.png']);

    expect(files[0].status).toBe('added');
    expect([...addedLineNumbers(files[0])].sort((a, b) => a - b)).toEqual([1, 2]);

    expect(files[2].status).toBe('binary');
    expect(files[2].binary).toBe(true);
    expect(files[2].hunks).toHaveLength(0);
  });

  it('识别重命名并保留旧路径', () => {
    const [f] = parseDiff(RENAME_PATCH);
    expect(f.status).toBe('renamed');
    expect(f.path).toBe('src/utils/renamed.ts');
    expect(f.oldPath).toBe('src/old.ts');
  });

  it('渲染回补丁文本时可还原 hunk 头', () => {
    const [f] = parseDiff(SINGLE_FILE_PATCH);
    const rendered = renderFilePatch(f);
    expect(rendered).toContain('@@ -1,3 +1,4 @@');
    expect(rendered).toContain('-const a = 1;');
    expect(rendered).toContain('+const c = 4;');
  });

  it('空补丁返回空数组', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('glob 匹配', () => {
  it('无斜杠的模式匹配任意层级', () => {
    expect(matchesAnyGlob('package-lock.json', ['**/package-lock.json'])).toBe('**/package-lock.json');
    expect(matchesAnyGlob('packages/app/package-lock.json', ['**/package-lock.json'])).toBeDefined();
    expect(matchesAnyGlob('src/app.min.js', ['**/*.min.js'])).toBeDefined();
    expect(matchesAnyGlob('src/app.js', ['**/*.min.js'])).toBeUndefined();
  });

  it('** 可跨目录', () => {
    expect(globToRegExp('**/dist/**').test('dist/a/b.js')).toBe(true);
    expect(globToRegExp('**/dist/**').test('pkg/dist/a.js')).toBe(true);
    expect(globToRegExp('**/dist/**').test('src/dist.js')).toBe(false);
  });

  it('含斜杠的模式锚定完整路径', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/sub/a.ts')).toBe(false);
  });

  it('? 匹配单个非斜杠字符', () => {
    expect(globToRegExp('a?c.ts').test('abc.ts')).toBe(true);
    expect(globToRegExp('a?c.ts').test('ac.ts')).toBe(false);
  });
});

describe('prepareDiff', () => {
  const base = {
    excludeGlobs: ['**/package-lock.json', '**/dist/**'],
    maxFileChars: 20000,
    maxTotalChars: 48000,
    redactSecrets: true,
  };

  it('排除 lockfile 与二进制文件，但保留在文件清单中', () => {
    const files = parseDiff(MULTI_FILE_PATCH);
    const prepared = prepareDiff(files, base);

    expect(prepared.included.map((f) => f.path)).toEqual(['src/new.ts']);
    expect(prepared.patch).not.toContain('lockfileVersion');
    expect(prepared.fileList).toContain('package-lock.json');
    expect(prepared.fileList).toContain('已按规则排除');
    expect(prepared.fileList).toContain('assets/logo.png');
    expect(prepared.fileList).toContain('二进制文件');
    expect(prepared.skipped.map((s) => s.reason).sort()).toEqual(['binary', 'excluded']);
  });

  it('发送前对密钥脱敏', () => {
    const files = parseDiff(SECRET_PATCH);
    const prepared = prepareDiff(files, base);
    expect(prepared.redactionHits).toBeGreaterThanOrEqual(2);
    expect(prepared.patch).not.toContain('sk-live-abcdefghijklmnopqrstuvwx');
    expect(prepared.patch).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(prepared.patch).toContain('***REDACTED***');
  });

  it('可通过开关关闭脱敏', () => {
    const files = parseDiff(SECRET_PATCH);
    const prepared = prepareDiff(files, { ...base, redactSecrets: false });
    expect(prepared.redactionHits).toBe(0);
    expect(prepared.patch).toContain('sk-live-abcdefghijklmnopqrstuvwx');
  });

  it('超出总预算时丢弃文件而不是硬截断', () => {
    const files = parseDiff(bigPatch(6, 40));
    const prepared = prepareDiff(files, { ...base, maxTotalChars: 4000 });
    expect(prepared.included.length).toBeLessThan(6);
    expect(prepared.included.length).toBeGreaterThanOrEqual(1);
    expect(prepared.patch.length).toBeLessThanOrEqual(4000);
    expect(prepared.skipped.some((s) => s.detail === '超出上下文预算')).toBe(true);
  });

  it('单文件超长时截断并标记', () => {
    const [file] = parseDiff(bigPatch(1, 80));
    const { file: truncatedFile, truncated } = truncateFile(file, 600);
    expect(truncated).toBe(true);
    expect(renderFilePatch(truncatedFile).length).toBeLessThan(renderFilePatch(file).length);
  });
});

describe('redactSecrets', () => {
  it('保留键名、打码取值', () => {
    const r = redactSecrets('const password = "hunter2hunter2";');
    expect(r.hits).toBe(1);
    expect(r.text).toContain('password = "***REDACTED***"');
  });

  it('处理 Bearer 头', () => {
    const r = redactSecrets('Authorization: Bearer abcdefghijklmnop123456');
    expect(r.text).not.toContain('abcdefghijklmnop123456');
  });

  it('普通代码不误伤', () => {
    const code = 'const total = items.length; // 统计数量';
    expect(redactSecrets(code).hits).toBe(0);
  });
});

describe('tokenBudget', () => {
  it('中文按字计、英文按 3.5 字符折算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefghijklmn')).toBe(4);
    expect(estimateTokens('hi')).toBe(1);
  });

  it('超预算时给出建议字符数', () => {
    const report = checkBudget('a'.repeat(10000), 100);
    expect(report.fits).toBe(false);
    expect(report.suggestedMaxChars).toBeLessThan(10000);
  });

  it('预算内直接通过', () => {
    expect(checkBudget('hello', 1000).fits).toBe(true);
    expect(charBudgetFor(1000)).toBe(3200);
  });
});
