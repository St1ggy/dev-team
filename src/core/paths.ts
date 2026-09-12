import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DevTeamError } from './errors.js';

export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export function assertInside(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DevTeamError('PATH_OUTSIDE_WORKSPACE', `${child} is outside ${parent}`);
  }
}

export async function assertDirectory(path: string): Promise<void> {
  const value = await stat(path).catch(() => null);
  if (!value?.isDirectory()) {
    throw new DevTeamError('NOT_A_DIRECTORY', `Directory does not exist: ${path}`);
  }
}

export function nearestExistingParent(path: string): string {
  let current = resolve(path);
  while (dirname(current) !== current) {
    current = dirname(current);
    return current;
  }
  return current;
}
