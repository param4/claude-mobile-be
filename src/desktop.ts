// Reads the Claude desktop app's per-session metadata files (local_<uuid>.json).
// The format is undocumented, so parsing is lenient and unknown files are skipped.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const DesktopSessionFile = z.object({
  sessionId: z.string(),
  cliSessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  isArchived: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  createdAt: z.number(),
  lastActivityAt: z.number().optional(),
});

export type DesktopSession = {
  id: string;
  cliSessionId: string;
  cwd: string;
  title?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  archived: boolean;
  pinned: boolean;
  createdAt: number;
  lastActivityAt: number;
};

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function readArchivedIndex(dir: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'archived-sessions.idx'), 'utf8'));
    return new Set(Array.isArray(raw?.archived) ? raw.archived.filter((x: unknown) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

// ---- Registering phone-started chats so the desktop sidebar lists them ----

// Fields copied from an existing session file: app-wide state the desktop expects on every session.
const TEMPLATE_FIELDS = [
  'enabledMcpTools',
  'remoteMcpServersConfig',
  'chromePermissionMode',
  'autoChosenInApp',
  'classifierSummaryEnabled',
  'reportFindingsCard',
  'autoModeServerFallbackPrompt',
  'promptAppendSnapshot',
];

// The most recently written valid session file: the closest match to what the desktop writes today.
async function newestTemplate(root: string): Promise<{ file: string; data: Record<string, any> } | undefined> {
  const files: { file: string; mtime: number }[] = [];
  for (const account of await subdirs(root)) {
    for (const org of await subdirs(account)) {
      for (const f of await fs.readdir(org)) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        const file = path.join(org, f);
        files.push({ file, mtime: (await fs.stat(file)).mtimeMs });
      }
    }
  }
  for (const { file } of files.sort((a, b) => b.mtime - a.mtime)) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (DesktopSessionFile.safeParse(data).success) return { file, data };
    } catch {
      // skip unreadable files
    }
  }
  return undefined;
}

export type NewDesktopSession = {
  cwd: string;
  cliSessionId: string;
  title: string;
  model?: string;
  effort?: string;
  permissionMode: string;
  // The desktop session this one was forked from.
  forkedFrom?: string;
};

// The desktop app keeps folderless chats in scratch-workspaces/<account>/<org>/scratch-<date>-<hex>,
// next to its sessions folder.
export function scratchRoot(desktopRoot: string) {
  return path.join(path.dirname(desktopRoot), 'scratch-workspaces');
}

export async function createScratchFolder(desktopRoot: string, now = new Date()): Promise<string> {
  const template = await newestTemplate(desktopRoot);
  if (!template) throw new Error('No desktop sessions found to copy the layout from');
  const org = path.dirname(template.file);
  const account = path.dirname(org);
  const date = now.toISOString().slice(0, 10);
  const dir = path.join(scratchRoot(desktopRoot), path.basename(account), path.basename(org), `scratch-${date}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Adds a new local_<uuid>.json next to the newest existing one. Never edits existing files.
export async function registerDesktopSession(root: string, s: NewDesktopSession, now = Date.now()): Promise<string> {
  const found = await newestTemplate(root);
  if (!found) throw new Error('No desktop sessions found to copy the format from');
  const { file: templateFile, data: template } = found;
  const id = `local_${crypto.randomUUID()}`;
  const record: Record<string, unknown> = {
    sessionId: id,
    cliSessionId: s.cliSessionId,
    cwd: s.cwd,
    originCwd: s.cwd,
    gitAnchorsFolderRealpath: s.cwd,
    createdAt: now,
    lastActivityAt: now,
    lastFocusedAt: now,
    model: s.model ?? template.model,
    effort: s.effort ?? template.effort,
    isArchived: false,
    title: s.title,
    titleSource: 'auto',
    titleTurn: 0,
    permissionMode: s.permissionMode,
    lastSpawnRootDetected: false,
    remoteControlAutoEligible: false,
    steeredByRemoteClient: false,
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    spawnSeed: {},
    ...(s.forkedFrom ? { forkedFromSessionId: s.forkedFrom } : {}),
  };
  for (const key of TEMPLATE_FIELDS) if (key in template) record[key] = template[key];

  const dir = path.dirname(templateFile);
  const tmp = path.join(dir, `.${id}.json.tmp`);
  await fs.writeFile(tmp, JSON.stringify(record), { flag: 'wx' });
  try {
    // link() fails if the target exists, so an existing file can never be replaced.
    await fs.link(tmp, path.join(dir, `${id}.json`));
  } finally {
    await fs.unlink(tmp);
  }
  return id;
}

// Layout: <root>/<accountUuid>/<orgUuid>/local_<uuid>.json
export async function readDesktopSessions(root: string): Promise<DesktopSession[]> {
  const out: DesktopSession[] = [];
  for (const account of await subdirs(root)) {
    for (const org of await subdirs(account)) {
      const files = await fs.readdir(org);
      const deleted = new Set(files.filter((f) => f.startsWith('deleted_')).map((f) => f.slice('deleted_'.length)));
      const archivedIdx = await readArchivedIndex(org);
      for (const file of files) {
        if (!file.startsWith('local_') || !file.endsWith('.json')) continue;
        const uuid = file.slice('local_'.length, -'.json'.length);
        if (deleted.has(uuid)) continue;
        let parsed;
        try {
          parsed = DesktopSessionFile.safeParse(JSON.parse(await fs.readFile(path.join(org, file), 'utf8')));
        } catch {
          continue;
        }
        if (!parsed.success) continue;
        const s = parsed.data;
        out.push({
          id: s.sessionId,
          cliSessionId: s.cliSessionId,
          cwd: s.cwd,
          title: s.title,
          model: s.model,
          effort: s.effort,
          permissionMode: s.permissionMode,
          archived: Boolean(s.isArchived) || archivedIdx.has(s.sessionId),
          pinned: Boolean(s.isStarred),
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt ?? s.createdAt,
        });
      }
    }
  }
  return out;
}
