import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { defaultStateRoot } from './config.js';

export interface GlobalProjectEntry {
  id: string;
  configPath: string;
  paths: string[];
  lastUsedAt: string;
}

export interface GlobalDevTeamConfig {
  version: 1;
  atcDbPath: string;
  port: number;
  opencodeCommand: string;
  atcNodeCommand?: string;
  projects: GlobalProjectEntry[];
}

interface WizardIo {
  ask(question: string): Promise<string>;
  write(message: string): void;
}

export function globalConfigPath(): string {
  return join(defaultStateRoot(), 'config.json');
}

export function defaultGlobalConfig(): GlobalDevTeamConfig {
  const root = defaultStateRoot();
  return {
    version: 1,
    atcDbPath: join(root, 'atc', 'atc.sqlite'),
    port: 4000,
    opencodeCommand: 'opencode',
    projects: [],
  };
}

export async function ensureGlobalConfig(options: { path?: string; io?: WizardIo; force?: boolean } = {}): Promise<GlobalDevTeamConfig> {
  const path = options.path ?? globalConfigPath();
  const exists = await access(path).then(() => true).catch(() => false);
  const existing = exists
    ? normalizeGlobalConfig(JSON.parse(await readFile(path, 'utf8')) as Partial<GlobalDevTeamConfig>)
    : null;
  if (!options.force && existing) {
    return existing;
  }
  const defaults = existing ?? defaultGlobalConfig();
  const readline = options.io ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = options.io?.ask ?? readline!.question.bind(readline);
  const write = options.io?.write ?? process.stdout.write.bind(process.stdout);
  try {
    write('Configure the shared dev-team runtime.\n');
    if (defaults.projects.length > 0) {
      write(`Registered projects:\n${defaults.projects.map((project) => `- ${project.id}: ${project.paths.join(', ')}`).join('\n')}\n`);
    }
    const atcDbPath = resolve((await ask(`Shared ATC database [${defaults.atcDbPath}]: `)).trim() || defaults.atcDbPath);
    const port = await askPort(ask, defaults.port);
    const opencodeCommand = (await ask(`OpenCode executable [${defaults.opencodeCommand}]: `)).trim() || defaults.opencodeCommand;
    const nodeAnswer = (await ask('Node.js 22 executable for ATC [auto-detect]: ')).trim();
    const config: GlobalDevTeamConfig = {
      ...defaults,
      atcDbPath,
      port,
      opencodeCommand,
      ...(nodeAnswer ? { atcNodeCommand: nodeAnswer } : {}),
    };
    await writeGlobalConfig(path, config);
    write(`Wrote ${path}\n`);
    return config;
  } finally {
    readline?.close();
  }
}

export async function registerGlobalProject(
  config: GlobalDevTeamConfig,
  project: { id: string; path: string; configPath: string },
  path: string = globalConfigPath(),
): Promise<GlobalDevTeamConfig> {
  return withGlobalConfigLock(path, async () => {
    const current = await access(path).then(() => readFile(path, 'utf8')).then((value) => normalizeGlobalConfig(JSON.parse(value) as Partial<GlobalDevTeamConfig>)).catch(() => config);
    const physicalPath = resolve(project.path);
    const configPath = resolve(project.configPath);
    const now = new Date().toISOString();
    const existing = current.projects.find((entry) => entry.id === project.id);
    const entry: GlobalProjectEntry = existing
      ? { ...existing, configPath, paths: [...new Set([...existing.paths, physicalPath])], lastUsedAt: now }
      : { id: project.id, configPath, paths: [physicalPath], lastUsedAt: now };
    const updated = {
      ...current,
      projects: [...current.projects.filter((candidate) => candidate.id !== project.id), entry]
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
    await writeGlobalConfig(path, updated);
    return updated;
  });
}

async function writeGlobalConfig(path: string, config: GlobalDevTeamConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function withGlobalConfigLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        return await action();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30_000) await unlink(lockPath).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for the global config lock: ${path}`);
}

function normalizeGlobalConfig(value: Partial<GlobalDevTeamConfig>): GlobalDevTeamConfig {
  const defaults = defaultGlobalConfig();
  return {
    version: 1,
    atcDbPath: resolve(value.atcDbPath ?? defaults.atcDbPath),
    port: Number.isInteger(value.port) ? value.port! : defaults.port,
    opencodeCommand: value.opencodeCommand || defaults.opencodeCommand,
    ...(value.atcNodeCommand ? { atcNodeCommand: value.atcNodeCommand } : {}),
    projects: Array.isArray(value.projects) ? value.projects : [],
  };
}

async function askPort(ask: (question: string) => Promise<string>, current: number): Promise<number> {
  while (true) {
    const answer = (await ask(`ATC dashboard port [${current}]: `)).trim();
    const value = answer ? Number(answer) : current;
    if (Number.isInteger(value) && value > 0 && value <= 65_535) return value;
  }
}
