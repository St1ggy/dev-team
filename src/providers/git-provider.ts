import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Checkpoint,
  CreateWorkspaceInput,
  DiffArtifact,
  DoctorCheck,
  IntegrationReceipt,
  ProjectRecord,
  Submission,
  SubmitInput,
  WorkspaceRecord,
} from '../core/types.js';
import { DevTeamError } from '../core/errors.js';
import { newId, shortId } from '../core/ids.js';
import type { CommandRunner } from '../runtime/command-runner.js';
import type { DetectedRepository, VcsProvider } from './provider.js';

export class GitProvider implements VcsProvider {
  readonly kind = 'git' as const;
  readonly capabilities = {
    isolatedWorkspace: true,
    localCheckpoints: true,
    aggregateIntegration: true,
    remoteSubmission: true,
    draftPullRequest: true,
  };

  constructor(private readonly runner: CommandRunner) {}

  async detect(path: string): Promise<DetectedRepository | null> {
    const root = await this.runner.run('git', ['rev-parse', '--show-toplevel'], { cwd: path, allowFailure: true });
    if (root.code !== 0) return null;
    const branch = await this.runner.run('git', ['branch', '--show-current'], { cwd: path, allowFailure: true });
    const baseRef = branch.stdout.trim() || 'HEAD';
    const repositoryRoot = root.stdout.trim();
    const relative = await import('node:path').then(({ relative }) => relative(repositoryRoot, path) || '.');
    return { root: repositoryRoot, baseRef, projectRelativePath: relative };
  }

  async doctor(project: ProjectRecord): Promise<DoctorCheck[]> {
    const version = await this.runner.run('git', ['--version'], { cwd: project.root, allowFailure: true });
    const status = await this.runner.run('git', ['status', '--porcelain', '--', project.projectRelativePath], { cwd: project.root, allowFailure: true });
    const gh = await this.runner.run('gh', ['--version'], { cwd: project.root, allowFailure: true });
    const ghAuth = gh.code === 0 ? await this.runner.run('gh', ['auth', 'status'], { cwd: project.root, allowFailure: true }) : gh;
    return [
      { name: 'git', ok: version.code === 0, message: version.stdout.trim() || version.stderr.trim() },
      { name: 'clean source', ok: status.code === 0 && status.stdout.trim() === '', message: status.stdout.trim() || 'clean' },
      { name: 'gh', ok: gh.code === 0, message: gh.stdout.split('\n')[0] || gh.stderr.trim() },
      { name: 'GitHub authentication', ok: ghAuth.code === 0, message: ghAuth.code === 0 ? 'authenticated' : ghAuth.stderr.trim() },
    ];
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    await mkdir(join(input.workspaceRoot, '..'), { recursive: true });
    const suffix = shortId(input.taskId ?? input.scopeId);
    const ref = input.kind === 'aggregate' ? `dev-team/delivery-${suffix}` : `dev-team/task-${suffix}`;
    const base = input.baseWorkspace?.ref ?? input.project.baseRef;
    const baseRevision = (await this.runner.run('git', ['rev-parse', base], { cwd: input.project.root })).stdout.trim();
    await this.runner.run('git', ['worktree', 'add', '-b', ref, input.workspaceRoot, baseRevision], { cwd: input.project.root });
    const projectPath = input.project.projectRelativePath === '.'
      ? input.workspaceRoot
      : join(input.workspaceRoot, input.project.projectRelativePath);
    return {
      id: newId('ws'), projectId: input.project.id, scopeId: input.scopeId,
      taskId: input.taskId ?? null, kind: input.kind, root: input.workspaceRoot,
      projectPath, ref, baseRevision, status: 'active', metadata: '{}',
    };
  }

  async checkpoint(project: ProjectRecord, workspace: WorkspaceRecord, message: string): Promise<Checkpoint> {
    const pathspec = project.projectRelativePath;
    await this.runner.run('git', ['add', '-A', '--', pathspec], { cwd: workspace.root });
    const staged = await this.runner.run('git', ['diff', '--cached', '--quiet', '--', pathspec], { cwd: workspace.root, allowFailure: true });
    if (staged.code !== 0) {
      await this.runner.run('git', ['commit', '-m', message, '--', pathspec], { cwd: workspace.root });
    }
    const revision = (await this.runner.run('git', ['rev-parse', 'HEAD'], { cwd: workspace.root })).stdout.trim();
    const status = await this.runner.run('git', ['status', '--porcelain', '--', pathspec], { cwd: workspace.root });
    return { id: revision, revision, clean: status.stdout.trim() === '' };
  }

