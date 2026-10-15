// Live chat: drives desktop sessions through the Claude Agent SDK and fans events out to phones.
import crypto from 'node:crypto';
import {
  query as sdkQuery,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  Effort,
  PermissionMode,
  Question,
  type ChatItem,
  type CommandInfo,
  type LiveSettings,
  type LiveState,
  type ModelOption,
  type PendingPermission,
  type ServerMessage,
  type SessionSummary,
} from '@claude-mobile/protocol';
import { z } from 'zod';
import { commandOutput, toolSummary } from './transcripts.js';

export type QueryFn = typeof sdkQuery;
type Listener = (m: ServerMessage) => void;

const SETTING_SOURCES = ['user', 'project', 'local'] as const;
const IDLE_SHUTDOWN_MS = 15 * 60 * 1000;

// Push-based async iterable feeding user messages into a streaming-input query.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(m: SDKUserMessage) {
    this.items.push(m);
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
  return '';
}

const RESULT_LIMIT = 4000;

export class LiveSession {
  state: LiveState = 'idle';
  settings: LiveSettings;
  draft = '';
  private q?: Query;
  private input?: InputQueue;
  private listeners = new Set<Listener>();
  private pending = new Map<string, { pending: PendingPermission; resolve: (r: PermissionResult) => void; suggestions?: PermissionUpdate[]; input: Record<string, unknown> }>();
  private idleTimer?: NodeJS.Timeout;
  // Items of the turn in progress, so a phone that (re)opens the chat mid-turn sees them.
  private turn: ChatItem[] = [];
  private resumable: boolean;

  constructor(
    readonly session: SessionSummary,
    private queryFn: QueryFn,
    { isNew = false }: { isNew?: boolean } = {},
  ) {
    this.resumable = !isNew;
    const mode = PermissionMode.safeParse(session.permissionMode);
    const effort = Effort.safeParse(session.effort);
    this.settings = {
      model: session.model,
      effort: effort.success ? effort.data : undefined,
      permissionMode: mode.success ? mode.data : 'default',
    };
  }

  get id() {
    return this.session.id;
  }

  get running() {
    return !!this.q;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    this.scheduleIdleShutdown();
    return () => {
      this.listeners.delete(listener);
      this.scheduleIdleShutdown();
    };
  }

  pendingList() {
    return [...this.pending.values()].map((p) => p.pending);
  }

  recentItems(): ChatItem[] {
    return this.turn;
  }

  private emit(m: ServerMessage) {
    if (m.type === 'item') this.turn.push(m.item);
    if (m.type === 'tool_result') {
      this.turn = this.turn.map((i) => (i.kind === 'tool' && i.id === m.toolId ? { ...i, result: m.result } : i));
    }
    for (const l of this.listeners) l(m);
    if (m.type === 'turn_end') this.turn = [];
  }

