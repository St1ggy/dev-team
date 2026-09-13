import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/config.js';
import { ensureGlobalConfig, registerGlobalProject } from '../src/config/global-config.js';

test('global setup stores shared runtime settings and one project with multiple paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-global-'));
  const path = join(root, 'config.json');
  const answers = [join(root, 'shared.sqlite'), '4500', 'opencode-custom', '/node22'];
  try {
    let config = await ensureGlobalConfig({
      path,
      io: { ask: async () => answers.shift()!, write: () => undefined },
    });
    assert.equal(config.port, 4500);
    assert.equal(config.opencodeCommand, 'opencode-custom');
    assert.equal(config.atcNodeCommand, '/node22');
    config = await registerGlobalProject(config, { id: 'project-shared', path: '/copy/one', configPath: '/copy/one/dev-team.config.json' }, path);
    config = await registerGlobalProject(config, { id: 'project-shared', path: '/copy/two', configPath: '/copy/two/dev-team.config.json' }, path);
    assert.equal(config.projects.length, 1);
    assert.deepEqual(config.projects[0]?.paths, ['/copy/one', '/copy/two']);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).projects[0].paths, ['/copy/one', '/copy/two']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copied project config keeps project identity and state across physical paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-project-id-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first);
  await mkdir(second);
  try {
    await writeFile(join(first, 'dev-team.config.json'), '{"projectId":"project_same","provider":"novcs"}\n');
    await copyFile(join(first, 'dev-team.config.json'), join(second, 'dev-team.config.json'));
    const firstConfig = await loadConfig(first);
    const secondConfig = await loadConfig(second);
    assert.equal(firstConfig.projectId, secondConfig.projectId);
    assert.equal(firstConfig.stateRoot, secondConfig.stateRoot);
    assert.notEqual(firstConfig.projectPath, secondConfig.projectPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent first loads agree on one project identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-project-race-'));
  const project = join(root, 'project');
  await mkdir(project);
  const previousHome = process.env.DEV_TEAM_HOME;
  process.env.DEV_TEAM_HOME = join(root, 'state');
  try {
    const configs = await Promise.all(Array.from({ length: 20 }, () => loadConfig(project)));
    assert.equal(new Set(configs.map((config) => config.projectId)).size, 1);
    assert.equal(JSON.parse(await readFile(join(project, 'dev-team.config.json'), 'utf8')).projectId, configs[0]?.projectId);
  } finally {
    if (previousHome === undefined) delete process.env.DEV_TEAM_HOME;
    else process.env.DEV_TEAM_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('global runtime settings override legacy project-local settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-global-precedence-'));
  try {
    await writeFile(join(root, 'dev-team.config.json'), JSON.stringify({
      projectId: 'project_precedence',
      port: 4001,
      opencodeCommand: 'old-opencode',
      atcNodeCommand: 'old-node',
      atcDbPath: join(root, 'old.sqlite'),
    }));
    const config = await loadConfig(root, {}, {
      port: 4002,
      opencodeCommand: 'global-opencode',
      atcNodeCommand: 'global-node',
      atcDbPath: join(root, 'global.sqlite'),
    });
    assert.equal(config.port, 4002);
    assert.equal(config.opencodeCommand, 'global-opencode');
    assert.equal(config.atcNodeCommand, 'global-node');
    assert.equal(config.atcDbPath, join(root, 'global.sqlite'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent project registration preserves every physical path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-team-global-race-'));
  const path = join(root, 'config.json');
  const config = { version: 1 as const, atcDbPath: join(root, 'atc.sqlite'), port: 4000, opencodeCommand: 'opencode', projects: [] };
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) => registerGlobalProject(config, {
      id: 'project-shared',
      path: join(root, `copy-${index}`),
      configPath: join(root, `copy-${index}`, 'dev-team.config.json'),
    }, path)));
    const saved = JSON.parse(await readFile(path, 'utf8')) as { projects: Array<{ paths: string[] }> };
    assert.equal(saved.projects[0]?.paths.length, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
