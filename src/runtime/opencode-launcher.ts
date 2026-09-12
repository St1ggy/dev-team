import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevTeamConfig } from '../config/config.js';
import type { WorkerLaunch } from '../coordination/service.js';

interface GatewayConnection {
  url: string;
  token: string;
}

export class OpenCodeLauncher {
  private readonly workers = new Map<string, ChildProcess>();

  constructor(
    private readonly config: DevTeamConfig,
    private readonly gateway: GatewayConnection,
    private readonly onWorkerExit: (agentId: string) => Promise<void>,
    private readonly deniedCommands: readonly string[],
  ) {}

  async launchWorker(worker: WorkerLaunch): Promise<number> {
    await mkdir(join(this.config.stateRoot, 'logs'), { recursive: true });
    const log = createWriteStream(join(this.config.stateRoot, 'logs', `${worker.agentId}.log`), { flags: 'a' });
    const child = spawn(this.config.opencodeCommand, ['run', '--dir', worker.cwd, '--auto', worker.prompt], {
      cwd: worker.cwd,
      env: this.environment('worker', worker.agentId),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.once('exit', () => {
      this.workers.delete(worker.agentId);
      log.end();
      void this.onWorkerExit(worker.agentId);
    });
    child.once('error', (error) => log.write(`OpenCode failed: ${error.message}\n`));
    this.workers.set(worker.agentId, child);
    if (!child.pid) throw new Error('OpenCode worker did not start');
    return child.pid;
  }

  launchMain(projectPath: string, prompt: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = [projectPath, '--prompt', prompt];
      if (this.config.model) args.push('--model', this.config.model);
      const child = spawn(this.config.opencodeCommand, args, {
        cwd: projectPath,
        env: this.environment('main', 'main'),
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(code) : reject(new Error(`OpenCode orchestrator exited with code ${code}`)));
    });
  }

  async stop(): Promise<void> {
    for (const child of this.workers.values()) child.kill('SIGTERM');
    this.workers.clear();
  }

  private environment(role: 'main' | 'worker', agentId: string): NodeJS.ProcessEnv {
    const command = gatewayCommand();
    const vcsDenied = Object.fromEntries(
      this.deniedCommands.flatMap((name) => [[name, 'deny'], [`${name} *`, 'deny']]),
    );
    const overlay = {
      mcp: {
        'dev-team': { type: 'local', command, enabled: true },
      },
      permission: {
        bash: vcsDenied,
        ...(role === 'main' ? { edit: 'deny' } : {}),
      },
    };
    return {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: mergeConfig(process.env.OPENCODE_CONFIG_CONTENT, overlay),
      DEV_TEAM_CONTROL_URL: this.gateway.url,
      DEV_TEAM_CONTROL_TOKEN: this.gateway.token,
      DEV_TEAM_ROLE: role,
      DEV_TEAM_AGENT_ID: agentId,
    };
  }
}

function gatewayCommand(): string[] {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot determine dev-team CLI entry point');
  return entry.endsWith('.ts')
    ? [process.execPath, '--import', 'tsx', entry, 'gateway']
    : [process.execPath, entry, 'gateway'];
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
