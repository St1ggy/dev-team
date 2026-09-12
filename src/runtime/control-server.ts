import { createServer, type Server } from 'node:http';
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

  constructor(private readonly token: string, private readonly handler: RpcHandler) {}

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/rpc' || request.headers.authorization !== `Bearer ${this.token}`) {
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
          const result = await this.handler(JSON.parse(body) as RpcRequest);
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
  }
}
