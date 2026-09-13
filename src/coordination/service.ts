import { join } from 'node:path';
import type { DevTeamConfig } from '../config/config.js';
import { DevTeamError, errorMessage } from '../core/errors.js';
import { newId, stableId } from '../core/ids.js';
import type { ProjectRecord, ScopeRecord, TaskKind, TaskRecord, WorkspaceRecord } from '../core/types.js';
import type { VcsProvider } from '../providers/provider.js';
import { StateStore } from '../state/store.js';
import { AtcClient } from './atc-client.js';
import { AtcHttpClient } from './atc-http.js';

interface ActiveAgent {
  id: string;
  taskId: string;
  client: AtcClient;
  lockToken: string;
  workspace: WorkspaceRecord;
}

export interface WorkerLaunch {
  agentId: string;
  taskId: string;
  cwd: string;
  prompt: string;
}

export class CoordinationService {
  private readonly mainAtc: AtcClient;
  private readonly atcHttp: AtcHttpClient;
  private readonly agents = new Map<string, ActiveAgent>();
  private readonly preparingTasks = new Set<string>();
  private readonly scopeLocks = new Map<string, Promise<void>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private atcProjectId: string | null = null;

  constructor(
    readonly config: DevTeamConfig,
    readonly project: ProjectRecord,
    private readonly provider: VcsProvider,
    private readonly store: StateStore,
    private readonly atcDbPath: string,
    private readonly atcNodeCommand: string,
    atcUrl?: string,
  ) {
    this.mainAtc = new AtcClient(atcDbPath, project.root, atcNodeCommand);
    this.atcHttp = new AtcHttpClient(atcUrl ?? `http://127.0.0.1:${config.port}`);
  }

