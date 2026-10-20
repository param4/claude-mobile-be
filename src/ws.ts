import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMessage, type ServerMessage } from '@claude-mobile/protocol';
import type { LiveManager } from './live.js';
import type { SessionStore } from './sessions.js';
import type { UploadStore } from './uploads.js';

function tokenOf(req: IncomingMessage): string {
  const header = req.headers.authorization?.replace(/^Bearer /, '');
  if (header) return header;
  return new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? '';
}

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function attachWebSocket(
  server: Server,
  { token, store, live, uploads }: { token: string; store: SessionStore; live: LiveManager; uploads: UploadStore },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '', 'http://x').pathname;
    if (path !== '/api/ws' || !sameToken(tokenOf(req), token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket) {
    const subs = new Map<string, () => void>();
    const send = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    let alive = true;
    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on('close', () => {
      clearInterval(heartbeat);
      for (const off of subs.values()) off();
    });

    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessage.parse(JSON.parse(String(raw)));
      } catch {
        send({ type: 'error', message: 'bad message' });
        return;
      }
      try {
        await handle(msg);
      } catch (e) {
        send({ type: 'error', sessionId: msg.sessionId, message: e instanceof Error ? e.message : String(e) });
      }
    });

    async function sessionFor(id: string) {
      const existing = live.peek(id);
      if (existing) return existing;
      const summary = await store.get(id);
      if (!summary) throw new Error('session not found');
      return live.get(summary);
    }

    async function handle(msg: ClientMessage) {
      const session = await sessionFor(msg.sessionId);
      switch (msg.type) {
        case 'subscribe': {
          if (!subs.has(session.id)) subs.set(session.id, session.subscribe(send));
          send({
            type: 'snapshot',
            sessionId: session.id,
            state: session.state,
            settings: session.settings,
            pending: session.pendingList(),
            draft: session.draft,
            recent: session.recentItems(),
          });
          // Loading commands and models takes a few seconds the first time; don't hold the chat for it.
          live.catalog
            .get(session.session.cwd)
            .then((catalog) => send({ type: 'catalog', sessionId: session.id, ...catalog }))
            .catch((e) => send({ type: 'error', sessionId: session.id, message: `Couldn't load commands: ${e instanceof Error ? e.message : e}` }));
          return;
        }
        case 'unsubscribe':
          subs.get(session.id)?.();
          subs.delete(session.id);
          return;
        case 'send': {
          if (!msg.text.trim() && !msg.attachments?.length) throw new Error('Empty message');
          let rewind;
          if (msg.rewindTo) {
            const resumeAt = await store.parentOf(session.id, msg.rewindTo);
            if (resumeAt === undefined) throw new Error('That message is no longer in this chat');
            if (resumeAt === null) throw new Error("Can't rewind past the first message. Start a new chat instead.");
            rewind = { messageId: msg.rewindTo, resumeAt, files: msg.rewindFiles };
          }
          await session.send(msg.text, await uploads.toContent(msg.text, msg.attachments), rewind);
          return;
        }
        case 'rewind_preview': {
          const r = await session.previewRewind(msg.messageId);
          send({
            type: 'rewind_preview',
            sessionId: session.id,
            messageId: msg.messageId,
            canRewind: r.canRewind,
            error: r.error,
            filesChanged: 'filesChanged' in r ? r.filesChanged : undefined,
            insertions: 'insertions' in r ? r.insertions : undefined,
            deletions: 'deletions' in r ? r.deletions : undefined,
          });
          return;
        }
        case 'interrupt':
          await session.interrupt();
          return;
        case 'settings':
          await session.updateSettings({ model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, fastMode: msg.fastMode });
          return;
        case 'permission':
          if (!session.answerPermission(msg.requestId, msg.decision, msg.message, msg.answers)) {
            send({ type: 'permission_resolved', sessionId: session.id, requestId: msg.requestId });
          }
          return;
      }
    }
  }

  return wss;
}
