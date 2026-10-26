import { DiffFile, renderFilePatch } from './diffModel';
import { matchesAnyGlob } from './glob';
import { redactSecrets } from './redact';

export interface PrepareOptions {
  /** 排除规则（命中则内容不发送，但仍在文件清单中可见） */
  excludeGlobs: string[];
  /** 单文件字符上限 */
  maxFileChars: number;
  /** 总字符上限 */
  maxTotalChars: number;
  /** 是否脱敏 */
  redactSecrets: boolean;
}

export type SkipReason = 'excluded' | 'binary';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
  detail?: string;
}

export interface PreparedDiff {
  /** 最终发给模型的补丁文本（已脱敏） */
  patch: string;
  /** 实际包含在 patch 中的文件 */
  included: DiffFile[];
  /** 未包含内容的文件及原因 */
  skipped: SkippedFile[];
  /** 因字符上限被截断内容的文件 */
  truncated: string[];
  /** 供 {{stagedFiles}} 使用的文件清单 */
  fileList: string;
  chars: number;
  redactionHits: number;
  redactionRules: string[];
}

const STATUS_LETTER: Record<DiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  binary: 'B',
};

/** 按字符上限裁剪单个文件，保留尽可能多的完整 hunk */
export function truncateFile(file: DiffFile, maxChars: number): { file: DiffFile; truncated: boolean } {
  const full = renderFilePatch(file);
  if (full.length <= maxChars) {
    return { file, truncated: false };
  }

  const headerCost = file.headerLines.join('\n').length + 120;
  const kept: DiffFile['hunks'] = [];
  let used = headerCost;

  for (const hunk of file.hunks) {
    const hunkCost = hunk.lines.reduce((sum, l) => sum + l.content.length + 2, 40);
    if (used + hunkCost > maxChars) {
      break;
    }
    kept.push(hunk);
    used += hunkCost;
  }

  if (kept.length === 0 && file.hunks.length > 0) {
    // 第一个 hunk 就放不下：截取该 hunk 的前若干行
    const first = file.hunks[0];
    const parts = first.lines.slice(0, Math.max(5, Math.floor((maxChars - headerCost) / 40)));
    kept.push({ ...first, lines: parts, newLines: parts.filter((l) => l.kind !== 'del').length, oldLines: parts.filter((l) => l.kind !== 'add').length });
  }

  return { file: { ...file, hunks: kept }, truncated: true };
}

function buildFileList(files: DiffFile[], skipped: SkippedFile[]): string {
  const skipMap = new Map(skipped.map((s) => [s.path, s]));
  return files
    .map((f) => {
      const parts = [
        STATUS_LETTER[f.status],
        f.path,
        `+${f.additions}`,
        `-${f.deletions}`,
      ];
      const skip = skipMap.get(f.path);
      let note = '';
      if (skip) {
        note = skip.reason === 'binary' ? '  （二进制文件，内容未提供）' : '  （已按规则排除，内容未提供）';
      }
      if (f.status === 'renamed' && f.oldPath) {
        parts[1] = `${f.oldPath} -> ${f.path}`;
      }
      return parts.join('\t') + note;
    })
    .join('\n');
}

/**
 * 过滤 → 逐文件截断 → 总预算裁剪 → 脱敏，产出可直接塞进提示词的补丁文本。
 */
export function prepareDiff(files: DiffFile[], opts: PrepareOptions): PreparedDiff {
  const skipped: SkippedFile[] = [];
  const candidates: DiffFile[] = [];
  const truncated: string[] = [];

  for (const file of files) {
    if (file.binary) {
      skipped.push({ path: file.path, reason: 'binary' });
      continue;
    }
    const hit = matchesAnyGlob(file.path, opts.excludeGlobs);
    if (hit) {
      skipped.push({ path: file.path, reason: 'excluded', detail: hit });
      continue;
    }
    if (file.hunks.length === 0) {
      skipped.push({ path: file.path, reason: 'excluded', detail: 'no hunk' });
      continue;
    }
    const t = truncateFile(file, opts.maxFileChars);
    if (t.truncated) {
      truncated.push(file.path);
    }
    candidates.push(t.file);
  }

  // 超出总预算时，逐个丢弃体积最大的文件（文档类优先丢弃，源码尽量保留）
  const cost = (f: DiffFile) => renderFilePatch(f).length;
  const order = [...candidates].sort((a, b) => cost(b) - cost(a));
  const dropped = new Set<string>();

  const total = () => candidates.reduce((sum, f) => (dropped.has(f.path) ? sum : sum + cost(f)), 0);

  for (const file of order) {
    if (total() <= opts.maxTotalChars) {
      break;
    }
    if (candidates.length - dropped.size <= 1) {
      break;
    }
    dropped.add(file.path);
    skipped.push({ path: file.path, reason: 'excluded', detail: '超出上下文预算' });
  }

  const included = candidates.filter((f) => !dropped.has(f.path));
  let patch = included
    .map((f) => (truncated.includes(f.path) ? `${renderFilePatch(f)}\n（注：该文件 diff 已截断）` : renderFilePatch(f)))
    .join('\n\n');

  if (patch.length > opts.maxTotalChars) {
    patch = patch.slice(0, opts.maxTotalChars) + '\n…（补丁已按总长度上限截断）';
  }

  let redactionHits = 0;
  let redactionRules: string[] = [];
  if (opts.redactSecrets) {
    const r = redactSecrets(patch);
    patch = r.text;
    redactionHits = r.hits;
    redactionRules = r.rules;
  }

  return {
    patch,
    included,
    skipped,
    truncated,
    fileList: buildFileList(files, skipped),
    chars: patch.length,
    redactionHits,
    redactionRules,
  };
}
