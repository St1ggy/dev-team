import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

interface RuntimeMetadata {
  pid: number;
  url: string;
  dbPath: string;
}

export class AtcDashboard {
  private child: ChildProcess | null = null;
  private url: string | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly stateRoot: string,
    private readonly port: number,
    private readonly nodeCommand: string,
  ) {}

  async start(): Promise<string> {
    return this.withStartLock(() => this.startLocked());
  }

  private async startLocked(): Promise<string> {
    const url = `http://127.0.0.1:${this.port}`;
    if (await isAtcServer(url)) {
      await this.assertManaged(url);
      this.url = url;
      return url;
    }
    if (await isTcpEndpoint(url)) {
      throw new Error(`Port ${this.port} is already in use by a service that is not ATC. Choose another --port.`);
    }

    await mkdir(join(this.stateRoot, 'logs'), { recursive: true });
    const require = createRequire(import.meta.url);
    const server = require.resolve('atc-kanban/dist/index.js');
    const logFd = openSync(join(this.stateRoot, 'logs', 'atc.log'), 'a');
    try {
      this.child = spawn(this.nodeCommand, [server], {
        cwd: this.stateRoot,
        env: { ...process.env, DB_PATH: this.dbPath, PORT: String(this.port) },
        stdio: ['ignore', logFd, logFd],
        detached: true,
      });
      this.child.unref();
    } finally {
      closeSync(logFd);
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await isAtcServer(url)) {
        const info = await serverInfo(url);
        await this.writeMetadata({ pid: info.pid, url, dbPath: resolve(this.dbPath) });
        this.url = url;
        return url;
      }
      if (this.child.exitCode !== null) throw new Error(`ATC exited before listening; see ${join(this.stateRoot, 'logs', 'atc.log')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`ATC did not start at ${url}`);
  }

  stop(): void {
    if (this.child?.pid) this.child.kill('SIGTERM');
    this.child = null;
  }

  async shutdown(): Promise<void> {
    const url = this.url ?? `http://127.0.0.1:${this.port}`;
    if (await isAtcServer(url)) await this.assertManaged(url);
    await AtcDashboard.shutdown(this.port, this.url ?? undefined);
    await unlink(this.metadataPath()).catch(() => undefined);
  }

  static async shutdown(port: number, knownUrl?: string): Promise<void> {
    const url = knownUrl ?? `http://127.0.0.1:${port}`;
    if (!await isAtcServer(url)) return;
    const response = await fetch(`${url}/api/admin/shutdown`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to stop ATC at ${url}: HTTP ${response.status}`);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!await isAtcServer(url)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`ATC at ${url} did not stop`);
  }

  static async status(port: number): Promise<{ running: boolean; url: string; info?: Record<string, unknown> }> {
    const url = `http://127.0.0.1:${port}`;
    if (!await isAtcServer(url)) return { running: false, url };
    const response = await fetch(`${url}/api/admin/info`);
    const info = response.ok ? await response.json() as Record<string, unknown> : undefined;
    return { running: true, url, ...(info ? { info } : {}) };
  }

  private async assertManaged(url: string): Promise<void> {
    const metadata = await this.readMetadata();
    if (!metadata) {
      throw new Error(`ATC at ${url} is not managed by this dev-team installation. Stop it manually before reusing port ${this.port}.`);
    }
    const info = await serverInfo(url);
    if (metadata.pid !== info.pid || metadata.url !== url) {
      throw new Error(`ATC metadata at ${this.metadataPath()} does not match the server at ${url}. Stop the existing server before continuing.`);
    }
    if (resolve(metadata.dbPath) !== resolve(this.dbPath)) {
      throw new Error(`ATC at ${url} uses ${metadata.dbPath}, but this project is configured for ${resolve(this.dbPath)}. Use the shared global ATC database or choose another port.`);
    }
  }

  private async readMetadata(): Promise<RuntimeMetadata | null> {
    try {
      return JSON.parse(await readFile(this.metadataPath(), 'utf8')) as RuntimeMetadata;
    } catch {
      return null;
    }
  }

  private async writeMetadata(metadata: RuntimeMetadata): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true });
    const temporary = `${this.metadataPath()}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await rename(temporary, this.metadataPath());
  }

  private metadataPath(): string {
    return join(this.stateRoot, `runtime-${this.port}.json`);
  }

  private async withStartLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.stateRoot, { recursive: true });
    const lockPath = join(this.stateRoot, `runtime-${this.port}.lock`);
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
    throw new Error(`Timed out waiting for the ATC startup lock on port ${this.port}`);
  }
}

async function serverInfo(url: string): Promise<{ pid: number }> {
  const response = await fetch(`${url}/api/admin/info`, { signal: AbortSignal.timeout(500) });
  if (!response.ok) throw new Error(`Failed to inspect ATC at ${url}: HTTP ${response.status}`);
  const info = await response.json() as { pid?: unknown };
  if (typeof info.pid !== 'number') throw new Error(`ATC at ${url} returned invalid process metadata`);
  return { pid: info.pid };
}

async function isAtcServer(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const value = await response.json() as { status?: unknown };
    return value.status === 'ok';
  } catch {
    return false;
  }
}

async function isTcpEndpoint(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}
