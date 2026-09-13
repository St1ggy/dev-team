import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverProject } from '../src/app.js';
import type { DevTeamConfig } from '../src/config/config.js';
import type { DevTeamPlugin } from '../src/plugin.js';
import { loadPlugins } from '../src/plugin-loader.js';
import type { VcsProvider } from '../src/providers/provider.js';

test('a plugin contributes a provider and denied commands', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'dev-team-plugin-'));
  const provider = {
    kind: 'fixture',
    capabilities: {
      isolatedWorkspace: true,
      localCheckpoints: true,
      aggregateIntegration: true,
      remoteSubmission: false,
      draftPullRequest: false,
    },
    detect: async (path: string) => ({ root: path, baseRef: 'plugin-base', projectRelativePath: '.' }),
  } as VcsProvider;
  const plugin: DevTeamPlugin = {
    name: 'fixture-plugin',
    deniedCommands: ['fixture-vcs'],
    createProviders: () => [provider],
  };
  const config: DevTeamConfig = {
    projectId: 'project-plugin-test', projectPath,
    provider: 'fixture',
    workers: 1,
    port: 4000,
    opencodeCommand: 'opencode',
    stateRoot: join(projectPath, 'state'),
    atcDbPath: join(projectPath, 'atc.sqlite'),
    plugins: [],
  };
  try {
    const discovered = await discoverProject(config, { plugins: [plugin] });
    assert.equal(discovered.project.provider, 'fixture');
    assert.equal(discovered.project.baseRef, 'plugin-base');
    assert.ok(discovered.deniedCommands.includes('fixture-vcs'));
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('loads a plugin module relative to the target project', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'dev-team-plugin-'));
  try {
    await writeFile(join(projectPath, 'plugin.mjs'), "export default { name: 'loaded', createProviders: () => [] };\n");
    const plugins = await loadPlugins(['./plugin.mjs'], projectPath);
    assert.equal(plugins[0]?.name, 'loaded');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('loads an ESM-only plugin package from the target project', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'dev-team-plugin-'));
  const packagePath = join(projectPath, 'node_modules', 'fixture-plugin');
  try {
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({
      name: 'fixture-plugin',
      type: 'module',
      exports: { '.': { import: './index.js' } },
    }));
    await writeFile(join(packagePath, 'index.js'), "export default { name: 'esm-only', createProviders: () => [] };\n");
    const plugins = await loadPlugins(['fixture-plugin'], projectPath);
    assert.equal(plugins[0]?.name, 'esm-only');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
