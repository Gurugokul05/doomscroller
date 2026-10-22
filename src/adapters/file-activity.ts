import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  'bin',
  'obj',
]);

export interface ScanOptions {
  maxEntries?: number;
  ignoredDirectories?: Set<string>;
}

/**
 * Returns the newest modification time found in a workspace. Used only as an
 * activity signal, so the scan is deliberately bounded and skips build output.
 */
export async function scanMaxMtime(root: string, options: ScanOptions = {}): Promise<number> {
  const maxEntries = options.maxEntries ?? 4000;
  const ignored = options.ignoredDirectories ?? IGNORED_DIRECTORIES;

  let newest = 0;
  let entriesSeen = 0;
  const stack: string[] = [root];

  while (stack.length > 0 && entriesSeen < maxEntries) {
    const directory = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entriesSeen >= maxEntries) break;
      entriesSeen++;

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stats = await fs.promises.stat(path.join(directory, entry.name));
        if (stats.mtimeMs > newest) newest = stats.mtimeMs;
      } catch {
        // File disappeared or is locked; ignore.
      }
    }
  }

  return newest;
}

export type MtimeScanner = (root: string) => Promise<number>;
