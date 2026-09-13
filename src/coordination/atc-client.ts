import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DevTeamError } from '../core/errors.js';

interface AtcRegistration {
  agent_id: string;
  agent_token: string;
}

export class AtcClient {
  private readonly client = new Client({ name: 'dev-team', version: '0.1.0' });
  private transport: StdioClientTransport | null = null;
  private registration: AtcRegistration | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly cwd: string,
    private readonly nodeCommand: string,
  ) {}

  async connect(name: string, role: 'main' | 'worker', projectId?: string): Promise<AtcRegistration> {
    const require = createRequire(import.meta.url);
    const server = require.resolve('atc-kanban/dist/index.js');
    this.transport = new StdioClientTransport({
      command: this.nodeCommand,
      args: [server, '--mcp'],
      cwd: this.cwd,
      env: cleanEnvironment({ DB_PATH: this.dbPath }),
      stderr: 'pipe',
    });
    await this.client.connect(this.transport);
    let registration: AtcRegistration & { agentId?: string; agentToken?: string };
    try {
      registration = await this.call<AtcRegistration & { agentId?: string; agentToken?: string }>('register_agent', {
        name, role, agent_type: 'opencode', workspace_mode: 'disabled',
        ...(projectId ? { project_id: projectId } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) {
        throw new DevTeamError(
          'ATC_DB_MISMATCH',
          `The running ATC server and MCP client use different databases. Set --atc-db to the server DB_PATH (current: ${this.dbPath}).`,
        );
      }
      throw error;
    }
    this.registration = {
      agent_id: registration.agent_id ?? registration.agentId ?? '',
      agent_token: registration.agent_token ?? registration.agentToken ?? '',
    };
    if (!this.registration.agent_id || !this.registration.agent_token) {
      throw new DevTeamError('ATC_INVALID_REGISTRATION', 'ATC registration response has no agent id or token', registration);
    }
    return this.registration;
  }

  async close(): Promise<void> {
    await this.client.close();
    this.transport = null;
  }

  async heartbeat(): Promise<unknown> {
    return this.call('heartbeat', { agent_token: this.token });
  }

  async createTask(input: { title: string; description?: string; priority?: string; labels?: string[]; dependsOn?: string[]; requiresReview?: boolean }): Promise<Record<string, unknown>> {
    const value = await this.call<{ task: Record<string, unknown> }>('create_task', {
      main_token: this.token, title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.dependsOn ? { depends_on: input.dependsOn } : {}),
      requires_review: input.requiresReview ?? true,
    });
    return value.task;
  }

  async setDependencies(taskId: string, dependsOn: string[]): Promise<void> {
    await this.call('set_dependency', { main_token: this.token, task_id: taskId, depends_on: dependsOn });
  }

  async listTasks(status?: string[]): Promise<Record<string, unknown>[]> {
    const value = await this.call<{ tasks: Record<string, unknown>[] }>('list_tasks', status ? { status } : {});
    return value.tasks;
  }

  async getTask(taskId: string): Promise<Record<string, unknown>> {
    const value = await this.call<{ task: Record<string, unknown> }>('get_task', { task_id: taskId });
    return value.task;
  }

  async claimTask(taskId: string): Promise<{ lock_token: string; task: Record<string, unknown> }> {
    return this.call('claim_task', { agent_token: this.token, task_id: taskId });
  }

  async progress(taskId: string, lockToken: string, message: string): Promise<void> {
    await this.call('report_progress', { lock_token: lockToken, task_id: taskId, message });
  }

  async submitForReview(taskId: string, lockToken: string): Promise<Record<string, unknown>> {
    const value = await this.call<{ task: Record<string, unknown> }>('update_status', { lock_token: lockToken, task_id: taskId, status: 'review' });
    return value.task;
  }

  async release(taskId: string, lockToken: string, reason?: string): Promise<void> {
    await this.call('release_task', { lock_token: lockToken, task_id: taskId, ...(reason ? { reason } : {}) });
  }

  async review(taskId: string, verdict: 'approve' | 'reject', comment?: string): Promise<Record<string, unknown>> {
    const value = await this.call<{ task: Record<string, unknown> }>('review_task', {
      main_token: this.token, task_id: taskId, verdict, ...(comment ? { comment } : {}),
    });
    return value.task;
  }

  private get token(): string {
    if (!this.registration) throw new DevTeamError('ATC_NOT_CONNECTED', 'ATC agent is not registered');
    return this.registration.agent_token;
  }

  private async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) throw new DevTeamError('ATC_TOOL_FAILED', textContent(result.content));
    const text = textContent(result.content);
    try { return JSON.parse(text) as T; }
    catch { throw new DevTeamError('ATC_INVALID_RESPONSE', `Invalid response from ${name}: ${text}`); }
  }
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content);
  return content.filter((item): item is { type: 'text'; text: string } => Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'text')).map((item) => item.text).join('\n');
}

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
