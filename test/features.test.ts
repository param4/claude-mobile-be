import request from 'supertest';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerMessage, SessionSummary } from '@claude-mobile/protocol';
import { createApp, type ForkFn } from '../src/app.js';
import { LiveManager, LiveSession } from '../src/live.js';
import { SessionStore } from '../src/sessions.js';
import { encodeCwd, searchItems, splitAttachedFiles, toMarkdown } from '../src/transcripts.js';
import { UploadStore } from '../src/uploads.js';
import { fakeSdk } from './fakeSdk.js';
import { NOW, line, makeFixture, transcriptA1 } from './fixtures.js';

const TOKEN = 'y'.repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const fx = makeFixture();
  const store = new SessionStore({ ...fx, now: () => NOW });
  const sdk = fakeSdk();
  const live = new LiveManager(sdk.queryFn);
  const uploads = new UploadStore(path.join(fx.root, 'uploads'));
  const forks: { id: string; options: unknown }[] = [];
  const fork: ForkFn = async (id, options) => {
    forks.push({ id, options });
    return { sessionId: 'cli-fork' };
  };
  const app = createApp({ token: TOKEN, store, live, uploads, fork, home: fx.root });
  return { fx, store, sdk, live, uploads, forks, app };
}

describe('attachments', () => {
  it('stores uploads and sends images inline and other files as paths', async () => {
    const { app, sdk, store } = setup();
    const img = await request(app).post('/api/uploads').set(auth).set('Content-Type', 'image/png').set('X-File-Name', 'shot.png').send(PNG).expect(201);
    expect(img.body).toMatchObject({ kind: 'image', name: 'shot.png', mediaType: 'image/png', size: PNG.length });
    const doc = await request(app)
      .post('/api/uploads').set(auth).set('Content-Type', 'application/json').set('X-File-Name', encodeURIComponent('../log é.json'))
      .send(Buffer.from('{"a":1}')).expect(201);
    expect(doc.body).toMatchObject({ kind: 'file', name: 'log _.json' });

    const served = await request(app).get(`/api/uploads/${img.body.id}`).set(auth).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(served.body.equals(PNG)).toBe(true);
    await request(app).get('/api/uploads/not-an-id').set(auth).expect(404);

    const res = await request(app).post('/api/sessions').set(auth).send({ project: '/w/alpha', text: 'Look', attachments: [img.body.id, doc.body.id] }).expect(201);
    await tick();
    const content = (sdk.sent[0] as any).message.content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
    expect(content[1].type).toBe('text');
    expect(splitAttachedFiles(content[1].text)).toEqual({ text: 'Look', files: ['log _.json'] });
    expect((await store.get(res.body.sessionId))?.title).toBe('Look');
  });

  it('rejects empty messages and unknown attachments', async () => {
    const { app } = setup();
    await request(app).post('/api/sessions').set(auth).send({ project: '/w/alpha', text: '  ' }).expect(400);
    await request(app).post('/api/uploads').set(auth).set('Content-Type', 'image/png').expect(400);
  });

  it('shows images and attached files of past messages', async () => {
    const { app, fx } = setup();
    // Rewritten without the fixture's trailing partial line.
    fs.writeFileSync(
      fx.transcriptA1Path,
      transcriptA1.map(line).join('') + line({
        type: 'user', uuid: 'img', parentUuid: 'm3',
        message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }, { type: 'text', text: 'See this\n\nAttached file: /x/uploads/1/notes.txt' }] },
      }),
    );
    const page = await request(app).get('/api/sessions/local_a1/messages?limit=1').set(auth).expect(200);
    expect(page.body.items[0]).toMatchObject({ kind: 'user', id: 'img', text: 'See this', files: ['notes.txt'], images: [{ url: '/api/sessions/local_a1/images/img/0' }] });
    const image = await request(app).get('/api/sessions/local_a1/images/img/0').set(auth).expect(200);
    expect(image.headers['content-type']).toBe('image/png');
    await request(app).get('/api/sessions/local_a1/images/img/1').set(auth).expect(404);
  });
});

