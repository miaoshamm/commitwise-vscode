import { DiffFile, parseDiff } from '../../domain/diff/diffModel';
import { GitError, GitRunner } from './gitRunner';

export interface StagedSnapshot {
  root: string;
  branch: string;
  /** 仓库尚无任何提交（unborn HEAD） */
  isUnborn: boolean;
  files: DiffFile[];
  nameStatus: string;
  recentCommits: string[];
  /** 原始补丁文本，未过滤未脱敏，仅用于统计 */
  rawPatchChars: number;
}

/**
 * 采集暂存区快照。只读，不修改任何仓库状态。
 */
export async function collectStaged(runner: GitRunner, root: string, recentCommitCount: number): Promise<StagedSnapshot> {
  const isUnborn = await isUnbornHead(runner, root);
  const branch = await currentBranch(runner, root);

  const [patch, nameStatus, log] = await Promise.all([
    runner.exec(['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '-U3'], root),
    runner.exec(['diff', '--cached', '--name-status', '-M'], root).catch(() => ({ stdout: '', stderr: '' })),
    recentCommitCount > 0
      ? runner
          .exec(['log', `-n${recentCommitCount}`, '--no-merges', '--pretty=format:%s'], root)
          .catch(() => ({ stdout: '', stderr: '' }))
      : Promise.resolve({ stdout: '', stderr: '' }),
  ]);

  const files = parseDiff(patch.stdout);

  return {
    root,
    branch,
    isUnborn,
    files,
    nameStatus: nameStatus.stdout.trim(),
    recentCommits: log.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    rawPatchChars: patch.stdout.length,
  };
}

async function isUnbornHead(runner: GitRunner, root: string): Promise<boolean> {
  try {
    await runner.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
    return false;
  } catch (err) {
    if (err instanceof GitError) {
      return true;
    }
    throw err;
  }
}

async function currentBranch(runner: GitRunner, root: string): Promise<string> {
  try {
    const { stdout } = await runner.exec(['symbolic-ref', '--short', '-q', 'HEAD'], root);
    const name = stdout.trim();
    return name || '(detached HEAD)';
  } catch {
    return '(detached HEAD)';
  }
}

/** 探测某目录是否在 git 仓库内，返回仓库根目录 */
export async function findRepoRoot(runner: GitRunner, dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await runner.exec(['rev-parse', '--show-toplevel'], dir);
    const root = stdout.trim().replace(/\r$/, '');
    return root || undefined;
  } catch {
    return undefined;
  }
}
