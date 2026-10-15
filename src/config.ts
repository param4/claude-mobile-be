import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

// Values from .env may start with ~, which Node doesn't expand.
function dirFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) return fallback;
  return value.startsWith('~/') ? path.join(HOME, value.slice(2)) : value;
}

export const DESKTOP_SESSIONS_ROOT = dirFromEnv(
  'CM_DESKTOP_SESSIONS_DIR',
  path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions'),
);
export const TRANSCRIPTS_ROOT = dirFromEnv('CM_TRANSCRIPTS_DIR', path.join(HOME, '.claude/projects'));
export const CONFIG_DIR = dirFromEnv('CM_CONFIG_DIR', path.join(HOME, '.claude-mobile'));
export const PORT = Number(process.env.CM_PORT ?? 8787);

// Tailscale hands out addresses in the CGNAT range 100.64.0.0/10.
export function tailscaleAddress(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [first, second] = a.address.split('.').map(Number);
      if (first === 100 && second !== undefined && second >= 64 && second <= 127) return a.address;
    }
  }
  return undefined;
}

export function bindHost(): string {
  return process.env.CM_HOST ?? tailscaleAddress() ?? '127.0.0.1';
}

// One long-lived random token, created on first run and readable only by this user.
export function loadToken(): string {
  const file = path.join(CONFIG_DIR, 'token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
