import { randomBytes } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DevTeamConfig } from './config/config.js';
import { CoordinationService } from './coordination/service.js';
import { AtcHttpClient } from './coordination/atc-http.js';
import { stableId } from './core/ids.js';
import type { ProjectRecord } from './core/types.js';
import type { DevTeamPlugin } from './plugin.js';
import { GitProvider } from './providers/git-provider.js';
import { NoVcsProvider } from './providers/novcs-provider.js';
import { ProviderRegistry } from './providers/registry.js';
import { StateStore } from './state/store.js';
import { AtcDashboard } from './runtime/atc-dashboard.js';
import { ProcessCommandRunner } from './runtime/command-runner.js';
import { ControlServer, type RpcRequest } from './runtime/control-server.js';
import { OpenCodeLauncher } from './runtime/opencode-launcher.js';

export interface RuntimeOptions {
  plugins?: readonly DevTeamPlugin[];
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
    id: stableId('project', config.projectPath), root: detected.repository.root,
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

  const store = new StateStore(join(config.stateRoot, 'state.sqlite'));
  store.upsertProject(project);
  const atcDb = join(config.stateRoot, 'atc.sqlite');
  const coordination = new CoordinationService(config, project, provider, store, atcDb, atcNode);
  const dashboard = new AtcDashboard(atcDb, config.stateRoot, config.port, atcNode);
  const token = randomBytes(32).toString('hex');
  let launcher: OpenCodeLauncher;
  const control = new ControlServer(token, async (request) => route(request, coordination, launcher));
  const controlUrl = await control.start();
  launcher = new OpenCodeLauncher(config, { url: controlUrl, token }, async (agentId) => coordination.handleWorkerExit(agentId), deniedCommands);

  try {
    const dashboardUrl = await dashboard.start();
    const atcProject = await new AtcHttpClient(dashboardUrl).ensureProject(project.id, `dev-team: ${config.projectPath}`, project.baseRef);
    await coordination.start(atcProject.id);
    process.stderr.write(`dev-team provider: ${project.provider}\nATC dashboard: ${dashboardUrl}\nState: ${config.stateRoot}\n`);
    await launcher.launchMain(config.projectPath, mainPrompt(project.provider, dashboardUrl));
  } finally {
    await launcher!.stop().catch(() => undefined);
    await coordination.stop().catch(() => undefined);
    dashboard.stop();
    await control.close().catch(() => undefined);
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

async function route(request: RpcRequest, service: CoordinationService, launcher: OpenCodeLauncher): Promise<unknown> {
  const p = request.params;
  if (request.role === 'main') {
    switch (request.method) {
      case 'create_delivery': return service.createDelivery(p as Parameters<CoordinationService['createDelivery']>[0]);
      case 'create_work': return service.createWork(p as Parameters<CoordinationService['createWork']>[0]);
      case 'set_dependencies': return service.setDependencies(String(p.taskId), p.dependsOn as string[]);
      case 'list_tasks': return service.listTasks();
      case 'dispatch': {
        const worker = await service.dispatch(String(p.taskId));
        const pid = await launcher.launchWorker(worker);
        service.attachProcess(worker.agentId, pid);
        return { ...worker, pid };
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
    default: throw new Error(`Unknown worker RPC method: ${request.method}`);
  }
}

function mainPrompt(provider: string, dashboardUrl: string): string {
  return [
    'You are the dev-team orchestrator. Do not edit project files directly and do not run VCS commands.',
    'Use only dev-team MCP tools to create delivery scopes, split work into small tasks, set dependencies, dispatch workers, inspect diffs, and review results.',
    'Create an explicit delivery task for every final or milestone pull request. Make it depend on all work tasks in that scope.',
    `The active provider is ${provider}. The ATC dashboard is ${dashboardUrl}.`,
  ].join('\n\n');
}
