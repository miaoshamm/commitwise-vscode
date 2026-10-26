import { DiffFile, addedLineNumbers } from '../diff/diffModel';
import { ReviewIssue, ReviewResult, SEVERITY_ORDER, Severity } from './reviewIssue';

export interface MapOptions {
  minSeverity: Severity;
  maxIssues: number;
}

export interface DroppedStats {
  /** 文件路径不在本次 diff 中 */
  unknownFile: number;
  /** 行号不在任何新增行内，已降级为文件级 */
  outOfRange: number;
  /** 结构缺失（如没有 title）被丢弃 */
  malformed: number;
}

export interface MappedReview {
  summary: string;
  issues: ReviewIssue[];
  byFile: Array<{ file: string; issues: ReviewIssue[] }>;
  counts: Record<Severity, number>;
  dropped: DroppedStats;
  /** 是否因为 maxIssues 被截断 */
  truncated: boolean;
  totalBeforeLimit: number;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, '');
}

/**
 * 把模型给出的事物对齐到真实 diff：
 * - 路径必须能在本次暂存区中找到（支持重命名前的旧路径）
 * - 行号必须落在新增行内，否则降级为文件级（避免波浪线标错位置）
 * - 按级别过滤、排序、限量
 */
export function mapIssuesToDiff(result: ReviewResult, files: DiffFile[], malformedDropped: number, opts: MapOptions): MappedReview {
  const index = new Map<string, DiffFile>();
  for (const f of files) {
    index.set(normalize(f.path), f);
    if (f.oldPath) {
      index.set(normalize(f.oldPath), f);
    }
  }

  const addedCache = new Map<string, Set<number>>();
  const addedFor = (file: DiffFile): Set<number> => {
    const key = file.path;
    let set = addedCache.get(key);
    if (!set) {
      set = addedLineNumbers(file);
      addedCache.set(key, set);
    }
    return set;
  };

  const dropped: DroppedStats = { unknownFile: 0, outOfRange: 0, malformed: malformedDropped };
  const kept: ReviewIssue[] = [];

  for (const issue of result.issues) {
    const key = normalize(issue.file);
    let target = index.get(key);

    if (!target) {
      // 容错：模型可能只给了文件名，或给了带仓库前缀的绝对路径
      for (const [path, file] of index) {
        if (path.endsWith('/' + key) || key.endsWith('/' + path)) {
          target = file;
          break;
        }
      }
    }

    if (!target) {
      dropped.unknownFile++;
      continue;
    }

    if (SEVERITY_ORDER[issue.severity] > SEVERITY_ORDER[opts.minSeverity]) {
      continue;
    }

    let mapped: ReviewIssue = { ...issue, file: target.path };

    if (typeof issue.line === 'number') {
      if (addedFor(target).has(issue.line)) {
        mapped.anchor = 'line';
      } else {
        dropped.outOfRange++;
        mapped.anchor = 'file';
        mapped.line = undefined;
      }
    } else {
      mapped.anchor = 'file';
    }

    kept.push(mapped);
  }

  kept.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) {
      return s;
    }
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    return (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
  });

  const totalBeforeLimit = kept.length;
  const limited = kept.slice(0, Math.max(1, opts.maxIssues));

  const groups = new Map<string, ReviewIssue[]>();
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const issue of limited) {
    counts[issue.severity]++;
    const arr = groups.get(issue.file) ?? [];
    arr.push(issue);
    groups.set(issue.file, arr);
  }

  return {
    summary: result.summary,
    issues: limited,
    byFile: [...groups.entries()].map(([file, issues]) => ({ file, issues })),
    counts,
    dropped,
    truncated: totalBeforeLimit > limited.length,
    totalBeforeLimit,
  };
}
