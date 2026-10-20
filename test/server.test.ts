import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SessionQuery } from '@claude-mobile/protocol';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { registerDesktopSession } from '../src/desktop.js';
import { LiveManager } from '../src/live.js';
import { fakeSdk } from './fakeSdk.js';
import { NO_FOLDER, SessionStore, projectOf } from '../src/sessions.js';
import { activeChain, cleanUserText, toChatItems } from '../src/transcripts.js';
import { UploadStore } from '../src/uploads.js';
import { NOW, makeFixture, transcriptA1 } from './fixtures.js';

const TOKEN = 'x'.repeat(43);

function setup(liveState?: (id: string) => 'working' | 'needs-input' | undefined) {
  const fx = makeFixture();
  const store = new SessionStore({ ...fx, now: () => NOW, liveState });
  const sdk = fakeSdk();
  const live = new LiveManager(sdk.queryFn);
  const uploads = new UploadStore(path.join(fx.root, 'uploads'));
  return { fx, store, sdk, live, app: createApp({ token: TOKEN, store, live, uploads, home: fx.root }) };
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const q = (o: object) => SessionQuery.parse(o);

describe('auth', () => {
  it('rejects missing or wrong tokens', async () => {
    const { app } = setup();
    await request(app).get('/api/health').expect(401);
    await request(app).get('/api/health').set('Authorization', 'Bearer nope').expect(401);
    await request(app).get('/api/health').set(auth).expect(200);
  });
});

describe('session store', () => {
  it('reads desktop sessions, skipping deleted and broken files', async () => {
    const { store } = setup();
    const ids = (await store.list()).map((s) => s.id).sort();
    expect(ids).toEqual(['local_a1', 'local_a2', 'local_b1', 'local_b2']);
  });

  it('finds last prompts, including relocated transcripts', async () => {
    const { store } = setup();
    expect((await store.get('local_a1'))?.lastPrompt).toBe('keep it short');
    expect((await store.get('local_b2'))?.lastPrompt).toBe('moved prompt');
  });

  it('groups by date with pinned first and hides archived by default', async () => {
    const { store } = setup();
    const groups = await store.query(q({}));
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['Pinned', ['local_b1']],
      ['Today', ['local_a1']],
      ['Yesterday', ['local_b2']],
    ]);
  });

  it('filters by status, project and search', async () => {
    const { store } = setup();
    const flat = async (o: object) => (await store.query(q({ groupBy: 'none', ...o }))).flatMap((g) => g.sessions.map((s) => s.id));
    expect(await flat({ status: 'archived' })).toEqual(['local_a2']);
    expect((await flat({ status: 'all' })).sort()).toEqual(['local_a1', 'local_a2', 'local_b1', 'local_b2']);
    expect(await flat({ project: '/w/alpha' })).toEqual(['local_a1']);
    expect(await flat({ q: 'MOVED' })).toEqual(['local_b2']);
  });

  it('sorts alphabetically and by created', async () => {
    const { store } = setup();
    const flat = async (sort: string) =>
      (await store.query(q({ groupBy: 'none', sort }))).find((g) => g.key === 'all')!.sessions.map((s) => s.title);
    expect(await flat('alpha')).toEqual(['Build session list', 'Yesterday work']);
    expect(await flat('created')).toEqual(['Build session list', 'Yesterday work']);
  });

  it('groups by project and by live state', async () => {
    const { store: byProject } = setup();
    expect((await byProject.query(q({ groupBy: 'project' }))).map((g) => g.label)).toEqual(['Pinned', 'alpha', 'beta']);
    const { store } = setup((id) => (id === 'local_b2' ? 'needs-input' : undefined));
    expect((await store.query(q({ groupBy: 'state' }))).map((g) => g.label)).toEqual(['Pinned', 'Needs input', 'Idle']);
  });

  it('lists projects from active sessions', async () => {
    const { store } = setup();
    expect(await store.projects()).toEqual([
      { key: '/w/alpha', name: 'alpha', path: '/w/alpha', sessionCount: 1, lastActivityAt: NOW - 1000, pinned: false },
      { key: '/w/beta', name: 'beta', path: '/w/beta', sessionCount: 2, lastActivityAt: NOW - 24 * 60 * 60 * 1000, pinned: true },
    ]);
  });

  it('merges folderless desktop sessions into one project', () => {
    const root = '/Users/me/Library/Application Support/Claude/scratch-workspaces';
    expect(projectOf(`${root}/a/b/scratch-1`, root)).toEqual({ projectKey: NO_FOLDER, projectName: 'No folder' });
    expect(projectOf('/w/alpha', root)).toEqual({ projectKey: '/w/alpha', projectName: 'alpha' });
  });
});

