import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDevTeamPlugin, type DevTeamPlugin } from './plugin.js';

export async function loadPlugins(specifiers: readonly string[], projectPath: string): Promise<DevTeamPlugin[]> {
  const plugins: DevTeamPlugin[] = [];
  for (const specifier of specifiers) {
    const moduleUrl = specifier.startsWith('.') || isAbsolute(specifier)
      ? pathToFileURL(resolve(projectPath, specifier)).href
      : await resolvePackage(specifier, projectPath);
    const module = await import(moduleUrl) as { default?: unknown; plugin?: unknown };
    const plugin = module.default ?? module.plugin;
    if (!isDevTeamPlugin(plugin)) throw new Error(`Module does not export a dev-team plugin: ${specifier}`);
    plugins.push(plugin);
  }
  return plugins;
}

async function resolvePackage(specifier: string, projectPath: string): Promise<string> {
  const { name, subpath } = splitPackageSpecifier(specifier);
  let directory = resolve(projectPath);
  while (true) {
    const packageRoot = join(directory, 'node_modules', name);
    const packageJson = join(packageRoot, 'package.json');
    if (await access(packageJson).then(() => true).catch(() => false)) {
      const manifest = JSON.parse(await readFile(packageJson, 'utf8')) as {
        exports?: unknown;
        module?: string;
        main?: string;
      };
      const target = resolveExport(manifest.exports, subpath)
        ?? (subpath === '.' ? manifest.module ?? manifest.main ?? 'index.js' : subpath.slice(2));
      return pathToFileURL(resolve(packageRoot, target)).href;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const require = createRequire(resolve(projectPath, 'package.json'));
  return pathToFileURL(require.resolve(specifier)).href;
}

function splitPackageSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  const rest = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
  return { name, subpath: rest ? `./${rest}` : '.' };
}

function resolveExport(exports: unknown, subpath: string): string | undefined {
  if (typeof exports === 'string') return subpath === '.' ? exports : undefined;
  if (Array.isArray(exports)) {
    for (const candidate of exports) {
      const resolved = resolveExport(candidate, subpath);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!exports || typeof exports !== 'object') return undefined;
  const record = exports as Record<string, unknown>;
  if (record[subpath] !== undefined) return resolveConditions(record[subpath]);
  if (subpath === '.' && !Object.keys(record).some((key) => key.startsWith('.'))) return resolveConditions(record);
  return undefined;
}

function resolveConditions(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = resolveConditions(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of ['node', 'import', 'default']) {
    const resolved = resolveConditions(record[condition]);
    if (resolved) return resolved;
  }
  return undefined;
}
