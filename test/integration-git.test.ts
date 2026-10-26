import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectStaged, findRepoRoot } from '../src/infra/git/diffCollector';
import { NodeGitRunner } from '../src/infra/git/gitRunner';
import { prepareDiff } from '../src/domain/diff/prepareDiff';

const temps: string[] = [];
const runner = new NodeGitRunner();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitcraft-'));
  temps.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

afterAll(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发文件占用，忽略
    }
  }
});

describe('git 采集（真实仓库）', () => {
  it('读取暂存区变更、分支与最近提交', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'chore: 初始化');

    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 2;\nexport const b = 3;\n');
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"k":1}');
    git(dir, 'add', 'index.ts', 'lock.json');

    const snapshot = await collectStaged(runner, dir, 5);

    expect(snapshot.isUnborn).toBe(false);
    expect(snapshot.branch).toBeTruthy();
    expect(snapshot.files.map((f) => f.path).sort()).toEqual(['index.ts', 'lock.json']);
    expect(snapshot.recentCommits[0]).toBe('chore: 初始化');

    const prepared = prepareDiff(snapshot.files, {
      excludeGlobs: ['**/lock.json'],
      maxFileChars: 20000,
      maxTotalChars: 48000,
      redactSecrets: true,
    });
    expect(prepared.included.map((f) => f.path)).toEqual(['index.ts']);
    expect(prepared.patch).toContain('+export const b = 3;');
  });

  it('未暂存的改动不会进入上下文', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'chore: init');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    git(dir, 'add', 'a.txt');
    // 暂存之后又改了工作区
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nUNSTAGED_MARKER\n');

    const snapshot = await collectStaged(runner, dir, 0);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].additions).toBe(1);
    expect(snapshot.rawPatchChars).toBeGreaterThan(0);
  });

  it('空暂存区返回零个文件', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const snapshot = await collectStaged(runner, dir, 0);
    expect(snapshot.files).toEqual([]);
  });

  it('首次提交（unborn HEAD）也能拿到 diff', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'first.txt'), 'hello\n');
    git(dir, 'add', '.');

    const snapshot = await collectStaged(runner, dir, 5);
    expect(snapshot.isUnborn).toBe(true);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].status).toBe('added');
    expect(snapshot.recentCommits).toEqual([]);
  });

  it('能定位子目录所属的仓库根', async () => {
    const dir = makeRepo();
    const sub = path.join(dir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const root = await findRepoRoot(runner, sub);
    expect(root?.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'));
  });

  it('非 git 目录返回 undefined 而不是抛错', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitcraft-nogit-'));
    temps.push(dir);
    expect(await findRepoRoot(runner, dir)).toBeUndefined();
  });
});
