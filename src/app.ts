import crypto from 'node:crypto';
import os from 'node:os';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import express, { type NextFunction, type Request, type Response } from 'express';
import { CreateSessionRequest, ForkRequest, SessionQuery } from '@claude-mobile/protocol';
import { z } from 'zod';
import { createScratchFolder, registerDesktopSession } from './desktop.js';
import { listFolders, realFolder, searchFiles } from './files.js';
import type { LiveManager } from './live.js';
import { readPresets } from './presets.js';
import { NO_FOLDER, type SessionStore } from './sessions.js';
import { MAX_UPLOAD_BYTES, type UploadStore } from './uploads.js';

export type ForkFn = (sessionId: string, options: { upToMessageId?: string; title?: string }) => Promise<{ sessionId: string }>;

const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

function requireToken(token: string) {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const given = Buffer.from(req.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

// A known project, or any existing folder inside the home folder (chosen in the app's folder picker).
async function projectPath(store: SessionStore, key: string, home: string): Promise<string | undefined> {
  if (key === NO_FOLDER) return home;
  return (await store.projects()).find((p) => p.key === key)?.path ?? (await realFolder(key, home));
}

export function createApp({
  token,
  store,
  live,
  uploads,
  fork = forkSession,
  home = os.homedir(),
}: {
  token: string;
  store: SessionStore;
  live: LiveManager;
  uploads: UploadStore;
  fork?: ForkFn;
  home?: string;
}) {
  const app = express();
  app.disable('x-powered-by');
  // Only for previewing the app in a browser during development; native apps don't need CORS.
  const devOrigin = process.env.CM_DEV_CORS_ORIGIN;
  if (devOrigin) {
    app.use((req, res, next) => {
      res.set({ 'Access-Control-Allow-Origin': devOrigin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name' });
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }
  const json = express.json({ limit: '1mb' });
  // Uploads keep their raw body, whatever their content type.
  app.use((req, res, next) => (req.path === '/api/uploads' ? next() : json(req, res, next)));
  app.use('/api', requireToken(token));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: os.hostname() });
  });

  app.get('/api/projects', async (_req, res) => {
    res.json({ projects: await store.projects() });
  });

  app.get('/api/sessions', async (req, res) => {
    const q = SessionQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: z.prettifyError(q.error) });
      return;
    }
    res.json({ groups: await store.query(q.data) });
  });

  // Commands, models and starting settings for a new chat in a project.
  app.get('/api/catalog', async (req, res) => {
    const key = String(req.query.project ?? '');
    const cwd = await projectPath(store, key, home);
    if (!cwd) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const [catalog, defaults] = await Promise.all([live.catalog.get(cwd), store.defaultsFor(key)]);
    res.json({ ...catalog, defaults });
  });

  // Starts a chat from the phone. Only known project folders (or a fresh "No folder" scratch folder) are allowed.
  app.post('/api/sessions', async (req, res) => {
    const body = CreateSessionRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const { project, text, attachments, fastMode, ...overrides } = body.data;
    if (!text.trim() && !attachments?.length) {
      res.status(400).json({ error: 'empty message' });
      return;
    }
    const folder = project === NO_FOLDER ? undefined : await projectPath(store, project, home);
    if (project !== NO_FOLDER && !folder) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const content = await uploads.toContent(text, attachments);
    const cwd = folder ?? (await createScratchFolder(store.desktopRoot));
    const defaults = await store.defaultsFor(project);
    const settings = { ...defaults, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) };
    const id = await registerDesktopSession(store.desktopRoot, {
      cwd,
      cliSessionId: crypto.randomUUID(),
      title: text.trim().split('\n')[0]!.slice(0, 60) || 'Attachment',
      model: settings.model,
      effort: settings.effort,
      permissionMode: settings.permissionMode,
    });
    const summary = await store.get(id);
    if (!summary) throw new Error('new session was not registered');
    const session = live.create(summary);
    if (fastMode !== undefined) await session.updateSettings({ fastMode });
    await session.send(text, content);
    res.status(201).json({ sessionId: id });
  });

  // Attachments: the raw file as the body, its name in X-File-Name (URI-encoded).
  app.post('/api/uploads', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) {
      res.status(400).json({ error: 'empty upload' });
      return;
    }
    let name = 'file';
    try {
      name = decodeURIComponent(req.get('x-file-name') ?? 'file');
    } catch {
      // keep the default
    }
    const mediaType = (req.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    res.status(201).json(await uploads.save(data, name, mediaType));
  });

  app.get('/api/uploads/:id', async (req, res) => {
    const meta = await uploads.get(req.params.id);
    if (!meta) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.type(meta.mediaType).sendFile(meta.file);
  });

  app.get('/api/sessions/:id/images/:uuid/:index', async (req, res) => {
    const image = await store.image(req.params.id, req.params.uuid, Number(req.params.index));
    if (!image) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.set('Cache-Control', 'private, max-age=86400').type(image.mediaType).send(image.data);
  });

  // File names for @ mentions, in a project folder or a session's folder.
  app.get('/api/files', async (req, res) => {
    const sessionId = typeof req.query.session === 'string' ? req.query.session : undefined;
    const cwd = sessionId ? (await store.get(sessionId))?.cwd : await projectPath(store, String(req.query.project ?? ''), home);
    if (!cwd || req.query.project === NO_FOLDER) {
      res.status(404).json({ error: 'folder not found' });
      return;
    }
    res.json(await searchFiles(cwd, String(req.query.q ?? '')));
  });

  app.get('/api/folders', async (req, res) => {
    const counts = await store.chatCounts();
    const result = await listFolders(String(req.query.path || home), (f) => counts.get(f) ?? 0, home);
    if (!result) {
      res.status(404).json({ error: 'folder not found' });
      return;
    }
    res.json(result);
  });

  app.get('/api/presets', async (_req, res) => {
    res.json({ presets: await readPresets(store.desktopRoot) });
  });

  // A copy of the chat, whole or up to a message, registered in the desktop sidebar like any other chat.
  app.post('/api/sessions/:id/fork', async (req, res) => {
    const body = ForkRequest.safeParse(req.body ?? {});
    const source = await store.get(req.params.id);
    if (!body.success || !source) {
      res.status(body.success ? 404 : 400).json({ error: body.success ? 'session not found' : z.prettifyError(body.error) });
      return;
    }
    let upTo = body.data.upToMessageId;
    if (upTo && body.data.before) {
      const parent = await store.parentOf(source.id, upTo);
      if (!parent) {
        res.status(400).json({ error: parent === null ? 'nothing before the first message' : 'message not found' });
        return;
      }
      upTo = parent;
    }
    const title = `${source.title} (fork)`;
    const forked = await fork(source.cliSessionId, { upToMessageId: upTo, title });
    const id = await registerDesktopSession(store.desktopRoot, {
      cwd: source.cwd,
      cliSessionId: forked.sessionId,
      title,
      model: source.model,
      effort: source.effort,
      permissionMode: source.permissionMode ?? 'default',
      forkedFrom: source.id,
    });
    res.status(201).json({ sessionId: id });
  });

  app.get('/api/sessions/:id/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const matches = q ? await store.search(req.params.id, q) : [];
    if (!matches) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json({ matches });
  });

  app.get('/api/sessions/:id/export', async (req, res) => {
    const result = await store.markdown(req.params.id);
    if (!result) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(result);
  });

  app.get('/api/sessions/:id/messages', async (req, res) => {
    const paging = Paging.safeParse(req.query);
    if (!paging.success) {
      res.status(400).json({ error: z.prettifyError(paging.error) });
      return;
    }
    const result = await store.messages(req.params.id, paging.data.limit, paging.data.offset);
    if (!result) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(result);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
