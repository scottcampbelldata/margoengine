import { recordedTimeline, type Figure, type CameraState } from '@margoengine/sciviz/spec';
import { applyShareView } from './share.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Selection uses figure layer indices instead of live layer objects. */
export interface EmbedSelection {
  readonly region: NonNullable<Figure['selection']>['region'];
  readonly points: readonly { readonly layer: number; readonly indices: readonly number[] }[];
}
/** Acknowledged portable viewer state. */
export interface EmbedState {
  readonly camera: CameraState;
  readonly timeIndex?: number;
  readonly selection?: EmbedSelection;
}
/** Peer origin, channel, lifetime and window. */
export interface EmbedOptions {
  /** Exact peer origin, including scheme and port. Wildcards and opaque origins reject. */
  readonly origin: string;
  /** Peer window. Server defaults to parent; clients must supply the iframe's contentWindow. */
  readonly peer?: Window;
  /** Match on both sides. Default margo-sciviz-v1. */
  readonly channel?: string;
  readonly signal?: AbortSignal;
}
function origin(value: string): string {
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== value)
    throw typeError('Embed requires an exact HTTP(S) origin without a path', 'sciviz');
  return value;
}
function snapshot(figure: Figure): EmbedState {
  const camera = figure.engine.camera,
    selection = figure.selection;
  return {
    camera: {
      position: [...camera.position],
      target: [...camera.target],
      up: [...camera.up],
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
    },
    timeIndex: recordedTimeline(figure)?.index,
    selection: selection && {
      region: structuredClone(selection.region),
      points: selection.points.map((p) => ({ layer: figure.layers.indexOf(p.layer), indices: Array.from(p.indices) })),
    },
  };
}
function select(figure: Figure, value: EmbedSelection | undefined): void {
  if (value === undefined) {
    figure.setSelection(undefined);
    return;
  }
  if (!value || !Array.isArray(value.points) || !value.region || typeof value.region !== 'object')
    throw typeError('Embed selection needs region and points', 'sciviz');
  const points = value.points.map((p) => {
    if (
      !p ||
      !Number.isInteger(p.layer) ||
      !figure.layers[p.layer] ||
      !Array.isArray(p.indices) ||
      p.indices.some((i: number) => !Number.isSafeInteger(i) || i < 0 || i > 0xffffffff)
    )
      throw rangeError('Embed selection needs valid layer indices and uint32 point indices', 'sciviz');
    const layer = figure.layers[p.layer];
    if (!('kind' in layer) || !['scatter', 'line'].includes(layer.kind as string))
      throw typeError('Embed selection needs a scatter or line layer', 'sciviz');
    return {
      layer: layer as NonNullable<Figure['selection']>['points'][number]['layer'],
      indices: Uint32Array.from(p.indices),
    };
  });
  figure.setSelection({ region: structuredClone(value.region), points });
}
/** Serve bounded, serial camera/time/selection requests from one known parent and exact origin. */
export function serveEmbed(figure: Figure, options: EmbedOptions): { dispose(): void; [Symbol.dispose](): void } {
  const expected = origin(options.origin),
    peer = options.peer ?? window.parent,
    channel = options.channel ?? 'margo-sciviz-v1';
  options.signal?.throwIfAborted();
  let disposed = false,
    queue = Promise.resolve(),
    pending = 0,
    previous = JSON.stringify(snapshot(figure));
  const send = (message: object) => {
    if (!disposed) peer.postMessage({ channel, ...message }, expected);
  };
  const publish = () => {
    const state = snapshot(figure),
      json = JSON.stringify(state);
    if (json !== previous) {
      previous = json;
      send({ event: 'state', state });
    }
  };
  const listener = (event: MessageEvent) => {
    const message = event.data;
    if (
      disposed ||
      event.origin !== expected ||
      event.source !== peer ||
      !message ||
      message.channel !== channel ||
      typeof message.id !== 'string' ||
      message.id.length > 128 ||
      typeof message.method !== 'string'
    )
      return;
    const reply = (error: unknown) =>
      send({
        id: message.id,
        error: {
          code: (error as { code?: string })?.code ?? 'MARGO_INVALID_ARGUMENT',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    if (pending >= 32) {
      reply(fault('state', 'Embed queue is full; await each request', 'sciviz'));
      return;
    }
    pending++;
    const run = queue.then(async () => {
      if (disposed) return;
      switch (message.method) {
        case 'getState':
          break;
        case 'setCamera':
          if (!message.value) throw typeError('setCamera needs a complete camera', 'sciviz');
          await applyShareView(figure, { camera: message.value });
          break;
        case 'setTime':
          await applyShareView(figure, { timeIndex: message.value });
          if (message.value === undefined) throw typeError('setTime needs a time index', 'sciviz');
          break;
        case 'setSelection':
          select(figure, message.value);
          break;
        default:
          throw typeError('Unknown embed method', 'sciviz');
      }
      publish();
      send({ id: message.id, state: snapshot(figure) });
    });
    queue = run.catch(reply).finally(() => {
      pending--;
    });
  };
  window.addEventListener('message', listener);
  figure.addEventListener('selection', publish);
  const timeline = recordedTimeline(figure);
  timeline?.addEventListener('time', publish);
  const removeFrame = figure.engine.onFrame(publish);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', listener);
    figure.removeEventListener('selection', publish);
    timeline?.removeEventListener('time', publish);
    removeFrame();
    options.signal?.removeEventListener('abort', dispose);
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  return { dispose, [Symbol.dispose]: dispose };
}
/** Disposable parent-side command connection with state events. */
export interface EmbedClient extends EventTarget {
  /** Requests reject after 10 seconds by default, or on cancellation/disposal. */
  request(
    method: 'getState' | 'setCamera' | 'setTime' | 'setSelection',
    value?: CameraState | number | EmbedSelection,
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
  ): Promise<EmbedState>;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Connect to one iframe. State changes dispatch a `state` CustomEvent; every command returns acknowledged state. */
export function connectEmbed(options: EmbedOptions): EmbedClient {
  const expected = origin(options.origin),
    peer = options.peer,
    channel = options.channel ?? 'margo-sciviz-v1';
  if (!peer) throw typeError('connectEmbed needs the iframe contentWindow', 'sciviz');
  options.signal?.throwIfAborted();
  const events = new EventTarget(),
    prefix = crypto.randomUUID();
  const pending = new Map<
    string,
    { resolve: (state: EmbedState) => void; reject: (error: unknown) => void; cleanup: () => void }
  >();
  let next = 0,
    disposed = false;
  const listener = (event: MessageEvent) => {
    const message = event.data;
    if (event.origin !== expected || event.source !== peer || message?.channel !== channel) return;
    if (message.event === 'state') events.dispatchEvent(new CustomEvent('state', { detail: message.state }));
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    item.cleanup();
    if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else item.resolve(message.state);
  };
  window.addEventListener('message', listener);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', listener);
    options.signal?.removeEventListener('abort', dispose);
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(fault('disposed', 'Embed client disposed', 'sciviz'));
    }
    pending.clear();
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  return Object.assign(events, {
    request(
      method: 'getState' | 'setCamera' | 'setTime' | 'setSelection',
      value?: CameraState | number | EmbedSelection,
      opts: { signal?: AbortSignal; timeout?: number } = {},
    ): Promise<EmbedState> {
      if (disposed) return Promise.reject(fault('disposed', 'Embed client disposed', 'sciviz'));
      const timeout = opts.timeout ?? 10000;
      if (!Number.isFinite(timeout) || timeout <= 0)
        return Promise.reject(rangeError('Embed timeout must be positive', 'sciviz'));
      if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
      if (pending.size >= 32) return Promise.reject(fault('state', 'Embed client queue is full', 'sciviz'));
      return new Promise((resolve, reject) => {
        const id = `${prefix}:${next++}`;
        const fail = (error: unknown) => {
          const item = pending.get(id);
          if (item) {
            pending.delete(id);
            item.cleanup();
            reject(error);
          }
        };
        const abort = () => fail(opts.signal?.reason);
        const timer = setTimeout(
          () => fail(fault('failed', 'Embed request timed out; check origin and viewer readiness', 'sciviz')),
          timeout,
        );
        const cleanup = () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', abort);
        };
        pending.set(id, { resolve, reject, cleanup });
        opts.signal?.addEventListener('abort', abort, { once: true });
        try {
          peer.postMessage({ channel, id, method, value }, expected);
        } catch (error) {
          fail(error);
        }
      });
    },
    dispose,
    [Symbol.dispose]: dispose,
  });
}
