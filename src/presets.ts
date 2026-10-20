// The desktop's saved session presets (ccd-session-presets.json next to the sessions folder). Read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Effort, type Preset } from '@claude-mobile/protocol';

export async function readPresets(desktopRoot: string): Promise<Preset[]> {
  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(path.join(path.dirname(desktopRoot), 'ccd-session-presets.json'), 'utf8'));
  } catch {
    return [];
  }
  const out: (Preset & { lastUsedAt: number })[] = [];
  for (const account of Object.values<any>(raw?.byAccount ?? {})) {
    for (const p of Array.isArray(account?.presets) ? account.presets : []) {
      // Only presets for a folder on this Mac; cloud and SSH targets can't run here.
      if (p?.target?.kind !== 'local' || typeof p.target.cwd !== 'string' || typeof p.name !== 'string') continue;
      const effort = Effort.safeParse(p.settings?.effort);
      out.push({
        id: String(p.id ?? p.name),
        name: p.name,
        cwd: p.target.cwd,
        model: typeof p.settings?.modelId === 'string' ? p.settings.modelId : undefined,
        effort: effort.success ? effort.data : undefined,
        fastMode: typeof p.settings?.fastMode === 'boolean' ? p.settings.fastMode : undefined,
        lastUsedAt: Number(p.lastUsedAt) || 0,
      });
    }
  }
  return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt).map(({ lastUsedAt: _, ...p }) => p);
}
