import { createHash } from 'node:crypto';
import {
  chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type {
  Checkpoint, CreateWorkspaceInput, DiffArtifact, DoctorCheck, IntegrationReceipt,
  ProjectRecord, Submission, SubmitInput, WorkspaceRecord,
} from '../core/types.js';
import { DevTeamError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import type { DetectedRepository, VcsProvider } from './provider.js';

interface ManifestEntry {
  kind: 'file' | 'symlink';
  hash: string;
  mode: number;
}

type Manifest = Record<string, ManifestEntry>;

interface NoVcsMetadata {
  baselinePath: string;
  versionsPath?: string;
}

export class NoVcsProvider implements VcsProvider {
  readonly kind = 'novcs' as const;
  readonly capabilities = {
    isolatedWorkspace: true, localCheckpoints: true, aggregateIntegration: true,
    remoteSubmission: false, draftPullRequest: false,
  };

  async detect(path: string): Promise<DetectedRepository> {
    return { root: path, baseRef: 'source', projectRelativePath: '.' };
  }

  async doctor(project: ProjectRecord): Promise<DoctorCheck[]> {
    const value = await lstat(project.root).catch(() => null);
    return [{ name: 'source directory', ok: Boolean(value?.isDirectory()), message: value?.isDirectory() ? project.root : 'not a directory' }];
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    await mkdir(input.workspaceRoot, { recursive: true });
    const source = input.baseWorkspace?.projectPath ?? input.project.root;
    let projectPath: string;
    let metadata: NoVcsMetadata;
    if (input.kind === 'aggregate') {
      const versionsPath = join(input.workspaceRoot, 'versions');
      const initial = join(versionsPath, 'initial');
      const baselinePath = join(input.workspaceRoot, 'source-baseline');
      await mkdir(versionsPath, { recursive: true });
      await copyTree(source, initial);
      await copyTree(source, baselinePath);
      projectPath = join(input.workspaceRoot, 'current');
      await symlink(relative(input.workspaceRoot, initial), projectPath, 'dir');
      metadata = { baselinePath, versionsPath };
    } else {
      projectPath = join(input.workspaceRoot, 'tree');
      const baselinePath = join(input.workspaceRoot, 'baseline');
      await copyTree(source, projectPath);
      await copyTree(source, baselinePath);
      metadata = { baselinePath };
    }
    const manifest = await createManifest(projectPath);
    const revision = manifestHash(manifest);
    return {
      id: newId('ws'), projectId: input.project.id, scopeId: input.scopeId,
      taskId: input.taskId ?? null, kind: input.kind, root: input.workspaceRoot,
      projectPath, ref: input.kind === 'aggregate' ? `snapshot:${input.scopeId}` : `snapshot:${input.taskId}`,
      baseRevision: revision, status: 'active', metadata: JSON.stringify(metadata),
    };
  }

  async checkpoint(_project: ProjectRecord, workspace: WorkspaceRecord, _message: string): Promise<Checkpoint> {
    const manifest = await createManifest(workspace.projectPath);
    const revision = manifestHash(manifest);
    await writeFile(join(workspace.root, 'checkpoint.json'), JSON.stringify({ revision, manifest }, null, 2));
    return { id: revision, revision, clean: true };
  }

  async diff(_project: ProjectRecord, workspace: WorkspaceRecord): Promise<DiffArtifact> {
    const metadata = parseMetadata(workspace);
    const before = await createManifest(metadata.baselinePath);
    const after = await createManifest(workspace.projectPath);
    const changes = compareManifests(before, after);
    return {
      text: changes.map(({ status, path }) => `${status}\t${path}`).join('\n') + (changes.length ? '\n' : ''),
      files: changes.map(({ path }) => path),
    };
  }

  async submit(input: SubmitInput): Promise<Submission> {
    const revision = manifestHash(await createManifest(input.workspace.projectPath));
    return { kind: 'snapshot', revision, reference: input.workspace.projectPath };
  }

  async integrate(_project: ProjectRecord, source: WorkspaceRecord, aggregate: WorkspaceRecord): Promise<IntegrationReceipt> {
    const sourceMeta = parseMetadata(source);
    const aggregateMeta = parseMetadata(aggregate);
    if (!aggregateMeta.versionsPath) throw new DevTeamError('INVALID_WORKSPACE', 'Aggregate snapshot has no versions directory');

    const base = await createManifest(sourceMeta.baselinePath);
    const worker = await createManifest(source.projectPath);
    const current = await createManifest(aggregate.projectPath);
    const changed = compareManifests(base, worker);
    const conflicts = changed.filter(({ path }) => !sameEntry(current[path], base[path]) && !sameEntry(current[path], worker[path]));
    if (conflicts.length > 0) {
      throw new DevTeamError('INTEGRATION_CONFLICT', `Conflicting files: ${conflicts.map(({ path }) => path).join(', ')}`);
    }
    if (changed.every(({ path }) => sameEntry(current[path], worker[path]))) {
      return { revision: manifestHash(current), alreadyApplied: true };
    }

    const version = join(aggregateMeta.versionsPath, newId('version'));
    await copyTree(aggregate.projectPath, version);
    for (const { path } of changed) await copyEntry(source.projectPath, version, path, worker[path]);
    const nextLink = join(aggregate.root, `current-${newId('link')}`);
    await symlink(relative(aggregate.root, version), nextLink, 'dir');
    await rename(nextLink, aggregate.projectPath);
    const result = await createManifest(aggregate.projectPath);
    return { revision: manifestHash(result), alreadyApplied: false };
  }

  async applyDelivery(project: ProjectRecord, aggregate: WorkspaceRecord): Promise<IntegrationReceipt> {
    const metadata = parseMetadata(aggregate);
    const baseline = await createManifest(metadata.baselinePath);
    const desired = await createManifest(aggregate.projectPath);
    const current = await createManifest(project.root);
    const changed = compareManifests(baseline, desired);
    const conflicts = changed.filter(({ path }) => !sameEntry(current[path], baseline[path]) && !sameEntry(current[path], desired[path]));
    if (conflicts.length > 0) {
      throw new DevTeamError('DELIVERY_CONFLICT', `Source changed since scope creation: ${conflicts.map(({ path }) => path).join(', ')}`);
    }
    if (changed.every(({ path }) => sameEntry(current[path], desired[path]))) {
      return { revision: manifestHash(desired), alreadyApplied: true };
    }

    const backup = join(aggregate.root, `source-backup-${newId('apply')}`);
    await copyTree(project.root, backup);
    const journalPath = join(aggregate.root, 'apply-journal.json');
    await writeFile(journalPath, JSON.stringify({ status: 'applying', source: project.root, backup, files: changed.map(({ path }) => path) }, null, 2));
    try {
      for (const { path } of changed) await copyEntry(aggregate.projectPath, project.root, path, desired[path]);
      await writeFile(journalPath, JSON.stringify({ status: 'complete', source: project.root, backup, files: changed.map(({ path }) => path) }, null, 2));
    } catch (error) {
      const backupManifest = await createManifest(backup);
      for (const { path } of changed) await copyEntry(backup, project.root, path, backupManifest[path]);
      throw error;
    }
    return { revision: manifestHash(desired), alreadyApplied: false, details: `Backup retained at ${backup}` };
  }

  async archive(_workspace: WorkspaceRecord): Promise<void> {}

  async cleanup(_project: ProjectRecord, workspace: WorkspaceRecord): Promise<void> {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  // Resolve only the tree root so an aggregate's "current" pointer is copied as a tree,
  // while symlinks contained inside that tree remain symlinks.
  await cp(await realpath(source), destination, { recursive: true, preserveTimestamps: true, dereference: false });
}

async function createManifest(root: string): Promise<Manifest> {
  const result: Manifest = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      const info = await lstat(absolute);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        result[path] = { kind: 'symlink', hash: createHash('sha256').update(target).digest('hex'), mode: info.mode };
      } else if (entry.isFile()) {
        result[path] = { kind: 'file', hash: createHash('sha256').update(await readFile(absolute)).digest('hex'), mode: info.mode };
      }
    }
  };
  await visit(root);
  return result;
}

