import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { loadConfig } from '../src/config/config.js';
import { CoordinationService } from '../src/coordination/service.js';
import { AtcHttpClient } from '../src/coordination/atc-http.js';
import type { ProjectRecord } from '../src/core/types.js';
import { NoVcsProvider } from '../src/providers/novcs-provider.js';
import { AtcDashboard } from '../src/runtime/atc-dashboard.js';
import { StateStore } from '../src/state/store.js';
import { resolveAtcNode } from '../src/app.js';

test('coordination flow aggregates a work task before applying its delivery', { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dev-team-flow-'));
  const source = join(temp, 'source');
  const stateRoot = join(temp, 'state');
  await mkdir(source);
  await writeFile(join(source, 'feature.txt'), 'base\n');
  const config = await loadConfig(source, { provider: 'novcs', stateRoot, workers: 2 });
  const node = await resolveAtcNode(config, source);
  const project: ProjectRecord = { id: 'flow-project', root: source, provider: 'novcs', baseRef: 'source', projectRelativePath: '.' };
  const store = new StateStore(join(stateRoot, 'state.sqlite'));
  store.upsertProject(project);
  const port = await freePort();
  const dashboard = new AtcDashboard(join(stateRoot, 'atc.sqlite'), stateRoot, port, node);
  const url = await dashboard.start();
  const atcProject = await new AtcHttpClient(url).ensureProject(project.id, 'Flow test', 'main');
  const service = new CoordinationService(config, project, new NoVcsProvider(), store, join(stateRoot, 'atc.sqlite'), node, url);
  await service.start(atcProject.id);
  try {
    const delivery = await service.createDelivery({ title: 'Feature delivery' });
    const deliveryTaskId = String(delivery.task.id);
    const work = await service.createWork({ scopeId: delivery.scope.id, title: 'Implement feature' });
    const workTaskId = String(work.id);
    await service.setDependencies(deliveryTaskId, [workTaskId]);

    const worker = await service.dispatch(workTaskId);
    await writeFile(join(worker.cwd, 'feature.txt'), 'implemented\n');
    await service.submit(worker.agentId);
    await service.review(workTaskId, 'approve', 'Looks good');
    await service.handleWorkerExit(worker.agentId);
    assert.equal(await readFile(join(source, 'feature.txt'), 'utf8'), 'base\n');

    const deliveryWorker = await service.dispatch(deliveryTaskId);
    await service.submit(deliveryWorker.agentId);
    await service.review(deliveryTaskId, 'approve', 'Ready to deliver');
    await service.handleWorkerExit(deliveryWorker.agentId);
    assert.equal(await readFile(join(source, 'feature.txt'), 'utf8'), 'implemented\n');
  } finally {
    await service.stop().catch(() => undefined);
    dashboard.stop();
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
