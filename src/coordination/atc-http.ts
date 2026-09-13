import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DevTeamError } from '../core/errors.js';

interface AtcProject {
  id: string;
  name: string;
  description?: string;
}

export class AtcHttpClient {
  constructor(private readonly baseUrl: string, private readonly dbPath?: string) {}

  async ensureProject(identity: string, name: string, baseBranch: string): Promise<AtcProject> {
    return this.withProjectLock(async () => {
      const marker = `dev-team:${identity}`;
      const listed = await this.request<{ projects: AtcProject[] }>('GET', '/api/projects');
      const existing = listed.projects.find((project) => project.description?.includes(marker));
      if (existing) return existing;
      const created = await this.request<{ project: AtcProject }>('POST', '/api/projects', {
        name, description: `Managed by ${marker}`, baseBranch, autoDispatch: false,
      });
      return created.project;
    });
  }

  async createTask(projectId: string, input: {
    title: string;
    description?: string;
    priority?: string;
    labels?: string[];
    dependsOn?: string[];
    requiresReview?: boolean;
  }): Promise<Record<string, unknown>> {
    const value = await this.request<{ task: Record<string, unknown> }>('POST', '/api/tasks', {
      projectId,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
      requiresReview: input.requiresReview ?? true,
    });
    return value.task;
  }

  async listTasks(projectId: string): Promise<Record<string, unknown>[]> {
    const value = await this.request<{ tasks: Record<string, unknown>[] }>('GET', `/api/tasks?projectId=${encodeURIComponent(projectId)}`);
    return value.tasks;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const value = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'error' in value ? value.error?.message : undefined;
      throw new DevTeamError('ATC_HTTP_FAILED', message ?? `ATC HTTP ${method} ${path} failed with ${response.status}`);
    }
    return value as T;
  }

  private async withProjectLock<T>(action: () => Promise<T>): Promise<T> {
    if (!this.dbPath) return action();
    const lockPath = `${this.dbPath}.project.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const handle = await open(lockPath, 'wx');
        try {
          return await action();
        } finally {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30_000) await unlink(lockPath).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new DevTeamError('ATC_PROJECT_LOCKED', `Timed out waiting to register the ATC project for ${this.dbPath}`);
  }
}
