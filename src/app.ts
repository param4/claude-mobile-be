import crypto from 'node:crypto';
import os from 'node:os';
import express, { type NextFunction, type Request, type Response } from 'express';
import { CreateSessionRequest, SessionQuery } from '@claude-mobile/protocol';
import { z } from 'zod';
import { createScratchFolder, registerDesktopSession } from './desktop.js';
import type { LiveManager } from './live.js';
import { NO_FOLDER, type SessionStore } from './sessions.js';

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

async function projectPath(store: SessionStore, key: string): Promise<string | undefined> {
  if (key === NO_FOLDER) return os.homedir();
  return (await store.projects()).find((p) => p.key === key)?.path;
}

export function createApp({ token, store, live }: { token: string; store: SessionStore; live: LiveManager }) {
  const app = express();
  app.disable('x-powered-by');
  // Only for previewing the app in a browser during development; native apps don't need CORS.
  const devOrigin = process.env.CM_DEV_CORS_ORIGIN;
  if (devOrigin) {
    app.use((req, res, next) => {
      res.set({ 'Access-Control-Allow-Origin': devOrigin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }
  app.use(express.json({ limit: '1mb' }));
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
    const cwd = await projectPath(store, key);
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
    const { project, text, ...overrides } = body.data;
    if (project !== NO_FOLDER && !(await projectPath(store, project))) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const cwd = project === NO_FOLDER ? await createScratchFolder(store.desktopRoot) : project;
    const defaults = await store.defaultsFor(project);
    const settings = { ...defaults, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) };
    const id = await registerDesktopSession(store.desktopRoot, {
      cwd,
      cliSessionId: crypto.randomUUID(),
      title: text.split('\n')[0]!.slice(0, 60),
      model: settings.model,
      effort: settings.effort,
      permissionMode: settings.permissionMode,
    });
    const summary = await store.get(id);
    if (!summary) throw new Error('new session was not registered');
    live.create(summary).send(text);
    res.status(201).json({ sessionId: id });
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
