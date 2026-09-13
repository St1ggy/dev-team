import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlServer, type RpcRequest } from '../src/runtime/control-server.js';

test('control server binds RPC identity to bearer tokens', async () => {
  const requests: RpcRequest[] = [];
  const server = new ControlServer('main-token', async (request) => {
    requests.push(request);
    return { ok: true };
  });
  const url = await server.start();
  try {
    await rpc(url, 'main-token', { role: 'worker', agentId: 'spoofed', method: 'main-call', params: {} });
    const workerToken = server.issueWorkerToken('agent-1');
    await rpc(url, workerToken, { role: 'main', agentId: 'spoofed', method: 'worker-call', params: {} });
    assert.deepEqual(requests.map(({ role, agentId }) => ({ role, agentId })), [
      { role: 'main', agentId: 'main' },
      { role: 'worker', agentId: 'agent-1' },
    ]);
    server.revokeWorkerAgent('agent-1');
    assert.equal((await rpc(url, workerToken, { method: 'again', params: {} })).status, 404);
  } finally {
    await server.close();
  }
});

function rpc(url: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
