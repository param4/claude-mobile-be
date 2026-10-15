import type { QueryFn } from '../src/live.js';

// A stand-in for the SDK query: records what it was given and lets the test push SDK messages out.
export function fakeSdk() {
  const calls: { method: string; arg: unknown }[] = [];
  const sent: unknown[] = [];
  let options: any;
  let push!: (m: any) => void;
  let end!: () => void;
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  push = (m) => {
    queue.push(m);
    wake?.();
  };
  end = () => {
    done = true;
    wake?.();
  };
  const queryFn = ((args: any) => {
    options = args.options;
    (async () => {
      for await (const m of args.prompt) sent.push(m);
    })();
    async function* gen() {
      while (true) {
        const m = queue.shift();
        if (m) {
          yield m;
          continue;
        }
        if (done) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    }
    const g: any = gen();
    for (const method of ['setModel', 'setPermissionMode', 'applyFlagSettings', 'interrupt']) {
      g[method] = async (arg: unknown) => void calls.push({ method, arg });
    }
    g.supportedCommands = async () => [{ name: 'compact', description: 'Compact', argumentHint: '' }];
    g.supportedModels = async () => [
      { value: 'default', displayName: 'Default', description: '' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Best', supportedEffortLevels: ['low', 'high'] },
    ];
    g.close = end;
    return g;
  }) as unknown as QueryFn;
  return { queryFn, calls, sent, push, end, options: () => options };
}
