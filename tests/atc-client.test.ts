import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AtcClient } from '../src/coordination/atc-client.js';
import { loadConfig } from '../src/config/config.js';
import { resolveAtcNode } from '../src/app.js';
import { AtcDashboard } from '../src/runtime/atc-dashboard.js';
import { AtcHttpClient } from '../src/coordination/atc-http.js';
import { createServer } from 'node:net';

test('ATC MCP client registers and creates a review task', { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dev-team-atc-'));
  const node = await resolveAtcNode(await loadConfig(temp), temp);
  const port = await freePort();
  const dashboard = new AtcDashboard(join(temp, 'atc.sqlite'), temp, port, node);
  const url = await dashboard.start();
  const client = new AtcClient(join(temp, 'atc.sqlite'), temp, node);
  try {
    const project = await new AtcHttpClient(url).ensureProject('test-project', 'Test project', 'main');
    const registration = await client.connect('test-orchestrator', 'main', project.id);
    assert.ok(registration.agent_token);
    const task = await client.createTask({ title: 'ATC smoke task', labels: ['test'], requiresReview: true });
    assert.equal(typeof task.id, 'string');
    assert.equal(task.status, 'todo');
    assert.ok((await client.listTasks()).some(({ id }) => id === task.id));
  } finally {
    await client.close().catch(() => undefined);
    dashboard.stop();
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
