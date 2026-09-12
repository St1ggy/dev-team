import { access, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProviderKind } from '../core/types.js';
import { stableId } from '../core/ids.js';

export interface DevTeamConfig {
  projectPath: string;
  provider?: ProviderKind;
  baseRef?: string;
  workers: number;
  port: number;
  model?: string;
  opencodeCommand: string;
  atcNodeCommand?: string;
  stateRoot: string;
  plugins: string[];
}

interface ConfigFile {
  provider?: ProviderKind;
  baseRef?: string;
  workers?: number;
  port?: number;
  model?: string;
  opencodeCommand?: string;
  atcNodeCommand?: string;
  stateRoot?: string;
  plugins?: string[];
}

export async function loadConfig(projectPath: string, overrides: Partial<DevTeamConfig> = {}): Promise<DevTeamConfig> {
  const root = resolve(projectPath);
  const file = join(root, 'dev-team.config.json');
  const fromFile = await readConfig(file);
  const globalRoot = defaultStateRoot();
  const stateRoot = overrides.stateRoot ?? fromFile.stateRoot ?? join(globalRoot, 'projects', stableId('project', root));
  const atcNodeCommand = overrides.atcNodeCommand ?? fromFile.atcNodeCommand ?? process.env.DEV_TEAM_ATC_NODE;
  return {
    projectPath: root,
    workers: overrides.workers ?? fromFile.workers ?? 4,
    port: overrides.port ?? fromFile.port ?? 4000,
    opencodeCommand: overrides.opencodeCommand ?? fromFile.opencodeCommand ?? 'opencode',
    plugins: overrides.plugins ?? fromFile.plugins ?? [],
    stateRoot,
    ...(overrides.provider ?? fromFile.provider ? { provider: overrides.provider ?? fromFile.provider } : {}),
    ...(overrides.baseRef ?? fromFile.baseRef ? { baseRef: overrides.baseRef ?? fromFile.baseRef } : {}),
    ...(overrides.model ?? fromFile.model ? { model: overrides.model ?? fromFile.model } : {}),
    ...(atcNodeCommand ? { atcNodeCommand } : {}),
  };
}

export function defaultStateRoot(): string {
  if (process.env.DEV_TEAM_HOME) return resolve(process.env.DEV_TEAM_HOME);
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dev-team');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dev-team');
}

async function readConfig(path: string): Promise<ConfigFile> {
  if (!(await access(path).then(() => true).catch(() => false))) return {};
  return JSON.parse(await readFile(path, 'utf8')) as ConfigFile;
}
