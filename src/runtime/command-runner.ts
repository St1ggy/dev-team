import { spawn } from 'node:child_process';
import { DevTeamError } from '../core/errors.js';

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  allowFailure?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options: RunOptions): Promise<CommandResult>;
}

export class ProcessCommandRunner implements CommandRunner {
  run(command: string, args: string[], options: RunOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        const result = { code: code ?? 1, stdout, stderr };
        if (result.code !== 0 && !options.allowFailure) {
          reject(
            new DevTeamError(
              'COMMAND_FAILED',
              `${command} ${args.join(' ')} failed (${result.code}): ${stderr.trim() || stdout.trim()}`,
              result,
            ),
          );
          return;
        }
        resolve(result);
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}
