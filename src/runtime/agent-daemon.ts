import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { DevTeamConfig } from '../config/config.js';
import type { ProjectRecord } from '../core/types.js';
import type { WorkerLaunch } from '../coordination/service.js';
import { newId } from '../core/ids.js';
import { StateStore, type AgentRunnerRecord } from '../state/store.js';
import { OpenCodeLauncher, type GatewayConnection, type WorkerExit } from './opencode-launcher.js';

export interface AgentAssignment {
  worker: WorkerLaunch;
  gateway: GatewayConnection;
}

export class AgentDaemon {
  private server: Server | null = null;
  private launcher: OpenCodeLauncher | null = null;
  private activeAgentId: string | null = null;
  private cleanupFailed = false;
  private readonly id = newId('runner');
  private readonly token = randomBytes(32).toString('hex');
  private stopPromise: Promise<void>;
  private resolveStop!: () => void;

  constructor(
    private readonly config: DevTeamConfig,
    private readonly project: ProjectRecord,
    private readonly store: StateStore,
    private readonly name: string,
    private readonly deniedCommands: readonly string[],
  ) {
    this.stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });
  }

  async start(): Promise<AgentRunnerRecord> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Agent daemon has no TCP address');
    const runner: AgentRunnerRecord = {
      id: this.id,
      projectId: this.project.id,
      name: this.name,
      url: `http://127.0.0.1:${address.port}`,
      token: this.token,
      processId: process.pid,
      status: 'idle',
      currentAgentId: null,
      updatedAt: new Date().toISOString(),
    };
    this.store.putRunner(runner);
    return runner;
  }

  wait(): Promise<void> {
    return this.stopPromise;
  }

  async stop(): Promise<void> {
    await this.launcher?.stop().catch(() => { this.cleanupFailed = true; });
    this.launcher = null;
    this.activeAgentId = null;
    if (this.cleanupFailed) this.store.touchRunner(this.id, 'offline');
    else this.store.removeRunner(this.id);
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.resolveStop();
  }

  private async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: this.id, projectId: this.project.id, busy: Boolean(this.activeAgentId) }));
      return;
    }
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/cancel') {
      await this.launcher?.stop();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url !== '/assign') {
      response.writeHead(404).end();
      return;
    }
    if (this.activeAgentId) {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Agent daemon is busy' }));
      return;
    }
    const assignment = JSON.parse(await readBody(request)) as AgentAssignment;
    const reserved = this.store.getRunner(this.id);
    if (reserved.status !== 'busy' || reserved.currentAgentId !== assignment.worker.agentId) {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Agent daemon has no matching reservation' }));
      return;
    }
    this.activeAgentId = assignment.worker.agentId;
    this.launcher = new OpenCodeLauncher(
      this.config,
      assignment.gateway,
      (agentId, exit) => this.complete(assignment.gateway, agentId, exit),
      this.deniedCommands,
    );
    try {
      const pid = await this.launcher.launchWorker(assignment.worker);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ pid }));
    } catch (error) {
      this.store.releaseRunner(this.id, assignment.worker.agentId);
      this.activeAgentId = null;
      this.launcher = null;
      throw error;
    }
  }

  private async complete(gateway: GatewayConnection, agentId: string, exit: WorkerExit): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${gateway.url}/rpc`, {
          method: 'POST',
          headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'worker', agentId, method: 'worker_exit', params: exit }),
          signal: AbortSignal.timeout(5_000),
        });
        if (attempt > 0 && response.status === 404) {
          this.store.releaseRunner(this.id, agentId);
          this.activeAgentId = null;
          this.launcher = null;
          return;
        }
        if (!response.ok) throw new Error(`Worker cleanup callback failed with HTTP ${response.status}: ${await response.text()}`);
        this.store.releaseRunner(this.id, agentId);
        this.activeAgentId = null;
        this.launcher = null;
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    this.cleanupFailed = true;
    this.store.touchRunner(this.id, 'offline');
    this.resolveStop();
    throw lastError;
  }
}

export class AgentRunnerClient {
  async assign(runner: AgentRunnerRecord, assignment: AgentAssignment): Promise<number> {
    const response = await fetch(`${runner.url}/assign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(assignment),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null) as { pid?: number; error?: string } | null;
    if (!response.ok || !body?.pid) throw new Error(body?.error ?? `Agent daemon ${runner.name} rejected the assignment`);
    return body.pid;
  }

  async cancel(runner: AgentRunnerRecord): Promise<void> {
    const response = await fetch(`${runner.url}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runner.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Agent daemon ${runner.name} rejected cancellation`);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_048_576) throw new Error('Request body is too large');
  }
  return body;
}
