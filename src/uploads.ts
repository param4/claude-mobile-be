// Files sent from the phone, kept on the Mac so Claude can read them and the app can show them again.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageRef, Upload } from '@claude-mobile/protocol';

// Image types the Messages API accepts inline; anything else is handed over as a file path.
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
// Lines like this in a user message stand for an attached file; the app shows them as chips.
export const ATTACHED_FILE_PREFIX = 'Attached file: ';

type Meta = Upload & { file: string };

export type UserContent = {
  content: string | Array<Record<string, unknown>>;
  images: ImageRef[];
  files: string[];
};

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : 'file';
}

export class UploadStore {
  constructor(private dir: string) {}

  async save(data: Buffer, name: string, mediaType: string): Promise<Upload> {
    const id = crypto.randomUUID();
    const folder = path.join(this.dir, id);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, safeName(name));
    await fs.writeFile(file, data, { mode: 0o600 });
    const meta: Meta = {
      id,
      kind: INLINE_IMAGE_TYPES.has(mediaType) ? 'image' : 'file',
      name: path.basename(file),
      mediaType,
      size: data.length,
      file,
    };
    await fs.writeFile(path.join(folder, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    const { file: _file, ...upload } = meta;
    return upload;
  }

  async get(id: string): Promise<Meta | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, id, 'meta.json'), 'utf8')) as Meta;
    } catch {
      return undefined;
    }
  }

  // The user message for the SDK: images inline, other files as paths Claude can read on this Mac.
  async toContent(text: string, ids: string[] = []): Promise<UserContent> {
    if (!ids.length) return { content: text, images: [], files: [] };
    const blocks: Array<Record<string, unknown>> = [];
    const images: ImageRef[] = [];
    const files: string[] = [];
    const lines: string[] = [];
    for (const id of ids) {
      const meta = await this.get(id);
      if (!meta) throw new Error(`attachment ${id} not found`);
      if (meta.kind === 'image') {
        const data = (await fs.readFile(meta.file)).toString('base64');
        blocks.push({ type: 'image', source: { type: 'base64', media_type: meta.mediaType, data } });
        images.push({ url: `/api/uploads/${id}` });
      } else {
        files.push(meta.name);
        lines.push(`${ATTACHED_FILE_PREFIX}${meta.file}`);
      }
    }
    const body = [text.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
    if (body) blocks.push({ type: 'text', text: body });
    return { content: blocks, images, files };
  }
}
