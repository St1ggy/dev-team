import type { CommandRunner } from './runtime/command-runner.js';
import type { VcsProvider } from './providers/provider.js';

export interface PluginContext {
  runner: CommandRunner;
}

export interface DevTeamPlugin {
  name: string;
  createProviders(context: PluginContext): VcsProvider[];
  deniedCommands?: readonly string[];
}

export function isDevTeamPlugin(value: unknown): value is DevTeamPlugin {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DevTeamPlugin>;
  return typeof candidate.name === 'string' && typeof candidate.createProviders === 'function';
}
