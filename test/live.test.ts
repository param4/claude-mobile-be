import { describe, expect, it } from 'vitest';
import type { ServerMessage, SessionSummary } from '@claude-mobile/protocol';
import { LiveSession } from '../src/live.js';
import { fakeSdk } from './fakeSdk.js';

const session: SessionSummary = {
  id: 'local_1',
  cliSessionId: 'cli-1',
  title: 't',
  cwd: '/w/alpha',
  projectKey: '/w/alpha',
  projectName: 'alpha',
  model: 'claude-opus-5-5',
  effort: 'high',
  permissionMode: 'auto',
  archived: false,
  pinned: false,
  createdAt: 0,
  lastActivityAt: 0,
};

function setup() {
  const sdk = fakeSdk();
  const live = new LiveSession(session, sdk.queryFn);
  const events: ServerMessage[] = [];
  live.subscribe((m) => events.push(m));
  return { sdk, live, events };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiveSession', () => {
  it('resumes the desktop session with its settings and streams a turn', async () => {
    const { sdk, live, events } = setup();
    live.send('hello');
    await tick();
    expect(sdk.options()).toMatchObject({
      cwd: '/w/alpha',
      resume: 'cli-1',
      model: 'claude-opus-5-5',
      effort: 'high',
      permissionMode: 'auto',
      includePartialMessages: true,
    });
    expect(sdk.sent).toEqual([{ type: 'user', uuid: expect.any(String), message: { role: 'user', content: 'hello' }, parent_tool_use_id: null }]);
    expect(live.state).toBe('working');

    sdk.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
    sdk.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } });
    sdk.push({
      type: 'assistant',
      uuid: 'a1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Hi there' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    });
    sdk.push({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts' }] } });
    // Subagent traffic is not shown in the main chat.
    sdk.push({ type: 'assistant', uuid: 'sub', parent_tool_use_id: 't9', message: { content: [{ type: 'text', text: 'hidden' }] } });
    sdk.push({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 });
    await tick();

    expect(events.map((e) => e.type)).toEqual(['item', 'state', 'delta', 'item', 'item', 'tool_result', 'turn_end', 'state']);
    expect(events.filter((e) => e.type === 'item').map((e) => e.type === 'item' && e.item)).toEqual([
      { kind: 'user', id: (sdk.sent[0] as { uuid: string }).uuid, text: 'hello' },
      { kind: 'assistant', id: 'a1:0', text: 'Hi there' },
      { kind: 'tool', id: 't1', name: 'Bash', summary: 'ls', input: { command: 'ls' } },
    ]);
    expect(live.state).toBe('idle');
    expect(live.draft).toBe('');
  });

  it('asks the phone for permission and passes the answer back', async () => {
    const { sdk, live, events } = setup();
    live.send('go');
    await tick();
    const canUseTool = sdk.options().canUseTool;
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install' }], behavior: 'allow', destination: 'localSettings' }];
    const decision = canUseTool('Bash', { command: 'npm install' }, { signal: new AbortController().signal, suggestions });
    const asked = events.find((e) => e.type === 'permission');
    expect(asked).toMatchObject({ pending: { toolName: 'Bash', summary: 'npm install', canAlwaysAllow: true } });
    expect(live.state).toBe('needs-input');

    const requestId = asked!.type === 'permission' ? asked!.pending.requestId : '';
    expect(live.answerPermission(requestId, 'allowAlways')).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'npm install' }, updatedPermissions: suggestions });
    expect(live.state).toBe('working');
    expect(live.answerPermission(requestId, 'deny')).toBe(false);
  });

  it('returns AskUserQuestion answers and denials with a reason', async () => {
    const { sdk, live, events } = setup();
    live.send('go');
    await tick();
    const canUseTool = sdk.options().canUseTool;
    const questions = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }];
    const answer = canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal });
    const asked = events.findLast((e) => e.type === 'permission');
    expect(asked).toMatchObject({ pending: { questions } });
    live.answerPermission(asked!.type === 'permission' ? asked!.pending.requestId : '', 'allow', undefined, { 'Which?': 'B' });
    await expect(answer).resolves.toMatchObject({ behavior: 'allow', updatedInput: { questions, answers: { 'Which?': 'B' } } });

    const denied = canUseTool('Bash', { command: 'rm -rf x' }, { signal: new AbortController().signal });
    const second = events.findLast((e) => e.type === 'permission');
    live.answerPermission(second!.type === 'permission' ? second!.pending.requestId : '', 'deny', 'use trash instead');
    await expect(denied).resolves.toEqual({ behavior: 'deny', message: 'use trash instead' });
  });

  it('applies settings live once running, or keeps them for the next start', async () => {
    const { sdk, live, events } = setup();
    await live.updateSettings({ model: 'sonnet' });
    expect(sdk.calls).toEqual([]);
    live.send('hi');
    await tick();
    expect(sdk.options().model).toBe('sonnet');
    await live.updateSettings({ effort: 'low', permissionMode: 'plan' });
    expect(sdk.calls).toEqual([
      { method: 'setPermissionMode', arg: 'plan' },
      { method: 'applyFlagSettings', arg: { effortLevel: 'low' } },
    ]);
    expect(live.settings).toEqual({ model: 'sonnet', effort: 'low', permissionMode: 'plan' });
    expect(events.filter((e) => e.type === 'settings')).toHaveLength(2);
  });

  it('denies outstanding permissions when the session ends', async () => {
    const { sdk, live } = setup();
    live.send('go');
    await tick();
    const pending = sdk.options().canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    sdk.end();
    await expect(pending).resolves.toEqual({ behavior: 'deny', message: 'Session ended' });
    await tick();
    expect(live.running).toBe(false);
    expect(live.state).toBe('idle');
  });
});
