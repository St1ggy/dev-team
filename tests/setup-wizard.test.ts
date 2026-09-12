import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSetupWizard } from '../src/config/setup-wizard.js';

test('setup wizard writes an explicit project configuration', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dev-team-setup-'));
  try {
    const answers = ['git', '', 'main', '3', '4100', 'provider/model', 'opencode-custom', '/node22'];
    await runSetupWizard(
      { projectPath: project, projectPathProvided: true },
      { ask: async () => answers.shift()!, write: () => undefined },
    );
    const config = JSON.parse(await readFile(join(project, 'dev-team.config.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(config, {
      workers: 3,
      port: 4100,
      opencodeCommand: 'opencode-custom',
      provider: 'git',
      plugins: [],
      baseRef: 'main',
      model: 'provider/model',
      atcNodeCommand: '/node22',
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('setup wizard does not overwrite a configuration without confirmation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dev-team-setup-'));
  const configPath = join(project, 'dev-team.config.json');
  const original = '{"workers":2}\n';
  await writeFile(configPath, original);
  try {
    const answers = ['n'];
    const result = await runSetupWizard(
      { projectPath: project, projectPathProvided: true },
      { ask: async () => answers.shift()!, write: () => undefined },
    );
    assert.equal(result, null);
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('setup wizard preserves fields it does not manage', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dev-team-setup-'));
  const configPath = join(project, 'dev-team.config.json');
  await writeFile(configPath, '{"workers":2,"stateRoot":"/state","futureOption":true}\n');
  try {
    const answers = ['y', 'git', '', 'main', '', '', '', '', ''];
    await runSetupWizard(
      { projectPath: project, projectPathProvided: true },
      { ask: async () => answers.shift()!, write: () => undefined },
    );
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config.stateRoot, '/state');
    assert.equal(config.futureOption, true);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
