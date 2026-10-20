import { createApp } from './app.js';
import path from 'node:path';
import { CONFIG_DIR, DESKTOP_SESSIONS_ROOT, PORT, TRANSCRIPTS_ROOT, bindHost, loadToken } from './config.js';
import { LiveManager } from './live.js';
import { SessionStore } from './sessions.js';
import { UploadStore } from './uploads.js';
import { attachWebSocket } from './ws.js';

const host = bindHost();
const token = loadToken();
const live = new LiveManager();
const store = new SessionStore({ desktopRoot: DESKTOP_SESSIONS_ROOT, transcriptsRoot: TRANSCRIPTS_ROOT, liveState: live.stateOf });
const uploads = new UploadStore(path.join(CONFIG_DIR, 'uploads'));
const app = createApp({ token, store, live, uploads });

const server = app.listen(PORT, host, () => {
  console.log(`claude-mobile server on http://${host}:${PORT}`);
  if (host === '127.0.0.1' && !process.env.CM_HOST) {
    console.warn('Tailscale address not found: listening on this Mac only. Start Tailscale, or set CM_HOST.');
  }
});
attachWebSocket(server, { token, store, live, uploads });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    live.stopAll();
    server.close();
    process.exit(0);
  });
}
