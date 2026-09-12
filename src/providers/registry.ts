import type { ProjectRecord, ProviderKind } from '../core/types.js';
import type { VcsProvider } from './provider.js';

export class ProviderRegistry {
  private readonly providers: Map<ProviderKind, VcsProvider>;

  constructor(providers: VcsProvider[]) {
    this.providers = new Map();
    for (const provider of providers) {
      if (this.providers.has(provider.kind)) throw new Error(`Provider is configured more than once: ${provider.kind}`);
      this.providers.set(provider.kind, provider);
    }
  }

  get(kind: ProviderKind): VcsProvider {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`Provider is not configured: ${kind}`);
    return provider;
  }

  async detect(path: string, requested?: ProviderKind): Promise<{ provider: VcsProvider; repository: Awaited<ReturnType<VcsProvider['detect']>> }> {
    if (requested) {
      const provider = this.get(requested);
      const repository = await provider.detect(path);
      if (!repository) throw new Error(`${requested} provider cannot use ${path}`);
      return { provider, repository };
    }
    for (const provider of this.providers.values()) {
      const repository = await provider.detect(path);
      if (repository) return { provider, repository };
    }
    throw new Error(`No provider can use ${path}`);
  }

  forProject(project: ProjectRecord): VcsProvider {
    return this.get(project.provider);
  }
}
