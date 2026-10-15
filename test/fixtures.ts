import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/transcripts.js';

export const NOW = new Date('2026-10-14T15:00:00').getTime();
const DAY = 24 * 60 * 60 * 1000;

type Meta = { uuid: string; cli: string; cwd: string; title: string; ago: number; archived?: boolean; starred?: boolean };

export const metas: Meta[] = [
  { uuid: 'a1', cli: 'cli-a1', cwd: '/w/alpha', title: 'Build session list', ago: 1000 },
  { uuid: 'a2', cli: 'cli-a2', cwd: '/w/alpha', title: 'Archived thing', ago: 2 * DAY, archived: true },
  { uuid: 'b1', cli: 'cli-b1', cwd: '/w/beta', title: 'Pinned plan', ago: 10 * DAY, starred: true },
  { uuid: 'b2', cli: 'cli-b2', cwd: '/w/beta', title: 'Yesterday work', ago: DAY },
];

export function line(o: object) {
  return JSON.stringify(o) + '\n';
}

export const transcriptA1 = [
  { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Hello <system-reminder>secret</system-reminder>' } },
  {
    type: 'assistant', uuid: 'm1', parentUuid: 'u1', cwd: '/w/alpha',
    message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Reading files.' }] },
  },
  {
    type: 'assistant', uuid: 'm2', parentUuid: 'm1', cwd: '/w/alpha',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/alpha/src/a.ts' } }] },
  },
  { type: 'user', uuid: 'r1', parentUuid: 'm2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] } },
  // An abandoned branch from an edited prompt: must not appear.
  { type: 'user', uuid: 'x1', parentUuid: 'u1', message: { content: 'old branch' } },
  { type: 'user', uuid: 'u2', parentUuid: 'r1', message: { content: '<command-name>/compact</command-name><command-args>keep it short</command-args>' } },
  { type: 'user', uuid: 'meta', parentUuid: 'u2', isMeta: true, message: { content: 'hidden meta' } },
  { type: 'assistant', uuid: 'm3', parentUuid: 'meta', message: { content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'last-prompt', lastPrompt: 'keep it short' },
];

export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const desktopRoot = path.join(root, 'desktop');
  const transcriptsRoot = path.join(root, 'projects');
  const org = path.join(desktopRoot, 'acct', 'org');
  fs.mkdirSync(org, { recursive: true });
  for (const m of metas) {
    fs.writeFileSync(
      path.join(org, `local_${m.uuid}.json`),
      JSON.stringify({
        sessionId: `local_${m.uuid}`, cliSessionId: m.cli, cwd: m.cwd, title: m.title,
        createdAt: NOW - m.ago - 1000, lastActivityAt: NOW - m.ago, isArchived: m.archived ?? false, isStarred: m.starred,
        model: 'claude-opus-5-5', unknownField: { ignored: true },
      }),
    );
  }
  // A deleted session's tombstone hides its file.
  fs.writeFileSync(path.join(org, 'local_gone.json'), JSON.stringify({ sessionId: 'local_gone', cliSessionId: 'x', cwd: '/w/x', createdAt: NOW }));
  fs.writeFileSync(path.join(org, 'deleted_gone'), String(NOW));
  fs.writeFileSync(path.join(org, 'local_broken.json'), '{not json');

  const dir = path.join(transcriptsRoot, encodeCwd('/w/alpha'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cli-a1.jsonl'), transcriptA1.map(line).join('') + '{"partial');
  // b2 was relocated: its transcript lives under another folder.
  const other = path.join(transcriptsRoot, encodeCwd('/w/moved'));
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'cli-b2.jsonl'), line({ type: 'last-prompt', lastPrompt: 'moved prompt' }));
  // Old mtimes, so the desktop's lastActivityAt decides the order unless a test touches a transcript.
  for (const f of [path.join(dir, 'cli-a1.jsonl'), path.join(other, 'cli-b2.jsonl')]) fs.utimesSync(f, 0, 0);
  return { root, desktopRoot, transcriptsRoot, transcriptA1Path: path.join(dir, 'cli-a1.jsonl') };
}