function manifestHash(manifest: Manifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function compareManifests(before: Manifest, after: Manifest): Array<{ path: string; status: 'A' | 'M' | 'D' }> {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.flatMap((path) => {
    if (sameEntry(before[path], after[path])) return [];
    return [{ path, status: before[path] ? (after[path] ? 'M' as const : 'D' as const) : 'A' as const }];
  });
}

function sameEntry(left: ManifestEntry | undefined, right: ManifestEntry | undefined): boolean {
  return left === right || Boolean(left && right && left.kind === right.kind && left.hash === right.hash && left.mode === right.mode);
}

async function copyEntry(sourceRoot: string, targetRoot: string, path: string, entry: ManifestEntry | undefined): Promise<void> {
  const source = join(sourceRoot, path);
  const target = join(targetRoot, path);
  await rm(target, { recursive: true, force: true });
  if (!entry) return;
  await mkdir(dirname(target), { recursive: true });
  if (entry.kind === 'symlink') await symlink(await readlink(source), target);
  else {
    await cp(source, target, { preserveTimestamps: true });
    await chmod(target, entry.mode);
  }
}

function parseMetadata(workspace: WorkspaceRecord): NoVcsMetadata {
  const value = JSON.parse(workspace.metadata) as Partial<NoVcsMetadata>;
  if (!value.baselinePath) throw new DevTeamError('INVALID_WORKSPACE', `Workspace ${workspace.id} has no baseline`);
  return value as NoVcsMetadata;
}
