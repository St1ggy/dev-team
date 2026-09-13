import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DevTeamConfig } from '../config/config.js';
import type { WorkerLaunch } from '../coordination/service.js';

export interface GatewayConnection {
  url: string;
  token: string;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export class OpenCodeLauncher {
  private readonly workers = new Map<string, ChildProcess>();
  private readonly cleanups = new Set<Promise<void>>();
  private cleanupError: unknown;

  constructor(
    private readonly config: DevTeamConfig,
    private readonly gateway: GatewayConnection,
    private readonly onWorkerExit: (agentId: string, exit: WorkerExit) => Promise<void>,
    private readonly deniedCommands: readonly string[],
  ) {}

  async launchWorker(worker: WorkerLaunch, gateway: GatewayConnection = this.gateway): Promise<number> {
    await mkdir(join(this.config.stateRoot, 'logs'), { recursive: true });
    const log = createWriteStream(join(this.config.stateRoot, 'logs', `${worker.agentId}.log`), { flags: 'a' });
    const args = ['run', '--dir', worker.cwd, '--agent', 'agent', '--auto', worker.prompt];
    if (this.config.model) args.splice(args.length - 1, 0, '--model', this.config.model);
    const child = spawn(this.config.opencodeCommand, args, {
      cwd: worker.cwd,
      env: this.environment('worker', worker.agentId, gateway),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    let finished = false;
    const finish = (exit: WorkerExit): void => {
      if (finished) return;
      finished = true;
      this.workers.delete(worker.agentId);
      const cleanup = this.onWorkerExit(worker.agentId, exit)
        .catch(async (error) => {
          this.cleanupError = error;
          await new Promise<void>((resolve) => log.end(`Worker cleanup failed: ${String(error)}\n`, resolve));
          throw error;
        })
        .finally(() => { if (!log.writableEnded) log.end(); });
      this.cleanups.add(cleanup);
      void cleanup.catch(() => undefined).finally(() => this.cleanups.delete(cleanup));
    };
    child.once('close', (code, signal) => finish({ code, signal }));
    child.once('error', (error) => {
      log.write(`OpenCode failed: ${error.message}\n`);
      finish({ code: null, signal: null, error: error.message });
    });
    this.workers.set(worker.agentId, child);
    return new Promise((resolve, reject) => {
      child.once('spawn', () => child.pid ? resolve(child.pid) : reject(new Error('OpenCode worker did not start')));
      child.once('error', reject);
    });
  }

  launchMain(projectPath: string, prompt: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = [projectPath, '--agent', 'orchestrator', '--prompt', prompt];
      if (this.config.model) args.push('--model', this.config.model);
      const child = spawn(this.config.opencodeCommand, args, {
        cwd: projectPath,
        env: this.environment('main', 'main', this.gateway),
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(code) : reject(new Error(`OpenCode orchestrator exited with code ${code}`)));
    });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.workers.values()].map((child) => terminate(child)));
    await Promise.allSettled([...this.cleanups]);
    if (this.cleanupError) throw this.cleanupError;
  }

  private environment(role: 'main' | 'worker', agentId: string, gateway: GatewayConnection): NodeJS.ProcessEnv {
    const command = gatewayCommand();
    const vcsDenied = Object.fromEntries(
      this.deniedCommands.flatMap((name) => [[name, 'deny'], [`${name} *`, 'deny']]),
    );
    const overlay = {
      mcp: {
        'dev-team': { type: 'local', command, enabled: true },
        atc: {
          type: 'local',
          command: atcMcpCommand(this.config.atcNodeCommand ?? process.execPath),
          cwd: this.config.projectPath,
          environment: { DB_PATH: this.config.atcDbPath },
          enabled: true,
        },
      },
      permission: {
        bash: vcsDenied,
        ...(role === 'main' ? { edit: 'deny' } : {}),
      },
      agent: {
        orchestrator: {
          description: 'Coordinate a dev-team delivery without editing project files directly.',
          mode: 'primary',
          prompt: 'Use the dev-team MCP tools to plan, dispatch, inspect, and review work. Never edit project files directly.',
          permission: { edit: 'deny', bash: vcsDenied },
        },
        agent: {
          description: 'Implement one assigned dev-team task in an isolated workspace.',
          mode: 'primary',
          prompt: 'Work only on the assigned task and use dev-team MCP tools for checkpoints and submission.',
          permission: { bash: vcsDenied },
        },
      },
    };
    return {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: mergeConfig(process.env.OPENCODE_CONFIG_CONTENT, overlay),
      DEV_TEAM_CONTROL_URL: gateway.url,
      DEV_TEAM_CONTROL_TOKEN: gateway.token,
      DEV_TEAM_ROLE: role,
      DEV_TEAM_AGENT_ID: agentId,
    };
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const closed = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      timer.unref();
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  await terminateWorkerProcess(child.pid);
  await closed;
}

export async function terminateWorkerProcess(pid: number): Promise<void> {
  signalProcess(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!processGroupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signalProcess(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!processGroupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worker process ${pid} did not stop`);
}

function signalProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function gatewayCommand(): string[] {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot determine dev-team CLI entry point');
  return entry.endsWith('.ts')
    ? [process.execPath, '--import', 'tsx', entry, 'gateway']
    : [process.execPath, entry, 'gateway'];
}

function atcMcpCommand(nodeCommand: string): string[] {
  const require = createRequire(import.meta.url);
  return [nodeCommand, require.resolve('atc-kanban/dist/index.js'), '--mcp'];
}

function mergeConfig(existing: string | undefined, overlay: Record<string, unknown>): string {
  if (!existing) return JSON.stringify(overlay);
  try {
    const base = JSON.parse(existing) as Record<string, unknown>;
    const basePermission = objectField(base.permission);
    const overlayPermission = objectField(overlay.permission);
    return JSON.stringify({
      ...base, ...overlay,
      mcp: { ...objectField(base.mcp), ...objectField(overlay.mcp) },
      agent: { ...objectField(base.agent), ...objectField(overlay.agent) },
      permission: {
        ...basePermission, ...overlayPermission,
        bash: { ...objectField(basePermission.bash), ...objectField(overlayPermission.bash) },
      },
    });
  } catch {
    throw new Error('Existing OPENCODE_CONFIG_CONTENT is not valid JSON');
  }
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