describe('files and folders', () => {
  it('finds files for @ mentions, best name matches first', async () => {
    const { app, fx } = setup();
    const proj = path.join(fx.root, 'proj');
    fs.mkdirSync(path.join(proj, 'src/lib'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'node_modules/x'), { recursive: true });
    for (const f of ['src/lib/live.ts', 'src/deliver.ts', 'README.md', 'node_modules/x/live.js']) fs.writeFileSync(path.join(proj, f), '');
    const res = await request(app).get(`/api/files?project=${encodeURIComponent(proj)}&q=live`).set(auth).expect(200);
    expect(res.body).toEqual({ files: ['src/lib/live.ts', 'src/deliver.ts'], truncated: false });
    await request(app).get('/api/files?project=%2Fetc&q=a').set(auth).expect(404);
  });

  it('browses folders inside the home folder only', async () => {
    const { app, fx } = setup();
    fs.mkdirSync(path.join(fx.root, 'code/.git'), { recursive: true });
    fs.mkdirSync(path.join(fx.root, '.hidden'));
    const res = await request(app).get('/api/folders').set(auth).expect(200);
    expect(res.body.parent).toBeUndefined();
    const names = res.body.folders.map((f: { name: string }) => f.name);
    expect(names).toContain('code');
    expect(names).not.toContain('.hidden');
    expect(res.body.folders.find((f: { name: string }) => f.name === 'code').git).toBe(true);
    const inner = await request(app).get(`/api/folders?path=${encodeURIComponent(path.join(fx.root, 'code'))}`).set(auth).expect(200);
    expect(inner.body.parent).toBe(fs.realpathSync(fx.root));
    await request(app).get('/api/folders?path=%2Fetc').set(auth).expect(404);
  });

  it('starts a chat in a folder picked on the phone', async () => {
    const { app, fx, store } = setup();
    const folder = path.join(fx.root, 'fresh');
    fs.mkdirSync(folder);
    const res = await request(app).post('/api/sessions').set(auth).send({ project: folder, text: 'hi', fastMode: true }).expect(201);
    expect((await store.get(res.body.sessionId))?.cwd).toBe(fs.realpathSync(folder));
  });

  it('reads local desktop presets, newest first', async () => {
    const { app, fx } = setup();
    fs.writeFileSync(
      path.join(fx.root, 'ccd-session-presets.json'),
      JSON.stringify({
        byAccount: {
          acct: {
            presets: [
              { id: 'p1', name: 'Old', lastUsedAt: 1, target: { kind: 'local', cwd: '/w/alpha' }, settings: { modelId: 'claude-opus-5-5', effort: 'high', fastMode: false } },
              { id: 'p2', name: 'New', lastUsedAt: 2, target: { kind: 'local', cwd: '/w/beta' }, settings: { effort: 'bogus' } },
              { id: 'p3', name: 'Cloud', target: { kind: 'cloud' } },
            ],
          },
        },
      }),
    );
    const res = await request(app).get('/api/presets').set(auth).expect(200);
    expect(res.body.presets).toEqual([
      { id: 'p2', name: 'New', cwd: '/w/beta' },
      { id: 'p1', name: 'Old', cwd: '/w/alpha', model: 'claude-opus-5-5', effort: 'high', fastMode: false },
    ]);
  });
});

