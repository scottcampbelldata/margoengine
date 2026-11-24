import { MargoError } from '@margoengine/math/errors';

const modules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
const help = 'https://margoengine.com/llms/packages/mixer.md';

/** @internal Register package-owned processor text once per context, with abortable waiting. */
export async function loadProcessor(
  context: BaseAudioContext,
  name: string,
  source: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!context?.audioWorklet || typeof globalThis.AudioWorkletNode !== 'function')
    throw new MargoError('unsupported', `Mixer needs AudioWorklet in a secure context; use HTTPS or localhost. ${help}`);
  let registered = modules.get(context);
  if (!registered) modules.set(context, (registered = new Map()));
  let pending = registered.get(name);
  if (!pending) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    pending = context.audioWorklet.addModule(url).catch((cause: unknown) => {
      registered.delete(name);
      throw Object.assign(new MargoError('failed', `Mixer worklet could not load; permit blob: in script-src. ${help}`), { cause });
    }).finally(() => URL.revokeObjectURL(url));
    registered.set(name, pending);
  }
  if (!signal) return pending;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
  signal.throwIfAborted();
}

/** @internal Validate finite numeric options before creating any nodes. */
export function bounded(value: number, low: number, high: number, name: string): number {
  if (typeof value !== 'number') throw new TypeError(`${name} needs a number; pass ${low} through ${high}`);
  if (!Number.isFinite(value) || value < low || value > high)
    throw new RangeError(`${name} is out of range; pass ${low} through ${high}`);
  return value;
}
