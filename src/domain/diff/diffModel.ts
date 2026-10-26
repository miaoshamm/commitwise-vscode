/**
 * 暂存区 diff 的结构化模型与解析器。
 *
 * 输入是 `git diff --cached` 的原始输出，输出按文件切分、按 hunk 组织，
 * 并保留原始头部行以便无损重排（截断、裁剪时需要重新拼回补丁文本）。
 */

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  content: string;
  /** 该行在旧文件中的行号（仅 ctx / del 有） */
  oldLineNo?: number;
  /** 该行在新文件中的行号（仅 ctx / add 有） */
  newLineNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** hunk 头尾部的函数上下文，例如 `function foo()` */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** 新路径（删除的文件为原路径） */
  path: string;
  /** 重命名场景的原路径 */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  /** `diff --git` 到第一个 `@@` 之间的原始头部行，用于无损重排 */
  headerLines: string[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPathPrefix(raw: string, prefix: 'a/' | 'b/'): string {
  let p = raw.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  // 个别情况下 git 会在路径后追加制表符与时间戳
  const tab = p.indexOf('\t');
  if (tab >= 0) {
    p = p.slice(0, tab);
  }
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** 从 `diff --git a/x b/x` 中尽力解析两个路径（路径含空格时不可靠，仅作兜底） */
function parseGitHeaderPaths(line: string): { a: string; b: string } {
  const rest = line.slice('diff --git '.length).trim();
  if (rest.startsWith('"')) {
    const quoted = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
    if (quoted) {
      return {
        a: stripPathPrefix(quoted[1], 'a/'),
        b: stripPathPrefix(quoted[2], 'b/'),
      };
    }
  }
  const mid = rest.indexOf(' b/');
  if (mid > 0) {
    return {
      a: stripPathPrefix(rest.slice(0, mid), 'a/'),
      b: stripPathPrefix(rest.slice(mid + 1), 'b/'),
    };
  }
  const sp = rest.indexOf(' ');
  if (sp > 0) {
    return { a: stripPathPrefix(rest.slice(0, sp), 'a/'), b: stripPathPrefix(rest.slice(sp + 1), 'b/') };
  }
  return { a: rest, b: rest };
}

/**
 * 解析统一 diff 文本。空输入返回空数组。
 */
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = patch.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('diff --git ')) {
      i++;
      continue;
    }

    const fromHeader = parseGitHeaderPaths(line);
    let path = fromHeader.b;
    let oldPath: string | undefined;
    let status: FileStatus = 'modified';
    let binary = false;
    const headerLines: string[] = [line];
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    i++;

    // 头部区：直到第一个 @@ 或下一个 diff --git
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
      const h = lines[i];
      headerLines.push(h);

      if (h.startsWith('new file mode')) {
        status = 'added';
      } else if (h.startsWith('deleted file mode')) {
        status = 'deleted';
      } else if (h.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = stripPathPrefix(h.slice('rename from '.length), 'a/');
      } else if (h.startsWith('rename to ')) {
        path = stripPathPrefix(h.slice('rename to '.length), 'b/');
      } else if (h.startsWith('Binary files ') || h.startsWith('GIT binary patch')) {
        binary = true;
        status = 'binary';
      } else if (h.startsWith('--- ')) {
        const p = h.slice(4);
        if (p.trim() !== '/dev/null') {
          oldPath = stripPathPrefix(p, 'a/');
        }
      } else if (h.startsWith('+++ ')) {
        const p = h.slice(4);
        if (p.trim() !== '/dev/null') {
          path = stripPathPrefix(p, 'b/');
        } else {
          path = oldPath ?? path;
        }
      }
      i++;
    }

    // hunk 区
    while (i < lines.length && lines[i].startsWith('@@')) {
      const m = HUNK_HEADER.exec(lines[i]);
      if (!m) {
        i++;
        continue;
      }
      const hunk: DiffHunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '',
        lines: [],
      };
      i++;

      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      let oldRemaining = hunk.oldLines;
      let newRemaining = hunk.newLines;

      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith('diff --git ') || l.startsWith('@@')) {
          break;
        }
        const tag = l[0];
        const rest = l.slice(1);

        if (tag === '+') {
          hunk.lines.push({ kind: 'add', content: rest, newLineNo: newNo++ });
          newRemaining--;
          additions++;
        } else if (tag === '-') {
          hunk.lines.push({ kind: 'del', content: rest, oldLineNo: oldNo++ });
          oldRemaining--;
          deletions++;
        } else if (tag === ' ') {
          hunk.lines.push({ kind: 'ctx', content: rest, oldLineNo: oldNo++, newLineNo: newNo++ });
          oldRemaining--;
          newRemaining--;
        } else if (tag === '\\') {
          // "\ No newline at end of file" 之类的标记，忽略
        } else if (l === '') {
          // hunk 末尾的空行（补丁文本常以换行结尾），视为结束
          break;
        } else {
          // 非预期内容，结束当前 hunk，交由外层继续扫描
          break;
        }
        i++;

        if (oldRemaining <= 0 && newRemaining <= 0) {
          break;
        }
      }

      hunks.push(hunk);
    }

    files.push({
      path,
      oldPath: oldPath && oldPath !== path ? oldPath : undefined,
      status,
      binary,
      headerLines,
      hunks,
      additions,
      deletions,
    });
  }

  return files;
}

/** 把单个文件重新渲染成补丁文本（用于裁剪后重组提示词） */
export function renderFilePatch(file: DiffFile): string {
  const out: string[] = [...file.headerLines];
  for (const hunk of file.hunks) {
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ' ' + hunk.section : ''}`,
    );
    for (const line of hunk.lines) {
      out.push((line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ') + line.content);
    }
  }
  return out.join('\n');
}

/** 文件中所有「新增行」的行号集合，用于校验审查问题的定位是否合法 */
export function addedLineNumbers(file: DiffFile): Set<number> {
  const set = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' && line.newLineNo !== undefined) {
        set.add(line.newLineNo);
      }
    }
  }
  return set;
}
