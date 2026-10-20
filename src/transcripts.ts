// Locates and parses Claude Code JSONL transcripts (~/.claude/projects/<encoded-cwd>/<id>.jsonl).
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatItem, ImageRef } from '@claude-mobile/protocol';
import { ATTACHED_FILE_PREFIX } from './uploads.js';

const TOOL_RESULT_LIMIT = 4000;

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Sessions can be relocated to another cwd, so fall back to scanning every project folder.
export async function findTranscript(root: string, cwd: string, cliSessionId: string): Promise<string | undefined> {
  const direct = path.join(root, encodeCwd(cwd), `${cliSessionId}.jsonl`);
  if (await exists(direct)) return direct;
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${cliSessionId}.jsonl`);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

type Entry = Record<string, any>;

export function parseLines(raw: string): Entry[] {
  const out: Entry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line being written right now can be partial; skip it.
    }
  }
  return out;
}

export function lastPrompt(entries: Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'last-prompt' && typeof e.lastPrompt === 'string') return e.lastPrompt;
  }
  return undefined;
}

// The transcript is a tree (edits and rewinds branch it). Follow the newest leaf back to the root.
export function activeChain(entries: Entry[]): Entry[] {
  const byUuid = new Map<string, Entry>();
  let leaf: Entry | undefined;
  for (const e of entries) {
    if (typeof e.uuid !== 'string' || e.isSidechain) continue;
    byUuid.set(e.uuid, e);
    if (e.type === 'user' || e.type === 'assistant' || (e.type === 'system' && e.subtype === 'local_command')) leaf = e;
  }
  const chain: Entry[] = [];
  const seen = new Set<string>();
  for (let cur = leaf; cur && !seen.has(cur.uuid); cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined) {
    seen.add(cur.uuid);
    chain.push(cur);
  }
  return chain.reverse();
}

const HIDDEN_TAGS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

export function cleanUserText(text: string): string {
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return [command[1]!.trim(), args].filter(Boolean).join(' ');
  }
  return text.replace(HIDDEN_TAGS, '').trim();
}

export function commandOutput(text: string): string {
  return text
    .replace(/<\/?local-command-(stdout|stderr)>/g, '')
    .trim();
}

function shortPath(p: unknown, cwd?: string): string {
  if (typeof p !== 'string') return '';
  return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
}

export function toolSummary(name: string, input: any, cwd?: string): string {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Bash':
      return String(input.command ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortPath(input.file_path ?? input.notebook_path, cwd);
    case 'Grep':
    case 'Glob':
      return String(input.pattern ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'Agent':
    case 'Task':
      return String(input.description ?? '');
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return typeof first === 'string' ? first : '';
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Results of parallel tool calls can sit on sibling branches, so they're looked up across every entry.
function collectToolResults(entries: Entry[]): Map<string, NonNullable<Extract<ChatItem, { kind: 'tool' }>['result']>> {
  const results = new Map();
  for (const e of entries) {
    const content = e.message?.content;
    if (e.type !== 'user' || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      const text = resultText(b.content);
      results.set(b.tool_use_id, {
        text: text.slice(0, TOOL_RESULT_LIMIT),
        isError: Boolean(b.is_error),
        truncated: text.length > TOOL_RESULT_LIMIT,
      });
    }
  }
  return results;
}

// Splits "Attached file: <path>" lines (added for phone attachments) out of a user message.
export function splitAttachedFiles(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const kept = text.split('\n').filter((l) => {
    if (!l.startsWith(ATTACHED_FILE_PREFIX)) return true;
    files.push(path.basename(l.slice(ATTACHED_FILE_PREFIX.length).trim()));
    return false;
  });
  return { text: kept.join('\n').trim(), files };
}

export type ImageUrl = (entryUuid: string, index: number) => string;

export function toChatItems(chain: Entry[], all: Entry[] = chain, sessionCwd?: string, imageUrl?: ImageUrl): ChatItem[] {
  const items: ChatItem[] = [];
  const results = collectToolResults(all);

  for (const e of chain) {
    const content = e.message?.content;
    if (e.type === 'user') {
      if (e.isMeta) continue;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      const texts = blocks.filter((b: any) => b?.type === 'text').map((b: any) => cleanUserText(String(b.text ?? '')));
      const { text, files } = splitAttachedFiles(texts.filter(Boolean).join('\n\n'));
      const images: ImageRef[] = imageUrl
        ? blocks.flatMap((b: any, i: number) => (b?.type === 'image' && b.source?.type === 'base64' ? [{ url: imageUrl(e.uuid, i) }] : []))
        : [];
      if (text || images.length || files.length) {
        items.push({
          kind: 'user',
          id: e.uuid,
          text,
          timestamp: e.timestamp,
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
        });
      }
    } else if (e.type === 'system' && e.subtype === 'local_command' && typeof e.content === 'string') {
      // Output of commands like /context or /cost, shown to the user but never sent to the model.
      const text = commandOutput(e.content);
      if (text) items.push({ kind: 'assistant', id: e.uuid, text, timestamp: e.timestamp });
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      content.forEach((b: any, i: number) => {
        const id = `${e.uuid}:${i}`;
        if (b?.type === 'text' && b.text?.trim()) {
          items.push({ kind: 'assistant', id, text: b.text, timestamp: e.timestamp });
        } else if (b?.type === 'thinking' && b.thinking?.trim()) {
          items.push({ kind: 'thinking', id, text: b.thinking });
        } else if (b?.type === 'tool_use') {
          const toolId = String(b.id ?? id);
          items.push({
            kind: 'tool',
            id: toolId,
            name: String(b.name ?? 'Tool'),
            summary: toolSummary(String(b.name), b.input, e.cwd ?? sessionCwd),
            input: b.input,
            result: results.get(toolId),
          });
        }
      });
    }
  }
  return items;
}

export async function readTranscript(file: string): Promise<Entry[]> {
  return parseLines(await fs.readFile(file, 'utf8'));
}

// An inline image of a user message, for the app to display.
export function findImage(entries: Entry[], uuid: string, index: number): { mediaType: string; data: Buffer } | undefined {
  const e = entries.find((x) => x.uuid === uuid);
  const b = Array.isArray(e?.message?.content) ? e.message.content[index] : undefined;
  if (b?.type !== 'image' || b.source?.type !== 'base64' || typeof b.source.data !== 'string') return undefined;
  return { mediaType: String(b.source.media_type ?? 'image/png'), data: Buffer.from(b.source.data, 'base64') };
}

// The entry just before this one in the conversation, where a rewind to it resumes.
export function parentOf(entries: Entry[], uuid: string): string | null | undefined {
  const e = entries.find((x) => x.uuid === uuid);
  return e ? (e.parentUuid ?? null) : undefined;
}

function searchable(item: ChatItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
      return item.text;
    case 'tool':
      return `${item.name} ${item.summary}`;
  }
}

// Ids of matching items, newest first.
export function searchItems(items: ChatItem[], q: string): string[] {
  const needle = q.toLowerCase();
  return items.filter((i) => i.kind !== 'thinking' && searchable(i).toLowerCase().includes(needle)).map((i) => i.id).reverse();
}

export function toMarkdown(title: string, items: ChatItem[]): string {
  const out = [`# ${title}`];
  for (const i of items) {
    if (i.kind === 'user') {
      const extras = [...(i.images ?? []).map(() => '[image]'), ...(i.files ?? []).map((f) => `[${f}]`)].join(' ');
      out.push(`**You:** ${[i.text, extras].filter(Boolean).join(' ')}`);
    } else if (i.kind === 'assistant') out.push(i.text);
    else if (i.kind === 'tool') out.push(`\`${i.name}\` ${i.summary}`.trim());
  }
  return out.join('\n\n') + '\n';
}
