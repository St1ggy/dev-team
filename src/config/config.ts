import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProviderKind } from '../core/types.js';
import { stableId } from '../core/ids.js';

export interface GlobalConfigDefaults {
  atcDbPath?: string;
  port?: number;
  opencodeCommand?: string;
  atcNodeCommand?: string;
}

export interface DevTeamConfig {
  projectId: string;
  projectPath: string;
  provider?: ProviderKind;
  baseRef?: string;
  workers: number;
  port: number;
  model?: string;
  opencodeCommand: string;
  atcNodeCommand?: string;
  atcDbPath: string;
  stateRoot: string;
  plugins: string[];
}

interface ConfigFile {
  projectId?: string;
  provider?: ProviderKind;
  baseRef?: string;
  workers?: number;
  port?: number;
  model?: string;
  opencodeCommand?: string;
  atcNodeCommand?: string;
  atcDbPath?: string;
  stateRoot?: string;
  plugins?: string[];
}

export async function loadConfig(
  projectPath: string,
  overrides: Partial<DevTeamConfig> = {},
  global: GlobalConfigDefaults = {},
): Promise<DevTeamConfig> {
  const root = resolve(projectPath);
  const file = join(root, 'dev-team.config.json');
  const globalRoot = defaultStateRoot();
  const legacyProjectId = stableId('project', root);
  const legacyStateRoot = join(globalRoot, 'projects', legacyProjectId);
  const existed = await access(file).then(() => true).catch(() => false);
  const hasLegacyState = await access(legacyStateRoot).then(() => true).catch(() => false);
  let fromFile = await readConfig(file);
  let projectId = fromFile.projectId ?? (existed || hasLegacyState ? legacyProjectId : `project_${randomUUID()}`);
  if (!fromFile.projectId) {
    try {
      await writeFile(file, `${JSON.stringify({ projectId, ...fromFile }, null, 2)}\n`, existed ? 'utf8' : { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      fromFile = await readConfig(file);
      if (!fromFile.projectId) throw new Error(`Project configuration was created without projectId: ${file}`);
      projectId = fromFile.projectId;
    }
  }
  const stateRoot = overrides.stateRoot ?? fromFile.stateRoot ?? join(globalRoot, 'projects', projectId);
  const atcNodeCommand = overrides.atcNodeCommand ?? process.env.DEV_TEAM_ATC_NODE ?? global.atcNodeCommand ?? fromFile.atcNodeCommand;
  const atcDbPath = resolve(overrides.atcDbPath ?? process.env.DEV_TEAM_ATC_DB ?? global.atcDbPath ?? fromFile.atcDbPath ?? join(globalRoot, 'atc', 'atc.sqlite'));
  return {
    projectId,
    projectPath: root,
    workers: overrides.workers ?? fromFile.workers ?? 4,
    port: overrides.port ?? global.port ?? fromFile.port ?? 4000,
    opencodeCommand: overrides.opencodeCommand ?? global.opencodeCommand ?? fromFile.opencodeCommand ?? 'opencode',
    plugins: overrides.plugins ?? fromFile.plugins ?? [],
    atcDbPath,
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

export function defaultAtcRuntimeRoot(): string {
  return join(defaultStateRoot(), 'atc');
}

async function readConfig(path: string): Promise<ConfigFile> {
  if (!(await access(path).then(() => true).catch(() => false))) return {};
  return JSON.parse(await readFile(path, 'utf8')) as ConfigFile;
}
