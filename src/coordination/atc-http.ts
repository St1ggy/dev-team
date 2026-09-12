import { DevTeamError } from '../core/errors.js';

interface AtcProject {
  id: string;
  name: string;
  description?: string;
}

export class AtcHttpClient {
  constructor(private readonly baseUrl: string) {}

  async ensureProject(identity: string, name: string, baseBranch: string): Promise<AtcProject> {
    const marker = `dev-team:${identity}`;
    const listed = await this.request<{ projects: AtcProject[] }>('GET', '/api/projects');
    const existing = listed.projects.find((project) => project.description?.includes(marker));
    if (existing) return existing;
    const created = await this.request<{ project: AtcProject }>('POST', '/api/projects', {
      name, description: `Managed by ${marker}`, baseBranch, autoDispatch: false,
    });
    return created.project;
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
}
