import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { AtcHttpClient } from '../src/coordination/atc-http.js';
import { AtcDashboard } from '../src/runtime/atc-dashboard.js';

test('reuses one ATC server for multiple projects', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-atc-'));
  const port = await freePort();
  const first = new AtcDashboard(join(root, 'atc.sqlite'), root, port, process.execPath);
  const second = new AtcDashboard(join(root, 'atc.sqlite'), root, port, process.execPath);
  try {
    const firstUrl = await first.start();
    const firstClient = new AtcHttpClient(firstUrl);
    const firstProject = await firstClient.ensureProject('first', 'First', 'main');
    const secondUrl = await second.start();
    const secondClient = new AtcHttpClient(secondUrl);
    const secondProject = await secondClient.ensureProject('second', 'Second', 'main');
    assert.equal(secondUrl, firstUrl);
    assert.notEqual(secondProject.id, firstProject.id);
    const listed = await fetch(`${firstUrl}/api/projects`).then((response) => response.json()) as { projects: unknown[] };
    assert.equal(listed.projects.length, 2);
    await firstClient.createTask(firstProject.id, { title: 'First task' });
    await secondClient.createTask(secondProject.id, { title: 'Second task' });
    assert.deepEqual((await firstClient.listTasks(firstProject.id)).map((task) => task.title), ['First task']);
    assert.deepEqual((await secondClient.listTasks(secondProject.id)).map((task) => task.title), ['Second task']);
    assert.equal((await AtcDashboard.status(port)).running, true);
  } finally {
    await first.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a non-ATC service on the configured port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-atc-'));
  const server = createHttpServer((_request, response) => response.end('other service'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const dashboard = new AtcDashboard(join(root, 'atc.sqlite'), root, address.port, process.execPath);
    await assert.rejects(dashboard.start(), /not ATC/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects reusing a managed ATC with a different database', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-atc-mismatch-'));
  const port = await freePort();
  const first = new AtcDashboard(join(root, 'first.sqlite'), root, port, process.execPath);
  const second = new AtcDashboard(join(root, 'second.sqlite'), root, port, process.execPath);
  try {
    await first.start();
    await assert.rejects(second.start(), /uses .*first\.sqlite.*configured for .*second\.sqlite/);
  } finally {
    await first.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes concurrent ATC project registration', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-atc-project-race-'));
  const dbPath = join(root, 'atc.sqlite');
  const dashboard = new AtcDashboard(dbPath, root, await freePort(), process.execPath);
  try {
    const url = await dashboard.start();
    const projects = await Promise.all(Array.from({ length: 8 }, () => new AtcHttpClient(url, dbPath).ensureProject('same', 'Same', 'main')));
    assert.equal(new Set(projects.map((project) => project.id)).size, 1);
    const listed = await fetch(`${url}/api/projects`).then((response) => response.json()) as { projects: unknown[] };
    assert.equal(listed.projects.length, 1);
  } finally {
    await dashboard.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
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
