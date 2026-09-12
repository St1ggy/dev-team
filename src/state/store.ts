import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  ProjectRecord,
  ProviderKind,
  ScopeRecord,
  TaskKind,
  TaskRecord,
  WorkspaceRecord,
} from '../core/types.js';

type SqlValue = string | number | null;

export class StateStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
        base_ref TEXT NOT NULL, project_relative_path TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scopes (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        delivery_task_id TEXT, aggregate_workspace_id TEXT, status TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
        workspace_id TEXT, checkpoint TEXT, submission TEXT, integration TEXT,
        FOREIGN KEY(scope_id) REFERENCES scopes(id)
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        task_id TEXT, kind TEXT NOT NULL, root TEXT NOT NULL, project_path TEXT NOT NULL,
        ref TEXT NOT NULL, base_revision TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
        status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, atc_token TEXT,
        lock_token TEXT, process_id INTEGER, status TEXT NOT NULL, workspace_id TEXT
      );
    `);
  }

  upsertProject(project: ProjectRecord): void {
    this.db.prepare(`
      INSERT INTO projects (id, root, provider, base_ref, project_relative_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(root) DO UPDATE SET provider=excluded.provider,
        base_ref=excluded.base_ref, project_relative_path=excluded.project_relative_path
    `).run(project.id, project.root, project.provider, project.baseRef, project.projectRelativePath, new Date().toISOString());
  }

  getProjectByRoot(root: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE root = ?').get(root) as Record<string, SqlValue> | undefined;
    return row ? mapProject(row) : null;
  }

  getProject(id: string): ProjectRecord {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, SqlValue> | undefined;
    if (!row) throw new Error(`Project not found: ${id}`);
    return mapProject(row);
  }

  putScope(scope: ScopeRecord): void {
    this.db.prepare(`
      INSERT INTO scopes VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,
        delivery_task_id=excluded.delivery_task_id,
        aggregate_workspace_id=excluded.aggregate_workspace_id, status=excluded.status
    `).run(scope.id, scope.projectId, scope.title, scope.deliveryTaskId, scope.aggregateWorkspaceId, scope.status);
  }

  getScope(id: string): ScopeRecord {
    const row = this.db.prepare('SELECT * FROM scopes WHERE id = ?').get(id) as Record<string, SqlValue> | undefined;
    if (!row) throw new Error(`Scope not found: ${id}`);
    return mapScope(row);
  }

  putTask(task: TaskRecord): void {
    this.db.prepare(`
      INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET workspace_id=excluded.workspace_id,
        checkpoint=excluded.checkpoint, submission=excluded.submission,
        integration=excluded.integration
    `).run(task.taskId, task.scopeId, task.kind, task.workspaceId, task.checkpoint, task.submission, task.integration);
  }

  getTask(taskId: string): TaskRecord {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Record<string, SqlValue> | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return mapTask(row);
  }

  listTasks(scopeId?: string): TaskRecord[] {
    const rows = scopeId
      ? this.db.prepare('SELECT * FROM tasks WHERE scope_id = ? ORDER BY task_id').all(scopeId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY task_id').all();
    return (rows as Array<Record<string, SqlValue>>).map(mapTask);
  }

  putWorkspace(workspace: WorkspaceRecord): void {
    this.db.prepare(`
      INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ref=excluded.ref, base_revision=excluded.base_revision,
        status=excluded.status, metadata=excluded.metadata
    `).run(
      workspace.id, workspace.projectId, workspace.scopeId, workspace.taskId,
      workspace.kind, workspace.root, workspace.projectPath, workspace.ref,
      workspace.baseRevision, workspace.status, workspace.metadata,
    );
  }

  getWorkspace(id: string): WorkspaceRecord {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, SqlValue> | undefined;
    if (!row) throw new Error(`Workspace not found: ${id}`);
    return mapWorkspace(row);
  }

  findWorkspace(scopeId: string, kind: WorkspaceRecord['kind'], taskId?: string): WorkspaceRecord | null {
    const row = taskId
      ? this.db.prepare("SELECT * FROM workspaces WHERE task_id = ? AND status != 'deleted' ORDER BY rowid DESC LIMIT 1").get(taskId)
      : this.db.prepare("SELECT * FROM workspaces WHERE scope_id = ? AND kind = ? AND status != 'deleted' ORDER BY rowid DESC LIMIT 1").get(scopeId, kind);
    return row ? mapWorkspace(row as Record<string, SqlValue>) : null;
  }

  putAgent(agent: { id: string; taskId: string | null; role: string; atcToken: string | null; lockToken: string | null; processId: number | null; status: string; workspaceId: string | null }): void {
    this.db.prepare(`
      INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, atc_token=excluded.atc_token,
        lock_token=excluded.lock_token, process_id=excluded.process_id,
        status=excluded.status, workspace_id=excluded.workspace_id
    `).run(agent.id, agent.taskId, agent.role, agent.atcToken, agent.lockToken, agent.processId, agent.status, agent.workspaceId);
  }

  getAgent(id: string): { id: string; taskId: string | null; role: string; atcToken: string | null; lockToken: string | null; processId: number | null; status: string; workspaceId: string | null } {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, SqlValue> | undefined;
    if (!row) throw new Error(`Agent not found: ${id}`);
    return {
      id: text(row, 'id'), taskId: nullable(row, 'task_id'), role: text(row, 'role'),
      atcToken: nullable(row, 'atc_token'), lockToken: nullable(row, 'lock_token'),
      processId: row.process_id === null ? null : Number(row.process_id), status: text(row, 'status'),
      workspaceId: nullable(row, 'workspace_id'),
    };
  }

  beginOperation(id: string, kind: string, entityId: string, payload: unknown): string {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO operations (id, kind, entity_id, status, payload, created_at, updated_at)
      VALUES (?, ?, ?, 'prepared', ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `).run(id, kind, entityId, JSON.stringify(payload), now, now);
    const row = this.db.prepare('SELECT status FROM operations WHERE id = ?').get(id) as { status: string };
    return row.status;
  }

  finishOperation(id: string, status: string, result?: unknown, error?: string): void {
    this.db.prepare(`
      UPDATE operations SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(status, result === undefined ? null : JSON.stringify(result), error ?? null, new Date().toISOString(), id);
  }

  getOperation(id: string): { status: string; result: unknown | null } | null {
    const row = this.db.prepare('SELECT status, result FROM operations WHERE id = ?').get(id) as { status: string; result: string | null } | undefined;
    return row ? { status: row.status, result: row.result ? JSON.parse(row.result) : null } : null;
  }

  listRecoverableOperations(): Array<{ id: string; kind: string; entityId: string; status: string }> {
    return this.db.prepare(`
      SELECT id, kind, entity_id AS entityId, status FROM operations
      WHERE status NOT IN ('complete', 'failed') ORDER BY created_at
    `).all() as Array<{ id: string; kind: string; entityId: string; status: string }>;
  }
}

function text(row: Record<string, SqlValue>, key: string): string {
  return String(row[key]);
}

function nullable(row: Record<string, SqlValue>, key: string): string | null {
  return row[key] === null ? null : String(row[key]);
}

function mapProject(row: Record<string, SqlValue>): ProjectRecord {
  return { id: text(row, 'id'), root: text(row, 'root'), provider: text(row, 'provider') as ProviderKind, baseRef: text(row, 'base_ref'), projectRelativePath: text(row, 'project_relative_path') };
}

function mapScope(row: Record<string, SqlValue>): ScopeRecord {
  return { id: text(row, 'id'), projectId: text(row, 'project_id'), title: text(row, 'title'), deliveryTaskId: nullable(row, 'delivery_task_id'), aggregateWorkspaceId: nullable(row, 'aggregate_workspace_id'), status: text(row, 'status') };
}

function mapTask(row: Record<string, SqlValue>): TaskRecord {
  return { taskId: text(row, 'task_id'), scopeId: text(row, 'scope_id'), kind: text(row, 'kind') as TaskKind, workspaceId: nullable(row, 'workspace_id'), checkpoint: nullable(row, 'checkpoint'), submission: nullable(row, 'submission'), integration: nullable(row, 'integration') };
}

function mapWorkspace(row: Record<string, SqlValue>): WorkspaceRecord {
  return {
    id: text(row, 'id'), projectId: text(row, 'project_id'), scopeId: text(row, 'scope_id'),
    taskId: nullable(row, 'task_id'), kind: text(row, 'kind') as WorkspaceRecord['kind'],
    root: text(row, 'root'), projectPath: text(row, 'project_path'), ref: text(row, 'ref'),
    baseRevision: text(row, 'base_revision'), status: text(row, 'status') as WorkspaceRecord['status'],
    metadata: text(row, 'metadata'),
  };
}
