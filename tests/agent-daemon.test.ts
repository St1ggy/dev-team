import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import type { DevTeamConfig } from '../src/config/config.js';
import type { ProjectRecord } from '../src/core/types.js';
import { StateStore } from '../src/state/store.js';
import { AgentDaemon, AgentRunnerClient } from '../src/runtime/agent-daemon.js';

test('manual agent daemon executes an assignment with the agent OpenCode profile', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-agent-'));
  const projectPath = join(root, 'project');
  const capture = join(root, 'capture.json');
  const executable = join(root, 'fake-opencode');
  await mkdir(projectPath);
  await writeFile(executable, `#!/bin/sh\nnode -e 'require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(1),config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)}))' -- "$@"\n`);
  await chmod(executable, 0o755);
  const project: ProjectRecord = { id: 'project-test', root: projectPath, provider: 'novcs', baseRef: 'source', projectRelativePath: '.' };
  const config: DevTeamConfig = {
    projectId: project.id, projectPath, provider: 'novcs', workers: 1, port: 4000,
    opencodeCommand: executable, atcDbPath: join(root, 'atc.sqlite'), stateRoot: join(root, 'state'), plugins: [],
  };
  const store = new StateStore(join(config.stateRoot, 'state.sqlite'));
  store.upsertProject(project);
  const callbacks: unknown[] = [];
  const control = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    callbacks.push(JSON.parse(body));
    if (callbacks.length < 3) {
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"retry"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const controlUrl = await listen(control);
  const daemon = new AgentDaemon(config, project, store, 'manual-1', ['git']);
  const runner = await daemon.start();
  try {
    assert.equal(store.reserveRunner(runner.id, 'agent-1'), true);
    const pid = await new AgentRunnerClient().assign(store.getRunner(runner.id), {
      worker: { agentId: 'agent-1', taskId: 'task-1', cwd: projectPath, prompt: 'Implement it' },
      gateway: { url: controlUrl, token: 'control-token' },
    });
    assert.ok(pid > 0);
    await waitFor(() => store.getRunner(runner.id).status === 'idle');
    assert.equal(callbacks.length, 3);
    const recorded = JSON.parse(await readFile(capture, 'utf8')) as { args: string[]; config: { agent?: Record<string, unknown>; mcp?: Record<string, { enabled?: boolean; environment?: Record<string, string> }> } };
    assert.ok(recorded.args.includes('--agent'));
    assert.ok(recorded.args.includes('agent'));
    assert.ok(recorded.config.agent?.orchestrator);
    assert.ok(recorded.config.agent?.agent);
    assert.equal(recorded.config.mcp?.atc?.enabled, true);
    assert.equal(recorded.config.mcp?.atc?.environment?.DB_PATH, config.atcDbPath);
  } finally {
    await daemon.stop();
    await close(control);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}