  private setState(state: LiveState) {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'state', sessionId: this.id, state });
    this.scheduleIdleShutdown();
  }

  private start() {
    if (this.q) return;
    this.input = new InputQueue();
    this.q = this.queryFn({
      prompt: this.input,
      options: {
        cwd: this.session.cwd,
        // A chat started from the phone gets the id its desktop record already points at.
        ...(this.resumable ? { resume: this.session.cliSessionId } : { sessionId: this.session.cliSessionId }),
        model: this.settings.model,
        effort: this.settings.effort,
        permissionMode: this.settings.permissionMode,
        settingSources: [...SETTING_SOURCES],
        includePartialMessages: true,
        canUseTool: this.canUseTool,
      },
    });
    this.resumable = true;
    this.pump(this.q);
  }

  private async pump(q: Query) {
    try {
      for await (const m of q) this.handle(m);
    } catch (e) {
      this.emit({ type: 'error', sessionId: this.id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.q === q) {
        this.q = undefined;
        this.input = undefined;
        this.draft = '';
        for (const [id, p] of this.pending) {
          p.resolve({ behavior: 'deny', message: 'Session ended' });
          this.emit({ type: 'permission_resolved', sessionId: this.id, requestId: id });
        }
        this.pending.clear();
        this.setState('idle');
      }
    }
  }

  handle(m: SDKMessage) {
    const sessionId = this.id;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'session_state_changed') {
          this.setState(m.state === 'running' ? 'working' : m.state === 'requires_action' ? 'needs-input' : 'idle');
        } else if (m.subtype === 'local_command_output') {
          this.emit({ type: 'notice', sessionId, text: m.content });
        } else if (m.subtype === 'compact_boundary') {
          this.emit({ type: 'notice', sessionId, text: 'Conversation compacted' });
        }
        return;
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev: any = m.event;
        if (ev.type === 'message_start') this.draft = '';
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.draft += ev.delta.text;
          this.emit({ type: 'delta', sessionId, text: ev.delta.text });
        }
        return;
      }
      case 'assistant': {
        if (m.parent_tool_use_id) return;
        m.message.content.forEach((b: any, i: number) => {
          const id = `${m.uuid}:${i}`;
          let item: ChatItem | undefined;
          if (b.type === 'text' && b.text.trim()) item = { kind: 'assistant', id, text: commandOutput(b.text) };
          else if (b.type === 'thinking' && b.thinking?.trim()) item = { kind: 'thinking', id, text: b.thinking };
          else if (b.type === 'tool_use')
            item = { kind: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input, this.session.cwd), input: b.input };
          if (item) this.emit({ type: 'item', sessionId, item });
        });
        this.draft = '';
        return;
      }
      case 'user': {
        if (m.parent_tool_use_id) return;
        const content = (m.message as any).content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const text = toolResultText(b.content);
          this.emit({
            type: 'tool_result',
            sessionId,
            toolId: b.tool_use_id,
            result: { text: text.slice(0, RESULT_LIMIT), isError: Boolean(b.is_error), truncated: text.length > RESULT_LIMIT },
          });
        }
        return;
      }
      case 'result':
        this.draft = '';
        this.emit({
          type: 'turn_end',
          sessionId,
          ok: m.subtype === 'success' && !m.is_error,
          error: m.subtype === 'success' ? undefined : m.subtype,
          costUsd: m.total_cost_usd,
        });
        this.setState('idle');
        return;
    }
  }

  private canUseTool: CanUseTool = (toolName, input, { signal, suggestions }) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = crypto.randomUUID();
      const questions = toolName === 'AskUserQuestion' ? z.array(Question).safeParse(input.questions) : undefined;
      const pending: PendingPermission = {
        requestId,
        toolName,
        summary: toolSummary(toolName, input, this.session.cwd),
        input,
        canAlwaysAllow: !!suggestions?.length,
        questions: questions?.success ? questions.data : undefined,
      };
      this.pending.set(requestId, { pending, resolve, suggestions, input });
      this.setState('needs-input');
      this.emit({ type: 'permission', sessionId: this.id, pending });
      signal.addEventListener('abort', () => {
        if (!this.pending.delete(requestId)) return;
        resolve({ behavior: 'deny', message: 'Cancelled' });
        this.emit({ type: 'permission_resolved', sessionId: this.id, requestId });
      });
    });

  answerPermission(requestId: string, decision: 'allow' | 'allowAlways' | 'deny', message?: string, answers?: Record<string, string>) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: message?.trim() || 'The user denied this from their phone.' });
    } else {
      p.resolve({
        behavior: 'allow',
        updatedInput: answers ? { ...p.input, answers } : p.input,
        updatedPermissions: decision === 'allowAlways' ? p.suggestions : undefined,
      });
    }
    this.emit({ type: 'permission_resolved', sessionId: this.id, requestId });
    if (!this.pending.size && this.state === 'needs-input') this.setState('working');
    return true;
  }

  send(text: string) {
    this.start();
    // The same uuid ends up in the transcript, so the app can match live and stored copies.
    const uuid = crypto.randomUUID();
    this.input!.push({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.emit({ type: 'item', sessionId: this.id, item: { kind: 'user', id: uuid, text } });
    this.setState('working');
  }

  async interrupt() {
    await this.q?.interrupt();
  }

  async updateSettings(change: Partial<LiveSettings>) {
    if (this.q) {
      if (change.model !== undefined) await this.q.setModel(change.model);
      if (change.permissionMode !== undefined) await this.q.setPermissionMode(change.permissionMode);
      if (change.effort !== undefined) await this.q.applyFlagSettings({ effortLevel: change.effort });
    }
    this.settings = { ...this.settings, ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) };
    this.emit({ type: 'settings', sessionId: this.id, settings: this.settings });
  }

  // Free the Claude Code process once nobody is watching and nothing is running.
  private scheduleIdleShutdown() {
    clearTimeout(this.idleTimer);
    if (!this.q || this.listeners.size || this.state !== 'idle') return;
    this.idleTimer = setTimeout(() => this.stop(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.input?.close();
    this.q?.close();
  }
}

// Commands and models depend on the folder (project skills, settings), not the session,
// so they come from a short-lived query that never sends a message and writes no transcript.
export class Catalog {
  private cache = new Map<string, { at: number; value: Promise<{ commands: CommandInfo[]; models: ModelOption[] }> }>();

  constructor(private queryFn: QueryFn, private ttlMs = 10 * 60 * 1000) {}

  get(cwd: string) {
    const hit = this.cache.get(cwd);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = this.load(cwd);
    this.cache.set(cwd, { at: Date.now(), value });
    value.catch(() => this.cache.delete(cwd));
    return value;
  }

  private async load(cwd: string) {
    const input = new InputQueue();
    const q = this.queryFn({ prompt: input, options: { cwd, settingSources: [...SETTING_SOURCES] } });
    const drain = (async () => {
      for await (const _ of q);
    })().catch(() => {});
    try {
      const [commands, models] = await Promise.all([q.supportedCommands(), q.supportedModels()]);
      return {
        commands: commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint ?? '' })),
        models: models
          .filter((m) => m.value !== 'default')
          .map((m) => ({
            value: m.value,
            resolvedModel: m.resolvedModel,
            displayName: m.displayName,
            description: m.description,
            efforts: m.supportedEffortLevels ?? [],
          })),
      };
    } finally {
      input.close();
      q.close();
      await drain;
    }
  }
}

export class LiveManager {
  private sessions = new Map<string, LiveSession>();

  constructor(private queryFn: QueryFn = sdkQuery, readonly catalog = new Catalog(queryFn)) {}

  get(session: SessionSummary): LiveSession {
    let live = this.sessions.get(session.id);
    if (!live) {
      live = new LiveSession(session, this.queryFn);
      this.sessions.set(session.id, live);
    }
    return live;
  }

  create(session: SessionSummary): LiveSession {
    const live = new LiveSession(session, this.queryFn, { isNew: true });
    this.sessions.set(session.id, live);
    return live;
  }

  peek(id: string) {
    return this.sessions.get(id);
  }

  stateOf = (id: string): 'working' | 'needs-input' | undefined => {
    const s = this.sessions.get(id)?.state;
    return s === 'idle' ? undefined : s;
  };

  stopAll() {
    for (const s of this.sessions.values()) s.stop();
  }
}
