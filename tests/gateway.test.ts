import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import test from 'node:test';
import { ControlServer } from '../src/runtime/control-server.js';

test('stdio gateway exposes role-specific tools and proxies RPC', { timeout: 15_000 }, async () => {
  const token = 'gateway-test-token';
  const requests: string[] = [];
  const control = new ControlServer(token, async (request) => {
    requests.push(request.method);
    assert.equal(request.role, 'main');
    assert.equal(request.agentId, 'main');
    return request.method === 'list_tasks' ? [{ id: 'task-1' }] : null;
  });
  const url = await control.start();
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(process.cwd(), 'src', 'cli.ts'), 'gateway'],
    cwd: process.cwd(),
    env: cleanEnvironment({
      DEV_TEAM_CONTROL_URL: url,
      DEV_TEAM_CONTROL_TOKEN: token,
      DEV_TEAM_ROLE: 'main',
      DEV_TEAM_AGENT_ID: 'main',
    }),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(({ name }) => name === 'task_create_delivery'));
    assert.ok(tools.tools.some(({ name }) => name === 'task_wait'));
    assert.ok(!tools.tools.some(({ name }) => name === 'task_submit'));
    const result = await client.callTool({ name: 'task_list', arguments: {} });
    const text = result.content.find((item) => item.type === 'text');
    assert.ok(text?.type === 'text' && text.text.includes('task-1'));
    assert.deepEqual(requests, ['list_tasks']);
  } finally {
    await client.close().catch(() => undefined);
    await control.close();
  }
});

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
