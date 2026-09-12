import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDevTeamPlugin, type DevTeamPlugin } from './plugin.js';

export async function loadPlugins(specifiers: readonly string[], projectPath: string): Promise<DevTeamPlugin[]> {
  const require = createRequire(resolve(projectPath, 'package.json'));
  const plugins: DevTeamPlugin[] = [];
  for (const specifier of specifiers) {
    const moduleUrl = specifier.startsWith('.') || isAbsolute(specifier)
      ? pathToFileURL(resolve(projectPath, specifier)).href
      : pathToFileURL(require.resolve(specifier)).href;
    const module = await import(moduleUrl) as { default?: unknown; plugin?: unknown };
    const plugin = module.default ?? module.plugin;
    if (!isDevTeamPlugin(plugin)) throw new Error(`Module does not export a dev-team plugin: ${specifier}`);
    plugins.push(plugin);
  }
  return plugins;
}
