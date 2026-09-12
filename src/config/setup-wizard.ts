import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { ProviderKind } from '../core/types.js';

export interface SetupDefaults {
  projectPath: string;
  projectPathProvided: boolean;
  provider?: ProviderKind;
  baseRef?: string;
  workers?: number;
  port?: number;
  model?: string;
  opencodeCommand?: string;
  atcNodeCommand?: string;
  plugins?: string[];
}

interface SetupConfig {
  provider?: ProviderKind;
  baseRef?: string;
  workers?: number;
  port?: number;
  model?: string;
  opencodeCommand?: string;
  atcNodeCommand?: string;
  stateRoot?: string;
  plugins?: string[];
  [key: string]: unknown;
}

interface WizardIo {
  ask(question: string): Promise<string>;
  write(message: string): void;
}

export async function runSetupWizard(defaults: SetupDefaults, io?: WizardIo): Promise<string | null> {
  const readline = io ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = io?.ask ?? readline!.question.bind(readline);
  const write = io?.write ?? process.stdout.write.bind(process.stdout);
  try {
    const projectAnswer = defaults.projectPathProvided
      ? defaults.projectPath
      : await ask(`Project path [${defaults.projectPath}]: `);
    const projectPath = resolve(projectAnswer.trim() || defaults.projectPath);
    const projectStat = await stat(projectPath).catch(() => null);
    if (!projectStat?.isDirectory()) throw new Error(`Project directory does not exist: ${projectPath}`);

    const configPath = join(projectPath, 'dev-team.config.json');
    const existing = await readExistingConfig(configPath);
    if (existing) {
      const overwrite = await ask(`Configuration already exists at ${configPath}. Overwrite? [y/N]: `);
      if (!['y', 'yes'].includes(overwrite.trim().toLowerCase())) {
        write('Setup cancelled; existing configuration was not changed.\n');
        return null;
      }
    }

    const provider = await askProvider(ask, defaults.provider ?? existing?.provider);
    const plugins = await askList(ask, 'Plugins', defaults.plugins ?? existing?.plugins ?? []);
    const baseRef = await askOptional(ask, 'Base ref', defaults.baseRef ?? existing?.baseRef, 'auto-detect');
    const workers = await askInteger(ask, 'Worker count', defaults.workers ?? existing?.workers ?? 4, 1, 64);
    const port = await askInteger(ask, 'ATC dashboard port', defaults.port ?? existing?.port ?? 4000, 1, 65_535);
    const model = await askOptional(ask, 'OpenCode model', defaults.model ?? existing?.model, 'default');
    const opencodeCommand = await askValue(ask, 'OpenCode executable', defaults.opencodeCommand ?? existing?.opencodeCommand ?? 'opencode');
    const atcNodeCommand = await askOptional(ask, 'Node.js 22 executable for ATC', defaults.atcNodeCommand ?? existing?.atcNodeCommand, 'auto-detect');

    const config: SetupConfig = { ...existing, workers, port, opencodeCommand };
    setOptional(config, 'provider', provider);
    config.plugins = plugins;
    setOptional(config, 'baseRef', baseRef);
    setOptional(config, 'model', model);
    setOptional(config, 'atcNodeCommand', atcNodeCommand);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    write(`Wrote ${configPath}\nRun: dev-team doctor ${JSON.stringify(projectPath)}\n`);
    return configPath;
  } finally {
    readline?.close();
  }
}

type Ask = (question: string) => Promise<string>;

async function askProvider(ask: Ask, current?: ProviderKind): Promise<ProviderKind | undefined> {
  const fallback = current ?? 'auto';
  const answer = (await ask(`Provider (auto/git/novcs/plugin) [${fallback}]: `)).trim() || fallback;
  return answer === 'auto' ? undefined : answer;
}

async function askList(ask: Ask, label: string, current: string[]): Promise<string[]> {
  const answer = (await ask(`${label}, comma-separated [${current.join(', ')}]: `)).trim();
  return (answer ? answer.split(',') : current).map((value) => value.trim()).filter(Boolean);
}

async function askInteger(ask: Ask, label: string, current: number, minimum: number, maximum: number): Promise<number> {
  while (true) {
    const answer = (await ask(`${label} [${current}]: `)).trim();
    const value = answer ? Number(answer) : current;
    if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  }
}

async function askValue(ask: Ask, label: string, current: string): Promise<string> {
  return (await ask(`${label} [${current}]: `)).trim() || current;
}

async function askOptional(ask: Ask, label: string, current: string | undefined, emptyLabel: string): Promise<string | undefined> {
  const fallback = current ?? emptyLabel;
  const answer = (await ask(`${label} [${fallback}]: `)).trim();
  if (!answer) return current;
  return answer === emptyLabel ? undefined : answer;
}

async function readExistingConfig(path: string): Promise<SetupConfig | null> {
  if (!(await access(path).then(() => true).catch(() => false))) return null;
  return JSON.parse(await readFile(path, 'utf8')) as SetupConfig;
}

function setOptional(config: SetupConfig, key: keyof SetupConfig, value: unknown): void {
  if (value === undefined) delete config[key];
  else config[key] = value;
}
