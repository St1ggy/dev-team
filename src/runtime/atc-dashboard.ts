import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export class AtcDashboard {
  private child: ChildProcess | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly stateRoot: string,
    private readonly port: number,
    private readonly nodeCommand: string,
  ) {}

  async start(): Promise<string> {
    await mkdir(join(this.stateRoot, 'logs'), { recursive: true });
    const require = createRequire(import.meta.url);
    const server = require.resolve('atc-kanban/dist/index.js');
    const log = createWriteStream(join(this.stateRoot, 'logs', 'atc.log'), { flags: 'a' });
    this.child = spawn(this.nodeCommand, [server], {
      cwd: this.stateRoot,
      env: { ...process.env, DB_PATH: this.dbPath, PORT: String(this.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.pipe(log);
    this.child.stderr?.pipe(log);
    this.child.once('exit', () => log.end());
    const url = `http://127.0.0.1:${this.port}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (this.child.exitCode !== null) throw new Error(`ATC exited before listening; see ${join(this.stateRoot, 'logs', 'atc.log')}`);
      if (await fetch(url).then((response) => response.ok).catch(() => false)) return url;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`ATC did not start at ${url}`);
  }

  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}
