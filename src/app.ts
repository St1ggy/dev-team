import { randomBytes } from 'node:crypto';
import { access, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { defaultAtcRuntimeRoot, type DevTeamConfig } from './config/config.js';
import { CoordinationService } from './coordination/service.js';
import { AtcHttpClient } from './coordination/atc-http.js';
import type { ProjectRecord } from './core/types.js';
import type { DevTeamPlugin } from './plugin.js';
import { GitProvider } from './providers/git-provider.js';
import { NoVcsProvider } from './providers/novcs-provider.js';
import { ProviderRegistry } from './providers/registry.js';
import { StateStore } from './state/store.js';
import { AtcDashboard } from './runtime/atc-dashboard.js';
import { AgentDaemon, AgentRunnerClient, isProcessAlive } from './runtime/agent-daemon.js';
import { ProcessCommandRunner } from './runtime/command-runner.js';
import { ControlServer, type RpcRequest } from './runtime/control-server.js';
import { OpenCodeLauncher, terminateWorkerProcess } from './runtime/opencode-launcher.js';

export interface RuntimeOptions {
  plugins?: readonly DevTeamPlugin[];
}

export interface AgentModeOptions extends RuntimeOptions {
  name: string;
}

export async function discoverProject(config: DevTeamConfig, options: RuntimeOptions = {}): Promise<{
  project: ProjectRecord;
  registry: ProviderRegistry;
  deniedCommands: string[];
}> {
  const runner = new ProcessCommandRunner();
  const pluginProviders = (options.plugins ?? []).flatMap((plugin) => plugin.createProviders({ runner }));
  const registry = new ProviderRegistry([...pluginProviders, new GitProvider(runner), new NoVcsProvider()]);
  const detected = await registry.detect(config.projectPath, config.provider);
  if (!detected.repository) throw new Error(`Cannot detect repository at ${config.projectPath}`);
  const project: ProjectRecord = {
    id: config.projectId, root: detected.repository.root,
    provider: detected.provider.kind, baseRef: config.baseRef ?? detected.repository.baseRef,
    projectRelativePath: detected.repository.projectRelativePath,
  };
  const deniedCommands = [...new Set(['git', 'jj', 'hg', ...(options.plugins ?? []).flatMap((plugin) => plugin.deniedCommands ?? [])])];
  return { project, registry, deniedCommands };
}

export async function doctor(config: DevTeamConfig, options: RuntimeOptions = {}): Promise<{ project: ProjectRecord; checks: Array<{ name: string; ok: boolean; message: string }> }> {
  const { project, registry } = await discoverProject(config, options);
  const checks = await registry.forProject(project).doctor(project);
  try {
    const atcNode = await resolveAtcNode(config, project.root);
    const version = await new ProcessCommandRunner().run(atcNode, ['--version'], { cwd: project.root });
    checks.push({ name: 'ATC Node.js', ok: version.stdout.trim().startsWith('v22.'), message: `${version.stdout.trim()} (${atcNode})` });
  } catch (error) {
    checks.push({ name: 'ATC Node.js', ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  const opencode = await new ProcessCommandRunner().run(config.opencodeCommand, ['--version'], { cwd: project.root, allowFailure: true }).catch(() => null);
  checks.push({
    name: 'OpenCode', ok: opencode?.code === 0,
    message: opencode?.code === 0 ? opencode.stdout.trim() : opencode?.stderr.trim() || `${config.opencodeCommand} not found`,
  });
  return { project, checks };
}

export async function start(config: DevTeamConfig, options: RuntimeOptions = {}): Promise<void> {
  await mkdir(config.stateRoot, { recursive: true });
  const { project, registry, deniedCommands } = await discoverProject(config, options);
  const provider = registry.forProject(project);
  const atcNode = await resolveAtcNode(config, project.root);
  const checks = (await doctor(config, options)).checks;
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) throw new Error(`Doctor failed:\n${failed.map((check) => `- ${check.name}: ${check.message}`).join('\n')}`);
  await migrateLegacyAtcDatabase(config);

  const store = new StateStore(join(config.stateRoot, 'state.sqlite'));
  store.upsertProject(project);
  const atcDb = config.atcDbPath;
  const atcUrl = `http://127.0.0.1:${config.port}`;
  const coordination = new CoordinationService(config, project, provider, store, atcDb, atcNode, atcUrl);
  const dashboard = new AtcDashboard(atcDb, defaultAtcRuntimeRoot(), config.port, atcNode);
  const token = randomBytes(32).toString('hex');
  let launcher: OpenCodeLauncher;
  let runnerWatchdog: NodeJS.Timeout | undefined;
  let runnerSweepActive = false;
  const runnerClient = new AgentRunnerClient();
  let gateway = { url: '', token };
  let control!: ControlServer;
  control = new ControlServer(token, async (request) => route(request, coordination, launcher, store, runnerClient, gateway, control));
  const controlUrl = await control.start();
  gateway = { url: controlUrl, token };
  launcher = new OpenCodeLauncher({ ...config, atcNodeCommand: atcNode }, gateway, async (agentId) => {
    await coordination.handleWorkerExit(agentId);
    control.revokeWorkerAgent(agentId);
  }, deniedCommands);

  try {
    const dashboardUrl = await dashboard.start();
    const atcProject = await new AtcHttpClient(dashboardUrl, config.atcDbPath).ensureProject(project.id, `dev-team: ${config.projectPath}`, project.baseRef);
    await coordination.start(atcProject.id);
    runnerWatchdog = setInterval(() => {
      if (runnerSweepActive) return;
      runnerSweepActive = true;
      void reapDeadRunners(store, coordination, control).catch(() => undefined).finally(() => { runnerSweepActive = false; });
    }, 5_000);
    runnerWatchdog.unref();
    process.stderr.write(`dev-team provider: ${project.provider}\nATC dashboard: ${dashboardUrl}\nState: ${config.stateRoot}\n`);
    await launcher.launchMain(config.projectPath, mainPrompt(project.provider, dashboardUrl));
  } finally {
    if (runnerWatchdog) clearInterval(runnerWatchdog);
    await launcher!.stop().catch(() => undefined);
    await Promise.allSettled(
      store.listRunners(project.id)
        .filter((runner) => runner.status === 'busy' && isProcessAlive(runner.processId))
        .map((runner) => runnerClient.cancel(runner)),
    );
    await coordination.stop().catch(() => undefined);
    await control.close().catch(() => undefined);
    store.close();
  }
}

export async function startAgentMode(config: DevTeamConfig, options: AgentModeOptions): Promise<void> {
  await mkdir(config.stateRoot, { recursive: true });
  const { project, deniedCommands } = await discoverProject(config, options);
  const checks = (await doctor(config, options)).checks;
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) throw new Error(`Doctor failed:\n${failed.map((check) => `- ${check.name}: ${check.message}`).join('\n')}`);
  const atcNode = await resolveAtcNode(config, project.root);
  await migrateLegacyAtcDatabase(config);
  const dashboard = new AtcDashboard(config.atcDbPath, defaultAtcRuntimeRoot(), config.port, atcNode);
  const dashboardUrl = await dashboard.start();
  const atcProject = await new AtcHttpClient(dashboardUrl, config.atcDbPath).ensureProject(project.id, `dev-team: ${config.projectPath}`, project.baseRef);
  const store = new StateStore(join(config.stateRoot, 'state.sqlite'));
  store.upsertProject(project);
  const daemon = new AgentDaemon({ ...config, atcNodeCommand: atcNode }, project, store, options.name, deniedCommands);
  const runner = await daemon.start();
  const stop = (): void => { void daemon.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.stderr.write(`dev-team agent: ${runner.name} (${runner.id})\nATC project: ${atcProject.id}\nATC dashboard: ${dashboardUrl}\n`);
    await daemon.wait();
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await daemon.stop().catch(() => undefined);
    store.close();
  }
}

export async function resolveAtcNode(config: DevTeamConfig, cwd: string): Promise<string> {
  const runner = new ProcessCommandRunner();
  const candidates: string[] = [];
  if (config.atcNodeCommand) candidates.push(config.atcNodeCommand);
  if (process.versions.node.startsWith('22.')) candidates.push(process.execPath);

  const mise = await runner.run('mise', ['where', 'node@22'], { cwd, allowFailure: true }).catch(() => null);
  if (mise?.code === 0 && mise.stdout.trim()) candidates.push(join(mise.stdout.trim(), 'bin', 'node'));
  candidates.push('/opt/homebrew/opt/node@22/bin/node', join(homedir(), '.local', 'bin', 'node22'));

  for (const candidate of [...new Set(candidates)]) {
    if (candidate.includes('/') && !(await access(candidate).then(() => true).catch(() => false))) continue;
    const version = await runner.run(candidate, ['--version'], { cwd, allowFailure: true }).catch(() => null);
    if (version?.code === 0 && version.stdout.trim().startsWith('v22.')) return candidate;
  }
  throw new Error('ATC requires Node.js 22. Set --atc-node or DEV_TEAM_ATC_NODE to a Node 22 executable.');
}

async function route(
  request: RpcRequest,
  service: CoordinationService,
  launcher: OpenCodeLauncher,
  store: StateStore,
  runnerClient: AgentRunnerClient,
  gateway: { url: string; token: string },
  control: ControlServer,
): Promise<unknown> {
  const p = request.params;
  if (request.role === 'main') {
    switch (request.method) {
      case 'create_delivery': return service.createDelivery(p as Parameters<CoordinationService['createDelivery']>[0]);
      case 'create_work': return service.createWork(p as Parameters<CoordinationService['createWork']>[0]);
      case 'set_dependencies': return service.setDependencies(String(p.taskId), p.dependsOn as string[]);
      case 'list_tasks': return service.listTasks();
      case 'wait_tasks': return service.waitForTasks(p.taskIds as string[], p.statuses as string[], Number(p.timeoutSeconds));
      case 'list_runners': {
        await reapDeadRunners(store, service, control);
        const result: Array<{ id: string; name: string; status: string; processId: number }> = [];
        for (const runner of store.listRunners(service.project.id)) {
          const alive = isProcessAlive(runner.processId);
          result.push({ id: runner.id, name: runner.name, status: alive ? runner.status : 'offline', processId: runner.processId });
        }
        return result;
      }
      case 'dispatch': {
        const worker = await service.dispatch(String(p.taskId));
        const runnerId = typeof p.runnerId === 'string' ? p.runnerId : undefined;
        const workerToken = control.issueWorkerToken(worker.agentId);
        const workerGateway = { url: gateway.url, token: workerToken };
        try {
          let pid: number;
          if (runnerId) {
            const runner = store.getRunner(runnerId);
            if (runner.projectId !== service.project.id || !isProcessAlive(runner.processId)) throw new Error(`Agent runner is unavailable: ${runnerId}`);
            if (!store.reserveRunner(runnerId, worker.agentId)) throw new Error(`Agent runner is not idle: ${runnerId}`);
            pid = await runnerClient.assign(store.getRunner(runnerId), { worker, gateway: workerGateway });
          } else {
            pid = await launcher.launchWorker(worker, workerGateway);
          }
          service.attachProcess(worker.agentId, pid);
          return { ...worker, pid, runnerId: runnerId ?? null };
        } catch (error) {
          if (runnerId) store.releaseRunner(runnerId, worker.agentId);
          control.revokeWorkerToken(workerToken);
          await service.handleWorkerExit(worker.agentId);
          throw error;
        }
      }
      case 'review': return service.review(String(p.taskId), p.verdict as 'approve' | 'reject', p.comment as string | undefined);
      case 'diff': return service.diff(String(p.taskId));
      case 'scope_diff': return service.scopeDiff(String(p.scopeId));
      case 'recovery_status': return service.recoverableOperations();
      default: throw new Error(`Unknown main RPC method: ${request.method}`);
    }
  }
  switch (request.method) {
    case 'worker_task': {
      return service.getTask(service.agentTaskId(request.agentId));
    }
    case 'progress': return service.progress(request.agentId, String(p.message));
    case 'checkpoint': return service.checkpoint(request.agentId);
    case 'worker_diff': return service.diff(service.agentTaskId(request.agentId));
    case 'submit': return service.submit(request.agentId);
    case 'release': return service.release(request.agentId, p.reason as string | undefined);
    case 'worker_exit': {
      await service.handleWorkerExit(request.agentId);
      store.releaseRunnerByAgent(request.agentId);
      control.revokeWorkerAgent(request.agentId);
      return { ok: true };
    }
    default: throw new Error(`Unknown worker RPC method: ${request.method}`);
  }
}

async function reapDeadRunners(store: StateStore, service: CoordinationService, control: ControlServer): Promise<void> {
  for (const runner of store.listRunners(service.project.id)) {
    if (runner.status !== 'offline' && isProcessAlive(runner.processId)) continue;
    store.touchRunner(runner.id, 'offline');
    if (!runner.currentAgentId) continue;
    const agent = store.getAgent(runner.currentAgentId);
    if (agent.processId && isProcessAlive(agent.processId)) await terminateWorkerProcess(agent.processId);
    control.revokeWorkerAgent(runner.currentAgentId);
    await service.handleWorkerExit(runner.currentAgentId);
    store.releaseRunnerByAgent(runner.currentAgentId);
    store.touchRunner(runner.id, 'offline');
  }
}

async function migrateLegacyAtcDatabase(config: DevTeamConfig): Promise<void> {
  const sourcePath = resolve(config.stateRoot, 'atc.sqlite');
  const targetPath = resolve(config.atcDbPath);
  if (sourcePath === targetPath || !await access(sourcePath).then(() => true).catch(() => false)) return;

  const source = new Database(sourcePath, { readonly: true });
  let migrated = false;
  try {
    const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'tasks')").all() as Array<{ name: string }>;
    const hasData = tables.some(({ name }) => (source.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count > 0);
    if (!hasData) return;
    if (await access(targetPath).then(() => true).catch(() => false)) {
      throw new Error(`Legacy ATC data exists at ${sourcePath}, but the shared database ${targetPath} already exists. Back up both databases and choose which one to use with dev-team global setup.`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    source.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
    migrated = true;
  } finally {
    source.close();
  }
  if (migrated) await rename(sourcePath, `${sourcePath}.migrated`);
}

function mainPrompt(provider: string, dashboardUrl: string): string {
  return [
    'You are the dev-team orchestrator. Do not edit project files directly and do not run VCS commands.',
    'Use only dev-team MCP tools to create delivery scopes, split work into small tasks, set dependencies, dispatch workers, inspect diffs, and review results.',
    'Use worker_list to discover manually started agent daemons. Prefer an idle daemon by passing its runner_id to worker_dispatch; omit runner_id to spawn a local worker.',
    'Create an explicit delivery task for every final or milestone pull request. Make it depend on all work tasks in that scope.',
    `The active provider is ${provider}. The ATC dashboard is ${dashboardUrl}.`,
  ].join('\n\n');
}
