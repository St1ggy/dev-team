import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/state/store.js';

test('StateStore persists projects, scopes, tasks, workspaces, and operation state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-state-'));
  try {
    const store = new StateStore(join(root, 'state.sqlite'));
    store.upsertProject({ id: 'p1', root: '/repo', provider: 'git', baseRef: 'main', projectRelativePath: '.' });
    store.putScope({ id: 's1', projectId: 'p1', title: 'Delivery', deliveryTaskId: 'd1', aggregateWorkspaceId: null, status: 'active' });
    store.putTask({ taskId: 'd1', scopeId: 's1', kind: 'delivery', workspaceId: null, checkpoint: null, submission: null, integration: null });
    store.beginOperation('op1', 'approve', 'd1', { revision: 'abc' });
    store.finishOperation('op1', 'provider_done', { url: 'https://example.test/pr/1' });
    assert.equal(store.getProject('p1').provider, 'git');
    assert.equal(store.getScope('s1').deliveryTaskId, 'd1');
    assert.equal(store.getTask('d1').kind, 'delivery');
    assert.deepEqual(store.getOperation('op1'), { status: 'provider_done', result: { url: 'https://example.test/pr/1' } });
    assert.equal(store.listRecoverableOperations().length, 1);
    store.putRunner({
      id: 'runner1', projectId: 'p1', name: 'manual', url: 'http://127.0.0.1:1',
      token: 'secret', processId: process.pid, status: 'idle', currentAgentId: null,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(store.reserveRunner('runner1', 'agent1'), true);
    assert.equal(store.reserveRunner('runner1', 'agent2'), false);
    assert.equal(store.getRunner('runner1').currentAgentId, 'agent1');
    store.releaseRunnerByAgent('agent1');
    assert.equal(store.getRunner('runner1').status, 'idle');
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
