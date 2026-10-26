/**
 * 极简 glob 匹配（gitignore 风格子集），避免引入 minimatch 依赖。
 *
 * 支持：`**`（跨目录）、`*`（目录内任意）、`?`（单字符）。
 * 不含 `/` 的模式按 gitignore 语义匹配任意层级的文件名。
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.trim().replace(/\\/g, '/');
  const anchored = pattern.includes('/');
  let body = '';

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 可匹配零层目录
        if (pattern[i + 2] === '/') {
          body += '(?:.*/)?';
          i += 2;
        } else {
          body += '.*';
          i += 1;
        }
      } else {
        body += '[^/]*';
      }
    } else if (ch === '?') {
      body += '[^/]';
    } else if (ch === '/') {
      body += '/';
    } else {
      body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return anchored ? new RegExp(`^${body}$`) : new RegExp(`(?:^|/)${body}$`);
}

export function matchesAnyGlob(path: string, globs: string[]): string | undefined {
  const normalized = path.replace(/\\/g, '/');
  for (const glob of globs) {
    if (!glob.trim()) {
      continue;
    }
    if (globToRegExp(glob).test(normalized)) {
      return glob;
    }
  }
  return undefined;
}
