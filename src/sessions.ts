import fs from 'node:fs/promises';
import path from 'node:path';
import { Effort, PermissionMode } from '@claude-mobile/protocol';
import type { LiveSettings, Project, SessionGroup, SessionQuery, SessionSummary } from '@claude-mobile/protocol';
import { readDesktopSessions, scratchRoot } from './desktop.js';
import {
  activeChain,
  findImage,
  findTranscript,
  lastPrompt,
  parentOf,
  readTranscript,
  searchItems,
  toChatItems,
  toMarkdown,
} from './transcripts.js';

const DAY = 24 * 60 * 60 * 1000;

export type LiveState = 'working' | 'needs-input';

export type StoreOptions = {
  desktopRoot: string;
  transcriptsRoot: string;
  now?: () => number;
  liveState?: (id: string) => LiveState | undefined;
};

export class SessionStore {
  private promptCache = new Map<string, { mtimeMs: number; prompt?: string }>();

  get desktopRoot() {
    return this.opts.desktopRoot;
  }

  constructor(private opts: StoreOptions) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  async list(): Promise<SessionSummary[]> {
    const sessions = await readDesktopSessions(this.opts.desktopRoot);
    return Promise.all(
      sessions.map(async (s) => {
        const transcript = await this.transcriptInfo(s.cwd, s.cliSessionId);
        return {
        id: s.id,
        cliSessionId: s.cliSessionId,
        title: s.title?.trim() || 'Untitled',
        cwd: s.cwd,
        ...projectOf(s.cwd, scratchRoot(this.opts.desktopRoot)),
        model: s.model,
        effort: s.effort,
        permissionMode: s.permissionMode,
        archived: s.archived,
        pinned: s.pinned,
        createdAt: s.createdAt,
        // The desktop only updates lastActivityAt for turns it runs itself; the transcript knows better.
        lastActivityAt: Math.max(s.lastActivityAt, transcript?.mtimeMs ?? 0),
        lastPrompt: transcript?.prompt,
        liveState: this.opts.liveState?.(s.id),
      };
      }),
    );
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    return (await this.list()).find((s) => s.id === id);
  }

  private async transcriptInfo(cwd: string, cliSessionId: string): Promise<{ mtimeMs: number; prompt?: string } | undefined> {
    const file = await findTranscript(this.opts.transcriptsRoot, cwd, cliSessionId);
    if (!file) return undefined;
    const { mtimeMs } = await fs.stat(file);
    const hit = this.promptCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit;
    const info = { mtimeMs, prompt: lastPrompt(await readTranscript(file)) };
    this.promptCache.set(file, info);
    return info;
  }

