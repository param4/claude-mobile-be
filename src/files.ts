// File search for @ mentions, and a folder browser for starting chats in new folders.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Folder } from '@claude-mobile/protocol';

const run = promisify(execFile);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.expo', 'Pods', '.venv', '__pycache__']);
const WALK_LIMIT = 20_000;
const CACHE_MS = 30_000;

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

async function gitFiles(cwd: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024, timeout: 5000 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < WALK_LIMIT) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(child);
      } else if (e.isFile()) out.push(child);
    }
  }
  return out;
}

function allFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = gitFiles(cwd).then((g) => g ?? walk(cwd));
  cache.set(cwd, { at: Date.now(), files });
  files.catch(() => cache.delete(cwd));
  return files;
}

// Best matches first: file name starts with the query, then file name contains it, then the path does.
export async function searchFiles(cwd: string, q: string, limit = 30): Promise<{ files: string[]; truncated: boolean }> {
  const files = await allFiles(cwd);
  const needle = q.toLowerCase();
  if (!needle) return { files: files.slice(0, limit), truncated: files.length > limit };
  const ranked: [number, string][] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const rank = base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    if (rank >= 0) ranked.push([rank, f]);
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
  return { files: ranked.slice(0, limit).map(([, f]) => f), truncated: ranked.length > limit };
}

export function insideHome(p: string, home = os.homedir()): boolean {
  const rel = path.relative(home, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// An existing folder inside the home folder, resolved through symlinks; otherwise undefined.
export async function realFolder(p: string, home = os.homedir()): Promise<string | undefined> {
  if (!path.isAbsolute(p)) return undefined;
  try {
    const real = await fs.realpath(p);
    if (!insideHome(real, await fs.realpath(home))) return undefined;
    return (await fs.stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

export async function listFolders(
  dir: string,
  chatsIn: (folder: string) => number,
  home = os.homedir(),
): Promise<{ path: string; parent?: string; folders: Folder[] } | undefined> {
  const real = await realFolder(dir, home);
  if (!real) return undefined;
  const realHome = await fs.realpath(home);
  const entries = await fs.readdir(real, { withFileTypes: true });
  const folders: Folder[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'Library') continue;
    const full = path.join(real, e.name);
    const git = await fs.stat(path.join(full, '.git')).then(() => true, () => false);
    folders.push({ name: e.name, path: full, git, chats: chatsIn(full) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: real, parent: real === realHome ? undefined : path.dirname(real), folders };
}