describe('chat actions', () => {
  it('forks a chat into a new desktop record', async () => {
    const { app, forks, store, fx } = setup();
    const res = await request(app).post('/api/sessions/local_a1/fork').set(auth).send({ upToMessageId: 'm1' }).expect(201);
    expect(forks).toEqual([{ id: 'cli-a1', options: { upToMessageId: 'm1', title: 'Build session list (fork)' } }]);
    const forked = await store.get(res.body.sessionId);
    expect(forked).toMatchObject({ cliSessionId: 'cli-fork', cwd: '/w/alpha', title: 'Build session list (fork)' });
    const record = JSON.parse(fs.readFileSync(path.join(fx.desktopRoot, 'acct', 'org', `${res.body.sessionId}.json`), 'utf8'));
    expect(record.forkedFromSessionId).toBe('local_a1');
    await request(app).post('/api/sessions/nope/fork').set(auth).send({}).expect(404);
    await request(app).post('/api/sessions/local_a1/fork').set(auth).send({ upToMessageId: 'u2', before: true }).expect(201);
    expect(forks.at(-1)?.options).toMatchObject({ upToMessageId: 'r1' });
    await request(app).post('/api/sessions/local_a1/fork').set(auth).send({ upToMessageId: 'u1', before: true }).expect(400);
  });

  it('searches a chat and exports it as Markdown', async () => {
    const { app } = setup();
    const found = await request(app).get('/api/sessions/local_a1/search?q=READ').set(auth).expect(200);
    expect(found.body.matches).toEqual(['t1', 'm1:1']);
    const md = await request(app).get('/api/sessions/local_a1/export').set(auth).expect(200);
    expect(md.body.title).toBe('Build session list');
    expect(md.body.markdown).toContain('**You:** Hello');
    expect(md.body.markdown).toContain('`Read` src/a.ts');
  });

  it('finds where a rewind resumes', async () => {
    const { store } = setup();
    expect(await store.parentOf('local_a1', 'u2')).toBe('r1');
    expect(await store.parentOf('local_a1', 'u1')).toBeNull();
    expect(await store.parentOf('local_a1', 'zzz')).toBeUndefined();
  });

  it('leaves thinking out of search and Markdown', () => {
    const items = [{ kind: 'thinking' as const, id: 'x', text: 'secret plan' }];
    expect(searchItems(items, 'plan')).toEqual([]);
    expect(toMarkdown('T', items)).toBe('# T\n');
  });
});

const session: SessionSummary = {
  id: 'local_1', cliSessionId: 'cli-1', title: 't', cwd: '/w/alpha', projectKey: '/w/alpha', projectName: 'alpha',
  archived: false, pinned: false, createdAt: 0, lastActivityAt: 0,
};

describe('rewind and fast mode', () => {
  it('resumes at the entry before the edited message, restoring files when asked', async () => {
    const sdk = fakeSdk();
    const live = new LiveSession(session, sdk.queryFn);
    await live.send('edited', undefined, { messageId: 'u2', resumeAt: 'r1', files: true });
    await tick();
    expect(sdk.calls).toContainEqual({ method: 'rewindFiles', arg: { id: 'u2' } });
    expect(sdk.allOptions.at(-1)).toMatchObject({ resume: 'cli-1', resumeSessionAt: 'r1', enableFileCheckpointing: true });
    expect(sdk.sent.at(-1)).toMatchObject({ message: { content: 'edited' } });
  });

  it('refuses to rewind while Claude is working', async () => {
    const sdk = fakeSdk();
    const live = new LiveSession(session, sdk.queryFn);
    await live.send('first');
    await expect(live.send('again', undefined, { messageId: 'u', resumeAt: 'p' })).rejects.toThrow(/Stop Claude/);
  });

  it('previews a code rewind and toggles fast mode', async () => {
    const sdk = fakeSdk();
    const live = new LiveSession(session, sdk.queryFn);
    const events: ServerMessage[] = [];
    live.subscribe((m) => events.push(m));
    expect(await live.previewRewind('u2')).toMatchObject({ canRewind: true, filesChanged: ['src/a.ts'] });
    expect(sdk.calls).toContainEqual({ method: 'rewindFiles', arg: { id: 'u2', dryRun: true } });
    await live.updateSettings({ fastMode: true });
    expect(sdk.calls).toContainEqual({ method: 'applyFlagSettings', arg: { fastMode: true } });
    expect(events.at(-1)).toMatchObject({ type: 'settings', settings: { fastMode: true } });
    live.stop();
    const fresh = new LiveSession(session, sdk.queryFn);
    await fresh.updateSettings({ fastMode: false });
    await fresh.send('go');
    expect(sdk.allOptions.at(-1).settings).toEqual({ fastMode: false });
  });
});

it('encodes cwd like Claude Code', () => {
  expect(encodeCwd('/a b/c.d')).toBe('-a-b-c-d');
});