describe('transcripts', () => {
  it('follows the active branch and builds chat items', () => {
    const items = toChatItems(activeChain(transcriptA1));
    expect(items).toEqual([
      { kind: 'user', id: 'u1', text: 'Hello', timestamp: undefined },
      { kind: 'thinking', id: 'm1:0', text: 'hmm' },
      { kind: 'assistant', id: 'm1:1', text: 'Reading files.', timestamp: undefined },
      {
        kind: 'tool', id: 't1', name: 'Read', summary: 'src/a.ts', input: { file_path: '/w/alpha/src/a.ts' },
        result: { text: 'file body', isError: false, truncated: false },
      },
      { kind: 'user', id: 'u2', text: '/compact keep it short', timestamp: undefined },
      { kind: 'assistant', id: 'm3:0', text: 'Done.', timestamp: undefined },
    ]);
  });

  it('finds results of parallel tool calls on sibling branches', () => {
    const entries = [
      { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'go' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u', message: { content: [{ type: 'tool_use', id: 'A', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { content: [{ type: 'tool_use', id: 'B', name: 'Bash', input: { command: 'pwd' } }] } },
      { type: 'user', uuid: 'rA', parentUuid: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 'A', content: 'files' }] } },
      { type: 'user', uuid: 'rB', parentUuid: 'a2', message: { content: [{ type: 'tool_result', tool_use_id: 'B', content: '/w' }] } },
    ];
    const tools = toChatItems(activeChain(entries), entries).filter((i) => i.kind === 'tool');
    expect(tools.map((i) => i.kind === 'tool' && i.result?.text)).toEqual(['files', '/w']);
  });

  it('shows output of local commands like /context', () => {
    const entries = [
      { type: 'user', uuid: 'c', parentUuid: null, message: { content: '<command-name>/context</command-name><command-args></command-args>' } },
      { type: 'system', subtype: 'local_command', uuid: 'o', parentUuid: 'c', content: '<local-command-stdout>## Context Usage</local-command-stdout>' },
    ];
    expect(toChatItems(activeChain(entries), entries).map((i) => i.kind !== 'tool' && i.text)).toEqual(['/context', '## Context Usage']);
  });

  it('strips hidden tags from user text', () => {
    expect(cleanUserText('a <local-command-stdout>x</local-command-stdout> b')).toBe('a  b');
  });

  it('pages messages from the newest end', async () => {
    const { app } = setup();
    const page = await request(app).get('/api/sessions/local_a1/messages?limit=2').set(auth).expect(200);
    expect(page.body.items.map((i: { id: string }) => i.id)).toEqual(['u2', 'm3:0']);
    expect(page.body.hasMore).toBe(true);
    const older = await request(app).get('/api/sessions/local_a1/messages?limit=10&offset=2').set(auth).expect(200);
    expect(older.body.items).toHaveLength(4);
    expect(older.body.hasMore).toBe(false);
    await request(app).get('/api/sessions/nope/messages').set(auth).expect(404);
    await request(app).get('/api/sessions?groupBy=bogus').set(auth).expect(400);
  });
});

describe('starting chats from the phone', () => {
  it('registers a desktop record copied from an existing one, never overwriting', async () => {
    const { fx, store } = setup();
    const org = path.join(fx.desktopRoot, 'acct', 'org');
    const template = path.join(org, 'local_a1.json');
    const original = JSON.parse(fs.readFileSync(template, 'utf8'));
    fs.writeFileSync(template, JSON.stringify({ ...original, remoteMcpServersConfig: [{ name: 'x' }], completedTurns: 9 }));

    const id = await registerDesktopSession(fx.desktopRoot, { cwd: '/w/alpha', cliSessionId: 'cli-new', title: 'Hello', permissionMode: 'plan' }, NOW);
    const record = JSON.parse(fs.readFileSync(path.join(org, `${id}.json`), 'utf8'));
    expect(record).toMatchObject({ sessionId: id, cliSessionId: 'cli-new', cwd: '/w/alpha', title: 'Hello', permissionMode: 'plan', isArchived: false, remoteMcpServersConfig: [{ name: 'x' }] });
    expect(record.completedTurns).toBeUndefined();
    expect(fs.readdirSync(org).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await store.get(id))?.title).toBe('Hello');
  });

  it('creates a session in a known project and starts it with the first message', async () => {
    const { app, sdk, store } = setup();
    const res = await request(app).post('/api/sessions').set(auth).send({ project: '/w/alpha', text: 'Fix the build\nplease', effort: 'low' }).expect(201);
    const created = await store.get(res.body.sessionId);
    expect(created).toMatchObject({ title: 'Fix the build', cwd: '/w/alpha', effort: 'low', model: 'claude-opus-5-5' });
    expect(sdk.options()).toMatchObject({ cwd: '/w/alpha', sessionId: created!.cliSessionId });
    expect(sdk.options().resume).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(sdk.sent).toEqual([expect.objectContaining({ message: { role: 'user', content: 'Fix the build\nplease' } })]);
  });

  it('rejects unknown folders and makes a scratch folder for "No folder"', async () => {
    const { app, fx, store } = setup();
    await request(app).post('/api/sessions').set(auth).send({ project: '/etc', text: 'hi' }).expect(404);
    const res = await request(app).post('/api/sessions').set(auth).send({ project: 'no-folder', text: 'hi' }).expect(201);
    const created = await store.get(res.body.sessionId);
    expect(created?.projectKey).toBe('no-folder');
    expect(created!.cwd.startsWith(path.join(fx.root, 'scratch-workspaces', 'acct', 'org', 'scratch-'))).toBe(true);
    expect(fs.existsSync(created!.cwd)).toBe(true);
  });

  it('serves commands, models and defaults for a new chat', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/catalog?project=%2Fw%2Falpha').set(auth).expect(200);
    expect(res.body.commands).toEqual([{ name: 'compact', description: 'Compact', argumentHint: '' }]);
    expect(res.body.models.map((m: { value: string }) => m.value)).toEqual(['opus']);
    expect(res.body.defaults).toEqual({ model: 'claude-opus-5-5', permissionMode: 'default' });
    await request(app).get('/api/catalog?project=%2Fnope').set(auth).expect(404);
  });

  it('uses the transcript time when it is newer than the desktop record', async () => {
    const { fx, store } = setup();
    const later = new Date(NOW + 5000);
    fs.utimesSync(fx.transcriptA1Path, later, later);
    expect((await store.get('local_a1'))?.lastActivityAt).toBe(later.getTime());
  });
});
