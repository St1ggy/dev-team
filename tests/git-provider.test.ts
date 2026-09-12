import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/core/types.js';
import { GitProvider } from '../src/providers/git-provider.js';
import { ProcessCommandRunner } from '../src/runtime/command-runner.js';

test('Git provider checkpoints and integrates a task into the aggregate branch', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dev-team-git-'));
  const repo = join(temp, 'repo');
  await mkdir(repo);
  const runner = new ProcessCommandRunner();
  await runner.run('git', ['init', '-b', 'main'], { cwd: repo });
  await runner.run('git', ['config', 'user.name', 'Dev Team Test'], { cwd: repo });
  await runner.run('git', ['config', 'user.email', 'dev-team@example.test'], { cwd: repo });
  await writeFile(join(repo, 'file.txt'), 'base\n');
  await runner.run('git', ['add', 'file.txt'], { cwd: repo });
  await runner.run('git', ['commit', '-m', 'base'], { cwd: repo });
  const project: ProjectRecord = { id: 'p', root: repo, provider: 'git', baseRef: 'main', projectRelativePath: '.' };
  const provider = new GitProvider(runner);
  try {
    const aggregate = await provider.createWorkspace({ project, scopeId: 'scope', kind: 'aggregate', workspaceRoot: join(temp, 'aggregate') });
    const worker = await provider.createWorkspace({ project, scopeId: 'scope', taskId: 'task', kind: 'task', workspaceRoot: join(temp, 'worker'), baseWorkspace: aggregate });
    await writeFile(join(worker.projectPath, 'file.txt'), 'worker\n');
    await provider.checkpoint(project, worker, 'first worker checkpoint');
    await writeFile(join(worker.projectPath, 'second.txt'), 'second\n');
    const checkpoint = await provider.checkpoint(project, worker, 'second worker checkpoint');
    assert.equal(checkpoint.clean, true);
    const receipt = await provider.integrate(project, worker, aggregate);
    assert.equal(receipt.alreadyApplied, false);
    assert.equal(await readFile(join(aggregate.projectPath, 'file.txt'), 'utf8'), 'worker\n');
    assert.equal(await readFile(join(aggregate.projectPath, 'second.txt'), 'utf8'), 'second\n');
    const repeated = await provider.integrate(project, worker, aggregate);
    assert.equal(repeated.alreadyApplied, true);
  } finally {
    await runner.run('git', ['worktree', 'remove', '--force', join(temp, 'worker')], { cwd: repo, allowFailure: true });
    await runner.run('git', ['worktree', 'remove', '--force', join(temp, 'aggregate')], { cwd: repo, allowFailure: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test('Git integration aborts the whole checkpoint sequence on conflict', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dev-team-git-conflict-'));
  const repo = join(temp, 'repo');
  await mkdir(repo);
  const runner = new ProcessCommandRunner();
  await runner.run('git', ['init', '-b', 'main'], { cwd: repo });
  await runner.run('git', ['config', 'user.name', 'Dev Team Test'], { cwd: repo });
  await runner.run('git', ['config', 'user.email', 'dev-team@example.test'], { cwd: repo });
  await writeFile(join(repo, 'file.txt'), 'base\n');
  await runner.run('git', ['add', 'file.txt'], { cwd: repo });
  await runner.run('git', ['commit', '-m', 'base'], { cwd: repo });
  const project: ProjectRecord = { id: 'p', root: repo, provider: 'git', baseRef: 'main', projectRelativePath: '.' };
  const provider = new GitProvider(runner);
  try {
    const aggregate = await provider.createWorkspace({ project, scopeId: 'scope2', kind: 'aggregate', workspaceRoot: join(temp, 'aggregate') });
    const worker = await provider.createWorkspace({ project, scopeId: 'scope2', taskId: 'task2', kind: 'task', workspaceRoot: join(temp, 'worker'), baseWorkspace: aggregate });
    await writeFile(join(worker.projectPath, 'safe.txt'), 'must be rolled back\n');
    await provider.checkpoint(project, worker, 'safe change');
    await writeFile(join(worker.projectPath, 'file.txt'), 'worker\n');
    await provider.checkpoint(project, worker, 'conflicting change');
    await writeFile(join(aggregate.projectPath, 'file.txt'), 'aggregate\n');
    await provider.checkpoint(project, aggregate, 'aggregate change');
    await assert.rejects(provider.integrate(project, worker, aggregate), /CONFLICT|conflict/i);
    await assert.rejects(readFile(join(aggregate.projectPath, 'safe.txt'), 'utf8'));
    assert.equal(await readFile(join(aggregate.projectPath, 'file.txt'), 'utf8'), 'aggregate\n');
  } finally {
    await runner.run('git', ['worktree', 'remove', '--force', join(temp, 'worker')], { cwd: repo, allowFailure: true });
    await runner.run('git', ['worktree', 'remove', '--force', join(temp, 'aggregate')], { cwd: repo, allowFailure: true });
    await rm(temp, { recursive: true, force: true });
  }
});
