import { execFile } from 'child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string = '',
    readonly code: number = -1,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitUnavailableError extends Error {
  constructor() {
    super('找不到 git 可执行文件，请确认已安装 Git 并加入 PATH');
    this.name = 'GitUnavailableError';
  }
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  exec(args: string[], cwd: string): Promise<GitExecResult>;
}

const MAX_BUFFER = 128 * 1024 * 1024;
const TIMEOUT_MS = 30000;

/**
 * 走 git CLI：需要精确控制 --no-ext-diff / -M / -U 等参数，
 * 内置 Git 扩展的 diff API 无法保证与命令行一致的补丁形态。
 */
export class NodeGitRunner implements GitRunner {
  exec(args: string[], cwd: string): Promise<GitExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['--no-pager', ...args],
        {
          cwd,
          maxBuffer: MAX_BUFFER,
          timeout: TIMEOUT_MS,
          windowsHide: true,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: number | string };
            if (e.code === 'ENOENT') {
              reject(new GitUnavailableError());
              return;
            }
            reject(
              new GitError(
                `git ${args[0]} 执行失败：${String(stderr || e.message).trim().split('\n')[0]}`,
                String(stderr ?? ''),
                typeof e.code === 'number' ? e.code : -1,
              ),
            );
            return;
          }
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
  }
}
