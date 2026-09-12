import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { doctor, start } from './app.js';
import { loadConfig } from './config/config.js';
import { runSetupWizard } from './config/setup-wizard.js';
import type { ProviderKind } from './core/types.js';
import { runGateway } from './gateway/server.js';
import type { DevTeamPlugin } from './plugin.js';
import { loadPlugins } from './plugin-loader.js';
import { StateStore } from './state/store.js';

export interface CliOptions {
  plugins?: readonly DevTeamPlugin[];
}

export async function runCli(options: CliOptions = {}, argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command = 'start', ...args] = argv;
  if (command === 'gateway') {
    await runGateway();
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const parsed = parseArgs(args);
  if (command === 'setup' || command === 'init') {
    await runSetupWizard({
      projectPath: parsed.path,
      projectPathProvided: parsed.pathProvided,
      plugins: parsed.plugins,
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.baseRef ? { baseRef: parsed.baseRef } : {}),
      ...(parsed.port ? { port: parsed.port } : {}),
      ...(parsed.workers ? { workers: parsed.workers } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.opencode ? { opencodeCommand: parsed.opencode } : {}),
      ...(parsed.atcNode ? { atcNodeCommand: parsed.atcNode } : {}),
    });
    return;
  }
  const config = await loadConfig(parsed.path, {
    ...(parsed.plugins.length > 0 ? { plugins: parsed.plugins } : {}),
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.baseRef ? { baseRef: parsed.baseRef } : {}),
    ...(parsed.port ? { port: parsed.port } : {}),
    ...(parsed.workers ? { workers: parsed.workers } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.opencode ? { opencodeCommand: parsed.opencode } : {}),
    ...(parsed.atcNode ? { atcNodeCommand: parsed.atcNode } : {}),
  });
  const plugins = [...(options.plugins ?? []), ...await loadPlugins(config.plugins, config.projectPath)];

  if (command === 'doctor') {
    const result = await doctor(config, { plugins });
    process.stdout.write(`Provider: ${result.project.provider}\nBase: ${result.project.baseRef}\n`);
    for (const check of result.checks) process.stdout.write(`${check.ok ? 'OK' : 'FAIL'}  ${check.name}: ${check.message}\n`);
    if (result.checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  if (command === 'status' || command === 'recover') {
    const db = join(config.stateRoot, 'state.sqlite');
    if (!(await access(db).then(() => true).catch(() => false))) {
      process.stdout.write('No dev-team state exists for this project.\n');
      return;
    }
    const store = new StateStore(db);
    const operations = store.listRecoverableOperations();
    store.close();
    process.stdout.write(JSON.stringify({ stateRoot: config.stateRoot, recoverableOperations: operations }, null, 2) + '\n');
    return;
  }
  if (command !== 'start') throw new Error(`Unknown command: ${command}`);
  await start(config, { plugins });
}

export function runCliMain(options: CliOptions = {}): void {
  runCli(options).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

interface ParsedArgs {
  path: string;
  pathProvided: boolean;
  plugins: string[];
  provider?: ProviderKind;
  baseRef?: string;
  port?: number;
  workers?: number;
  model?: string;
  opencode?: string;
  atcNode?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { path: process.cwd(), pathProvided: false, plugins: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) {
      result.path = arg;
      result.pathProvided = true;
      continue;
    }
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === '--plugin') result.plugins.push(value);
    else if (arg === '--provider') result.provider = value;
    else if (arg === '--base-ref') result.baseRef = value;
    else if (arg === '--port') result.port = Number(value);
    else if (arg === '--workers') result.workers = Number(value);
    else if (arg === '--model') result.model = value;
    else if (arg === '--opencode') result.opencode = value;
    else if (arg === '--atc-node') result.atcNode = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function printHelp(): void {
  process.stdout.write('dev-team <command> [project] [options]\n\nCommands:\n  start     Start ATC and the OpenCode orchestrator (default)\n  setup     Interactively write dev-team.config.json (alias: init)\n  doctor    Check provider and runtime prerequisites\n  status    Show interrupted durable operations\n  recover   Show operations safe to retry through task_review\n\nOptions:\n  --plugin <module>\n  --provider <provider>\n  --base-ref <ref>\n  --port <number>\n  --workers <number>\n  --model <provider/model>\n  --opencode <executable>\n  --atc-node <node-22-executable>\n');
}
