import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { errorMessage } from '../core/errors.js';

export interface RpcRequest {
  role: 'main' | 'worker';
  agentId: string;
  method: string;
  params: Record<string, unknown>;
}

export type RpcHandler = (request: RpcRequest) => Promise<unknown>;

export class ControlServer {
  private server: Server | null = null;
  private readonly workerTokens = new Map<string, string>();
  private readonly agentTokens = new Map<string, string>();

  constructor(private readonly token: string, private readonly handler: RpcHandler) {}

  issueWorkerToken(agentId: string): string {
    this.revokeWorkerAgent(agentId);
    const token = randomBytes(32).toString('hex');
    this.workerTokens.set(token, agentId);
    this.agentTokens.set(agentId, token);
    return token;
  }

  revokeWorkerToken(token: string): void {
    const agentId = this.workerTokens.get(token);
    this.workerTokens.delete(token);
    if (agentId && this.agentTokens.get(agentId) === token) this.agentTokens.delete(agentId);
  }

  revokeWorkerAgent(agentId: string): void {
    const token = this.agentTokens.get(agentId);
    if (token) this.workerTokens.delete(token);
    this.agentTokens.delete(agentId);
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const workerAgentId = this.workerTokens.get(bearer);
      if (request.method !== 'POST' || request.url !== '/rpc' || (bearer !== this.token && !workerAgentId)) {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_048_576) request.destroy(new Error('RPC request is too large'));
      });
      request.on('end', () => {
        void Promise.resolve().then(async () => {
          const input = JSON.parse(body) as Pick<RpcRequest, 'method' | 'params'>;
          const result = await this.handler({
            role: workerAgentId ? 'worker' : 'main',
            agentId: workerAgentId ?? 'main',
            method: input.method,
            params: input.params ?? {},
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result }));
        }).catch((error) => {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error: errorMessage(error) }));
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Control server has no TCP address');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    this.server = null;
    this.workerTokens.clear();
    this.agentTokens.clear();
  }
}
