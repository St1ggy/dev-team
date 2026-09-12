import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/core/types.js';
import { NoVcsProvider } from '../src/providers/novcs-provider.js';

test('NoVCS integrates worker snapshots and applies a delivery', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dev-team-novcs-'));
  const source = join(temp, 'source');
  const state = join(temp, 'state');
  await mkdir(source);
  await writeFile(join(source, 'file.txt'), 'base\n');
  const project: ProjectRecord = { id: 'p', root: source, provider: 'novcs', baseRef: 'source', projectRelativePath: '.' };
  const provider = new NoVcsProvider();
  try {
    const aggregate = await provider.createWorkspace({ project, scopeId: 'scope', kind: 'aggregate', workspaceRoot: join(state, 'aggregate') });
    const worker = await provider.createWorkspace({ project, scopeId: 'scope', taskId: 'task', kind: 'task', workspaceRoot: join(state, 'worker'), baseWorkspace: aggregate });
    await writeFile(join(worker.projectPath, 'file.txt'), 'worker\n');
    await writeFile(join(worker.projectPath, 'new.txt'), 'new\n');
    const receipt = await provider.integrate(project, worker, aggregate);
    assert.equal(receipt.alreadyApplied, false);
    assert.equal(await readFile(join(aggregate.projectPath, 'file.txt'), 'utf8'), 'worker\n');
    assert.match((await provider.diff(project, aggregate)).text, /M\tfile\.txt/);
    await provider.applyDelivery(project, aggregate);
    assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'worker\n');
    assert.equal(await readFile(join(source, 'new.txt'), 'utf8'), 'new\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('NoVCS reports conflicts without modifying the aggregate', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dev-team-novcs-conflict-'));
  const source = join(temp, 'source');
  await mkdir(source);
  await writeFile(join(source, 'file.txt'), 'base\n');
  const project: ProjectRecord = { id: 'p', root: source, provider: 'novcs', baseRef: 'source', projectRelativePath: '.' };
  const provider = new NoVcsProvider();
  try {
    const aggregate = await provider.createWorkspace({ project, scopeId: 'scope', kind: 'aggregate', workspaceRoot: join(temp, 'aggregate') });
    const worker = await provider.createWorkspace({ project, scopeId: 'scope', taskId: 'task', kind: 'task', workspaceRoot: join(temp, 'worker'), baseWorkspace: aggregate });
    await writeFile(join(worker.projectPath, 'file.txt'), 'worker\n');
    await writeFile(join(aggregate.projectPath, 'file.txt'), 'other\n');
    await assert.rejects(provider.integrate(project, worker, aggregate), /Conflicting files: file\.txt/);
    assert.equal(await readFile(join(aggregate.projectPath, 'file.txt'), 'utf8'), 'other\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
