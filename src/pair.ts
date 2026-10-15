// Prints the pairing QR code the app scans once.
import os from 'node:os';
import qrcode from 'qrcode-terminal';
import type { PairingPayload } from '@claude-mobile/protocol';
import { PORT, bindHost, loadToken } from './config.js';

const host = bindHost();
if (host === '127.0.0.1') {
  console.error('No Tailscale address found. Install and start Tailscale on this Mac first.');
  process.exit(1);
}

const payload: PairingPayload = { v: 1, url: `http://${host}:${PORT}`, token: loadToken(), name: os.hostname() };
qrcode.generate(JSON.stringify(payload), { small: true });
console.log(`Scan with the app to pair with ${payload.name} (${payload.url}).`);