  async start(atcProjectId: string): Promise<void> {
    this.atcProjectId = atcProjectId;
    await this.mainAtc.connect(`dev-team-orchestrator-${this.project.id.slice(-8)}`, 'main', atcProjectId);
    this.heartbeat = setInterval(() => void this.renewAgents(), 10 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await Promise.allSettled([...this.agents.keys()].map((agentId) => this.handleWorkerExit(agentId)));
    await this.mainAtc.close();
  }

  async createDelivery(input: { title: string; description?: string; priority?: string }): Promise<{ scope: ScopeRecord; task: Record<string, unknown> }> {
    const scopeId = newId('scope');
    if (!this.atcProjectId) throw new DevTeamError('ATC_NOT_STARTED', 'Coordination service has no ATC project');
    const task = await this.atcHttp.createTask(this.atcProjectId, {
      title: input.title, labels: ['kind:delivery', `scope:${scopeId}`], requiresReview: true,
      ...(input.description ? { description: input.description } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
    });
    const taskId = taskIdOf(task);
    const aggregate = await this.provider.createWorkspace({
      project: this.project, scopeId, kind: 'aggregate',
      workspaceRoot: join(this.config.stateRoot, 'workspaces', `delivery-${scopeId}`),
    });
    this.store.putWorkspace(aggregate);
    const scope: ScopeRecord = {
      id: scopeId, projectId: this.project.id, title: input.title,
      deliveryTaskId: taskId, aggregateWorkspaceId: aggregate.id, status: 'active',
    };
    this.store.putScope(scope);
    this.store.putTask(emptyTask(taskId, scopeId, 'delivery', aggregate.id));
    return { scope, task };
  }

  async createWork(input: { scopeId: string; title: string; description?: string; priority?: string; dependsOn?: string[] }): Promise<Record<string, unknown>> {
    this.store.getScope(input.scopeId);
    for (const dependency of input.dependsOn ?? []) this.store.getTask(dependency);
    if (!this.atcProjectId) throw new DevTeamError('ATC_NOT_STARTED', 'Coordination service has no ATC project');
    const task = await this.atcHttp.createTask(this.atcProjectId, {
      title: input.title, labels: ['kind:work', `scope:${input.scopeId}`], requiresReview: true,
      ...(input.description ? { description: input.description } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
    });
    const taskId = taskIdOf(task);
    this.store.putTask(emptyTask(taskId, input.scopeId, 'work', null));
    return task;
  }

  async setDependencies(taskId: string, dependsOn: string[]): Promise<void> {
    this.store.getTask(taskId);
    for (const dependency of dependsOn) this.store.getTask(dependency);
    await this.mainAtc.setDependencies(taskId, dependsOn);
  }

  async listTasks(): Promise<Record<string, unknown>[]> {
    if (!this.atcProjectId) throw new DevTeamError('ATC_NOT_STARTED', 'Coordination service has no ATC project');
    return this.atcHttp.listTasks(this.atcProjectId);
  }

  async waitForTasks(taskIds: string[], statuses: string[], timeoutSeconds: number): Promise<Record<string, unknown>[]> {
    for (const taskId of taskIds) this.store.getTask(taskId);
    const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 1), 3600) * 1000;
    while (true) {
      const tasks = await Promise.all(taskIds.map((taskId) => this.mainAtc.getTask(taskId)));
      if (tasks.every((task) => statuses.includes(String(task.status)))) return tasks;
      if (Date.now() >= deadline) return tasks;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  getTask(taskId: string): Promise<Record<string, unknown>> {
    this.store.getTask(taskId);
    return this.mainAtc.getTask(taskId);
  }

  agentTaskId(agentId: string): string {
    const taskId = this.store.getAgent(agentId).taskId;
    if (!taskId) throw new DevTeamError('AGENT_HAS_NO_TASK', `Agent ${agentId} has no task`);
    return taskId;
  }

  async dispatch(taskId: string): Promise<WorkerLaunch> {
    if (this.agents.size + this.preparingTasks.size >= this.config.workers) {
      throw new DevTeamError('WORKER_LIMIT', `Worker limit reached (${this.config.workers})`);
    }
    if (this.preparingTasks.has(taskId) || [...this.agents.values()].some((agent) => agent.taskId === taskId)) {
      throw new DevTeamError('TASK_ALREADY_DISPATCHED', `Task is already dispatched: ${taskId}`);
    }
    this.preparingTasks.add(taskId);
    try {
      return await this.prepareDispatch(taskId);
    } finally {
      this.preparingTasks.delete(taskId);
    }
  }

  private async prepareDispatch(taskId: string): Promise<WorkerLaunch> {
    const task = this.store.getTask(taskId);
    const scope = this.store.getScope(task.scopeId);
    let workspace = task.workspaceId ? this.store.getWorkspace(task.workspaceId) : null;
    if (!workspace) {
      if (!scope.aggregateWorkspaceId) throw new DevTeamError('NO_AGGREGATE', `Scope ${scope.id} has no aggregate workspace`);
      const aggregate = this.store.getWorkspace(scope.aggregateWorkspaceId);
      workspace = await this.provider.createWorkspace({
        project: this.project, scopeId: scope.id, taskId, kind: 'task', baseWorkspace: aggregate,
        workspaceRoot: join(this.config.stateRoot, 'workspaces', `task-${taskId}`),
      });
      this.store.putWorkspace(workspace);
      this.store.putTask({ ...task, workspaceId: workspace.id });
    }

    const agentId = newId('agent');
    const client = new AtcClient(this.atcDbPath, workspace.projectPath, this.atcNodeCommand);
    if (!this.atcProjectId) throw new DevTeamError('ATC_NOT_STARTED', 'Coordination service has no ATC project');
    await client.connect(`worker-${agentId.slice(-8)}`, 'worker', this.atcProjectId);
    let claim: Awaited<ReturnType<AtcClient['claimTask']>>;
    try {
      claim = await client.claimTask(taskId);
    } catch (error) {
      await client.close();
      throw error;
    }
    const active: ActiveAgent = { id: agentId, taskId, client, lockToken: claim.lock_token, workspace };
    this.agents.set(agentId, active);
    this.store.putAgent({
      id: agentId, taskId, role: 'worker', atcToken: null,
      lockToken: null, processId: null, status: 'active', workspaceId: workspace.id,
    });
    return {
      agentId, taskId, cwd: workspace.projectPath,
      prompt: workerPrompt(claim.task, scope, task.kind),
    };
  }

  attachProcess(agentId: string, pid: number): void {
    if (!this.agents.has(agentId)) return;
    const agent = this.store.getAgent(agentId);
    this.store.putAgent({ ...agent, processId: pid });
  }

  async handleWorkerExit(agentId: string): Promise<void> {
    const active = this.agents.get(agentId);
    if (!active) return;
    try {
      const task = await active.client.getTask(active.taskId);
      if (task.status === 'in_progress') await active.client.release(active.taskId, active.lockToken, 'worker process exited');
    } catch {
      // ATC lock expiry remains the final recovery mechanism.
    }
    const agent = this.store.getAgent(agentId);
    this.store.putAgent({ ...agent, status: 'disconnected', processId: null });
    await active.client.close();
    this.agents.delete(agentId);
  }

  async progress(agentId: string, message: string): Promise<void> {
    const agent = this.activeAgent(agentId);
    await agent.client.progress(agent.taskId, agent.lockToken, message);
  }

  async checkpoint(agentId: string): Promise<unknown> {
    const agent = this.activeAgent(agentId);
    const task = this.store.getTask(agent.taskId);
    const checkpoint = await this.provider.checkpoint(
      this.project, agent.workspace,
      `Checkpoint task ${agent.taskId}\n\ndev-team-task: ${agent.taskId}`,
    );
    this.store.putTask({ ...task, checkpoint: JSON.stringify(checkpoint) });
    return checkpoint;
  }

  async diff(taskId: string): Promise<unknown> {
    const task = this.store.getTask(taskId);
    if (!task.workspaceId) throw new DevTeamError('NO_WORKSPACE', `Task ${taskId} has no workspace`);
    return this.provider.diff(this.project, this.store.getWorkspace(task.workspaceId));
  }

  async scopeDiff(scopeId: string): Promise<unknown> {
    const scope = this.store.getScope(scopeId);
    if (!scope.aggregateWorkspaceId) throw new DevTeamError('NO_AGGREGATE', `Scope ${scopeId} has no aggregate workspace`);
    return this.provider.diff(this.project, this.store.getWorkspace(scope.aggregateWorkspaceId));
  }

  async submit(agentId: string): Promise<Record<string, unknown>> {
    const agent = this.activeAgent(agentId);
    const task = this.store.getTask(agent.taskId);
    const checkpoint = await this.checkpoint(agentId);
    const submission = await this.provider.submit({
      project: this.project, workspace: agent.workspace,
      title: `Task ${agent.taskId}`, body: 'Private dev-team task submission', final: false,
    });
    const updatedWorkspace = submission.kind === 'remote-branch'
      ? { ...agent.workspace, metadata: JSON.stringify({ remoteRef: submission.reference, revision: submission.revision }) }
      : agent.workspace;
    if (updatedWorkspace !== agent.workspace) {
      agent.workspace = updatedWorkspace;
      this.store.putWorkspace(updatedWorkspace);
    }
    this.store.putTask({ ...task, checkpoint: JSON.stringify(checkpoint), submission: JSON.stringify(submission) });
    return agent.client.submitForReview(agent.taskId, agent.lockToken);
  }

  async release(agentId: string, reason?: string): Promise<void> {
    const agent = this.activeAgent(agentId);
    await agent.client.release(agent.taskId, agent.lockToken, reason);
  }

  async review(taskId: string, verdict: 'approve' | 'reject', comment?: string): Promise<Record<string, unknown>> {
    const task = this.store.getTask(taskId);
    if (verdict === 'reject') return this.mainAtc.review(taskId, verdict, comment);
    return this.withScopeLock(task.scopeId, async () => {
      const checkpoint = task.checkpoint ? (JSON.parse(task.checkpoint) as { revision: string }).revision : 'none';
      const operationId = stableId('op', `approve:${taskId}:${checkpoint}`);
      const operation = this.store.getOperation(operationId);
      let providerResult = operation?.result;
      if (!operation || operation.status === 'prepared' || operation.status === 'failed_recoverable') {
        this.store.beginOperation(operationId, 'approve', taskId, { taskId, checkpoint });
        try {
          providerResult = task.kind === 'work'
            ? await this.integrateWork(task)
            : await this.submitDelivery(task, comment);
          this.store.finishOperation(operationId, 'provider_done', providerResult);
        } catch (error) {
          this.store.finishOperation(operationId, 'failed_recoverable', undefined, errorMessage(error));
          throw error;
        }
      }
      let reviewed: Record<string, unknown>;
      try {
        reviewed = await this.mainAtc.review(taskId, 'approve', comment);
      } catch (error) {
        const current = await this.mainAtc.getTask(taskId).catch(() => null);
        if (current?.status !== 'done') throw error;
        reviewed = current;
      }
      this.store.finishOperation(operationId, 'complete', { providerResult, reviewed });
      return reviewed;
    });
  }

  recoverableOperations(): unknown {
    return this.store.listRecoverableOperations();
  }

  private async integrateWork(task: TaskRecord): Promise<unknown> {
    if (!task.workspaceId) throw new DevTeamError('NO_WORKSPACE', `Task ${task.taskId} has no workspace`);
    const scope = this.store.getScope(task.scopeId);
    if (!scope.aggregateWorkspaceId) throw new DevTeamError('NO_AGGREGATE', `Scope ${scope.id} has no aggregate workspace`);
    const source = this.store.getWorkspace(task.workspaceId);
    const aggregate = this.store.getWorkspace(scope.aggregateWorkspaceId);
    const receipt = await this.provider.integrate(this.project, source, aggregate);
    this.store.putTask({ ...task, integration: JSON.stringify(receipt) });
    return receipt;
  }

  private async submitDelivery(task: TaskRecord, body?: string): Promise<unknown> {
    if (!task.workspaceId) throw new DevTeamError('NO_WORKSPACE', `Delivery task ${task.taskId} has no workspace`);
    const workspace = this.store.getWorkspace(task.workspaceId);
    const checkpoint = await this.provider.checkpoint(this.project, workspace, `Deliver ${task.scopeId}\n\ndev-team-delivery: ${task.scopeId}`);
    const scope = this.store.getScope(task.scopeId);
    const submission = await this.provider.submit({
      project: this.project, workspace, title: scope.title,
      body: body ?? `Delivery scope ${scope.id}`, final: true,
    });
    const application = this.project.provider === 'novcs'
      ? await this.provider.applyDelivery(this.project, workspace)
      : null;
    this.store.putTask({ ...task, checkpoint: JSON.stringify(checkpoint), submission: JSON.stringify(submission), integration: application ? JSON.stringify(application) : task.integration });
    return { checkpoint, submission, application };
  }

  private activeAgent(agentId: string): ActiveAgent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new DevTeamError('AGENT_NOT_ACTIVE', `Agent is not active: ${agentId}`);
    return agent;
  }

  private async renewAgents(): Promise<void> {
    await Promise.allSettled([...this.agents.values()].map((agent) => agent.client.progress(agent.taskId, agent.lockToken, '[dev-team lease renewal]')));
    await this.mainAtc.heartbeat().catch(() => undefined);
  }

  private async withScopeLock<T>(scopeId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.scopeLocks.get(scopeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.scopeLocks.set(scopeId, queued);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.scopeLocks.get(scopeId) === queued) this.scopeLocks.delete(scopeId);
    }
  }
}

function emptyTask(taskId: string, scopeId: string, kind: TaskKind, workspaceId: string | null): TaskRecord {
  return { taskId, scopeId, kind, workspaceId, checkpoint: null, submission: null, integration: null };
}

function taskIdOf(task: Record<string, unknown>): string {
  if (typeof task.id !== 'string') throw new DevTeamError('ATC_INVALID_TASK', 'ATC task response has no id');
  return task.id;
}

function workerPrompt(task: Record<string, unknown>, scope: ScopeRecord, kind: TaskKind): string {
  return [
    `You are a dev-team ${kind} worker for task ${String(task.id)} in delivery scope ${scope.id}.`,
    `Task: ${String(task.title ?? '')}`,
    String(task.description ?? ''),
    'Work only inside the current workspace. Do not run version control commands directly.',
    'Use the dev-team MCP tools for progress, checkpoint, diff, and submission.',
    'When implementation and verification are complete, call task_submit.',
  ].filter(Boolean).join('\n\n');
}