  // Settings for a new chat: those of the project's latest chat, else of the latest chat anywhere.
  async defaultsFor(projectKey: string): Promise<LiveSettings> {
    const all = (await this.list()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const s = all.find((x) => x.projectKey === projectKey) ?? all[0];
    const effort = Effort.safeParse(s?.effort);
    const mode = PermissionMode.safeParse(s?.permissionMode);
    return { model: s?.model, effort: effort.success ? effort.data : undefined, permissionMode: mode.success ? mode.data : 'default' };
  }

  async projects(): Promise<Project[]> {
    const byKey = new Map<string, Project>();
    for (const s of await this.list()) {
      if (s.archived) continue;
      const p = byKey.get(s.projectKey) ?? {
        key: s.projectKey,
        name: s.projectName,
        path: s.projectKey === NO_FOLDER ? '' : s.cwd,
        sessionCount: 0,
        lastActivityAt: 0,
        pinned: false,
      };
      p.sessionCount++;
      p.lastActivityAt = Math.max(p.lastActivityAt, s.lastActivityAt);
      p.pinned ||= s.pinned;
      byKey.set(s.projectKey, p);
    }
    return [...byKey.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async query(q: SessionQuery): Promise<SessionGroup[]> {
    return groupSessions(filterSessions(await this.list(), q), q, this.now(), this.opts.liveState);
  }

  private async transcript(id: string) {
    const session = await this.get(id);
    if (!session) return undefined;
    const file = await findTranscript(this.opts.transcriptsRoot, session.cwd, session.cliSessionId);
    const entries = file ? await readTranscript(file) : [];
    return { session, entries };
  }

  private async items(id: string) {
    const t = await this.transcript(id);
    if (!t) return undefined;
    const imageUrl = (uuid: string, index: number) => `/api/sessions/${encodeURIComponent(id)}/images/${uuid}/${index}`;
    return { session: t.session, items: toChatItems(activeChain(t.entries), t.entries, t.session.cwd, imageUrl) };
  }

  async messages(id: string, limit: number, offset: number) {
    const found = await this.items(id);
    if (!found) return undefined;
    const { session, items: all } = found;
    // offset counts back from the newest item, so the app can page upwards.
    const end = Math.max(0, all.length - offset);
    const start = Math.max(0, end - limit);
    return { session, items: all.slice(start, end), hasMore: start > 0 };
  }

  async search(id: string, q: string) {
    const found = await this.items(id);
    return found && searchItems(found.items, q);
  }

  async markdown(id: string) {
    const found = await this.items(id);
    return found && { title: found.session.title, markdown: toMarkdown(found.session.title, found.items) };
  }

  async image(id: string, uuid: string, index: number) {
    const t = await this.transcript(id);
    return t && findImage(t.entries, uuid, index);
  }

  // Where a rewind to this message resumes: the entry before it. null for the first message.
  async parentOf(id: string, uuid: string): Promise<string | null | undefined> {
    const t = await this.transcript(id);
    return t && parentOf(t.entries, uuid);
  }

  async chatCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const s of await this.list()) if (!s.archived) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
    return counts;
  }
}

export const NO_FOLDER = 'no-folder';

export function projectOf(cwd: string, scratch: string): { projectKey: string; projectName: string } {
  if (cwd.startsWith(scratch + path.sep)) return { projectKey: NO_FOLDER, projectName: 'No folder' };
  return { projectKey: cwd, projectName: path.basename(cwd) || cwd };
}

export function filterSessions(sessions: SessionSummary[], q: SessionQuery): SessionSummary[] {
  const needle = q.q?.toLowerCase();
  const filtered = sessions.filter((s) => {
    if (q.project && s.projectKey !== q.project) return false;
    if (q.status === 'active' && s.archived) return false;
    if (q.status === 'archived' && !s.archived) return false;
    if (needle && ![s.title, s.lastPrompt, s.projectName].some((f) => f?.toLowerCase().includes(needle))) return false;
    return true;
  });
  const cmp: Record<SessionQuery['sort'], (a: SessionSummary, b: SessionSummary) => number> = {
    recency: (a, b) => b.lastActivityAt - a.lastActivityAt,
    created: (a, b) => b.createdAt - a.createdAt,
    alpha: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  };
  return filtered.sort(cmp[q.sort]);
}

function dateBucket(ts: number, now: number): [string, string] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return ['today', 'Today'];
  if (ts >= startOfToday - DAY) return ['yesterday', 'Yesterday'];
  if (ts >= startOfToday - 7 * DAY) return ['week', 'Last 7 days'];
  if (ts >= startOfToday - 30 * DAY) return ['month', 'Last 30 days'];
  return ['older', 'Older'];
}

export function groupSessions(
  sessions: SessionSummary[],
  q: SessionQuery,
  now: number,
  liveState?: (id: string) => LiveState | undefined,
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  const add = (key: string, label: string, s: SessionSummary) => {
    const g = groups.get(key) ?? { key, label, sessions: [] };
    g.sessions.push(s);
    groups.set(key, g);
  };

  // Pinned chats get their own section on top, like the desktop sidebar.
  const pinned = q.status === 'archived' ? [] : sessions.filter((s) => s.pinned);
  for (const s of pinned) add('pinned', 'Pinned', s);

  for (const s of sessions) {
    if (pinned.includes(s)) continue;
    switch (q.groupBy) {
      case 'date': {
        const [key, label] = dateBucket(s.lastActivityAt, now);
        add(key, label, s);
        break;
      }
      case 'project':
        add(`project:${s.projectKey}`, s.projectName, s);
        break;
      case 'state': {
        const state = liveState?.(s.id);
        if (state === 'needs-input') add('needs-input', 'Needs input', s);
        else if (state === 'working') add('working', 'Working', s);
        else add('idle', 'Idle', s);
        break;
      }
      default:
        add('all', 'Chats', s);
    }
  }

  const order = ['pinned', 'needs-input', 'working', 'idle', 'today', 'yesterday', 'week', 'month', 'older', 'all'];
  return [...groups.values()].sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    if (ia === -1 && ib === -1) return a.label.localeCompare(b.label);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
}
