import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { start } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';

test('one-command runtime starts ATC and invokes the OpenCode orchestrator', { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dev-team-app-'));
  const project = join(temp, 'project');
  const fakeOpenCode = join(temp, 'fake-opencode');
  await mkdir(project);
  await writeFile(fakeOpenCode, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.18.30; fi\nexit 0\n');
  await chmod(fakeOpenCode, 0o755);
  try {
    const config = await loadConfig(project, {
      provider: 'novcs', stateRoot: join(temp, 'state'), port: await freePort(),
      opencodeCommand: fakeOpenCode,
    });
    await start(config);
    assert.ok(true);
  } finally {
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