  async diff(project: ProjectRecord, workspace: WorkspaceRecord): Promise<DiffArtifact> {
    const range = `${workspace.baseRevision}..${workspace.ref}`;
    const [diff, names] = await Promise.all([
      this.runner.run('git', ['diff', '--binary', range, '--', project.projectRelativePath], { cwd: workspace.root }),
      this.runner.run('git', ['diff', '--name-only', range, '--', project.projectRelativePath], { cwd: workspace.root }),
    ]);
    return { text: diff.stdout, files: names.stdout.split('\n').filter(Boolean) };
  }

  async submit(input: SubmitInput): Promise<Submission> {
    const revision = (await this.runner.run('git', ['rev-parse', input.workspace.ref], { cwd: input.workspace.root })).stdout.trim();
    if (!input.final) return { kind: 'local-ref', revision, reference: input.workspace.ref };

    await this.runner.run('git', ['push', '-u', 'origin', input.workspace.ref], { cwd: input.workspace.root });
    const existing = await this.runner.run(
      'gh', ['pr', 'list', '--head', input.workspace.ref, '--state', 'all', '--limit', '1', '--json', 'number,url'],
      { cwd: input.workspace.root, allowFailure: true },
    );
    const rows = parseJson<Array<{ number: number; url: string }>>(existing.stdout, []);
    const found = rows[0];
    if (found) return { kind: 'pull-request', revision, reference: input.workspace.ref, url: found.url, number: String(found.number) };

    const created = await this.runner.run(
      'gh', ['pr', 'create', '--draft', '--head', input.workspace.ref, '--base', input.project.baseRef, '--title', input.title, '--body', input.body],
      { cwd: input.workspace.root },
    );
    const url = created.stdout.trim().split('\n').find((line) => line.startsWith('http'));
    return { kind: 'pull-request', revision, reference: input.workspace.ref, ...(url ? { url } : {}) };
  }

  async integrate(project: ProjectRecord, source: WorkspaceRecord, aggregate: WorkspaceRecord): Promise<IntegrationReceipt> {
    const sourceRevision = (await this.runner.run('git', ['rev-parse', source.ref], { cwd: source.root })).stdout.trim();
    const marker = `dev-team-source: ${sourceRevision}`;
    const log = await this.runner.run('git', ['log', '--format=%B', aggregate.baseRevision + '..' + aggregate.ref], { cwd: aggregate.root });
    if (log.stdout.includes(marker)) {
      const revision = (await this.runner.run('git', ['rev-parse', aggregate.ref], { cwd: aggregate.root })).stdout.trim();
      return { revision, alreadyApplied: true };
    }

    const commits = await this.runner.run('git', ['rev-list', '--reverse', `${source.baseRevision}..${source.ref}`], { cwd: source.root });
    const list = commits.stdout.split('\n').filter(Boolean);
    if (list.length === 0) throw new DevTeamError('EMPTY_SUBMISSION', `Task workspace ${source.id} has no commits`);
    const picked = await this.runner.run('git', ['cherry-pick', ...list], { cwd: aggregate.root, allowFailure: true });
    if (picked.code !== 0) {
      await this.runner.run('git', ['cherry-pick', '--abort'], { cwd: aggregate.root, allowFailure: true });
      throw new DevTeamError('INTEGRATION_CONFLICT', picked.stderr.trim() || picked.stdout.trim());
    }
    await this.runner.run('git', ['commit', '--amend', '--no-edit', '-m', `Integrate task ${source.taskId ?? source.id}\n\n${marker}`], { cwd: aggregate.root });
    const revision = (await this.runner.run('git', ['rev-parse', 'HEAD'], { cwd: aggregate.root })).stdout.trim();
    return { revision, alreadyApplied: false };
  }

  async applyDelivery(_project: ProjectRecord, aggregate: WorkspaceRecord): Promise<IntegrationReceipt> {
    const revision = (await this.runner.run('git', ['rev-parse', aggregate.ref], { cwd: aggregate.root })).stdout.trim();
    return { revision, alreadyApplied: true, details: 'Delivery is applied through the GitHub pull request' };
  }

  async archive(_workspace: WorkspaceRecord): Promise<void> {}

  async cleanup(project: ProjectRecord, workspace: WorkspaceRecord): Promise<void> {
    await this.runner.run('git', ['worktree', 'remove', workspace.root], { cwd: project.root });
    await this.runner.run('git', ['branch', '-D', workspace.ref], { cwd: project.root, allowFailure: true });
    await rm(workspace.root, { recursive: true, force: true });
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
