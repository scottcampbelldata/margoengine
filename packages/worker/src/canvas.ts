// The worker side of a worker canvas: an OffscreenCanvas is already an EventTarget with a width and height, so it gets
// the few element members core and the control packages read, and they run on it unchanged. Written from the HTML
// specification; the page side is ./index.ts.
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { fault, rangeError } from '../../shared/errors.js';

const TAG = 'margo-worker-canvas';
interface Scope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  devicePixelRatio?: number;
  margoLow?: number;
}
const scope = () => globalThis as unknown as Scope;

/** Options of {@link receiveCanvas}. */
export interface ReceiveCanvasOptions {
  /** Aborts the wait for the page. Default none. */
  signal?: AbortSignal;
  /** Milliseconds to wait for the page to call `transferCanvas`, above 0. Default 30000. */
  timeout?: number;
}

/** Pointer-lock request on either end of the canvas bridge. Browser user activation is still required. */
export interface WorkerPointerLockOptions {
  /** Aborts the wait, not the browser's native permission request. Default none. */
  signal?: AbortSignal;
  /** Hard wait deadline in milliseconds, above zero. Default 10000. */
  timeout?: number;
  /** Requests raw mouse input; denial is reported rather than retried with adjusted input. Default false. */
  unadjustedMovement?: boolean;
}

/**
 * The worker's end of a canvas, from {@link receiveCanvas}. `received.attach(engine)` ties it to the engine: the first
 * frame after the page comes back from a background tab steps 0, as on the page, and `dispose` on the page disposes
 * the engine.
 */
export class ReceivedCanvas {
  declare [Symbol.dispose]: () => void;
  /** True while the page is hidden. */
  hidden = false;
  private readonly closing = new AbortController();
  private readonly captured = new Set<number>();
  private readonly listened = new Set<string>();
  private readonly locks = new Map<number, { finish(error?: unknown): void }>();
  private nextLock = 0;
  private locked = false;
  private engine?: Engine;
  private resuming = false;
  private rect = { width: 0, height: 0, left: 0, top: 0 };
  /** @internal Use {@link receiveCanvas}. */
  constructor(
    /**
     * The canvas, typed as an element because that is what it now serves as: pass it to `Engine.create` and to controls.
     * `clientWidth` and `clientHeight` follow the page's canvas, so the engine sizes itself and takes CSS pixels in
     * `pick` as it does on the page. Input events from the page arrive on it.
     */
    readonly canvas: HTMLCanvasElement,
    /** The page's `data` option. */
    readonly data: unknown,
    private readonly port: MessagePort,
    size: Record<string, number>,
  ) {
    this.resize(size);
    const add = canvas.addEventListener.bind(canvas) as EventTarget['addEventListener'],
      send = (message: object) => this.send(message),
      captured = this.captured;
    Object.defineProperties(canvas, {
      clientWidth: { get: () => this.rect.width },
      clientHeight: { get: () => this.rect.height },
      style: {
        value: new Proxy({} as Record<string, string>, {
          get: (target, name: string) => target[name] ?? '',
          set(target, name: string, value) {
            target[name] = value;
            // camelCase property names to the CSS names the page's setProperty takes.
            send({ style: [name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value] });
            return true;
          },
        }),
      },
      getBoundingClientRect: {
        value: () => {
          const { left, top, width, height } = this.rect;
          return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height };
        },
      },
      setPointerCapture: { value: (id: number) => captured.add(id) },
      releasePointerCapture: { value: (id: number) => captured.delete(id) },
      hasPointerCapture: { value: (id: number) => captured.has(id) },
      requestPointerLock: { value: (options?: WorkerPointerLockOptions) => this.requestPointerLock(options) },
      exitPointerLock: { value: () => this.exitPointerLock() },
      pointerLockElement: { get: () => (this.locked ? canvas : null) },
      addEventListener: {
        value: (type: string, ...rest: [EventListener, AddEventListenerOptions?]) => {
          if (!this.listened.has(type)) {
            this.listened.add(type);
            send({ listen: type });
          }
          add(type, ...rest);
        },
      },
    });
    port.onmessage = ({ data }) => {
      if (data.type === 'event') this.dispatch(data);
      else if (data.type === 'size') this.resize(data);
      else if (data.type === 'hidden') this.setHidden(data.hidden);
      else if (data.type === 'close') this.close();
      else if (data.type === 'pointerlock') {
        this.locked = data.locked;
        canvas.dispatchEvent(new Event('pointerlockchange'));
      } else if (data.type === 'pointerlockerror') canvas.dispatchEvent(new Event('pointerlockerror'));
      else if (data.type === 'lock-result')
        this.locks.get(data.id)?.finish(data.error && Object.assign(new Error(data.error.message), data.error));
    };
  }
  /** Aborts when the page disposes its `WorkerCanvas`, or this is disposed. */
  get signal(): AbortSignal {
    return this.closing.signal;
  }
  /** True while this canvas owns the page's pointer lock, updated by native lock-change events. */
  get pointerLocked(): boolean {
    return this.locked;
  }
  /** Asks the page to request lock. Invoke from forwarded trusted interaction; rejection reports activation/permission failure. */
  requestPointerLock({
    signal,
    timeout = 10_000,
    unadjustedMovement = false,
  }: WorkerPointerLockOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const lifetime = AbortSignal.any([this.signal, ...(signal ? [signal] : [])]);
      lifetime.throwIfAborted();
      if (!(timeout > 0 && Number.isFinite(timeout)))
        throw rangeError('Pointer lock timeout must be finite and above zero', 'worker');
      const id = ++this.nextLock;
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        lifetime.removeEventListener('abort', abort);
        this.locks.delete(id);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = () => {
        this.send({ pointerLock: 'cancel', id });
        finish(lifetime.reason);
      };
      const timer = setTimeout(() => {
        this.send({ pointerLock: 'cancel', id });
        finish(fault('timeout', 'Pointer lock response deadline exceeded; check the page connection', 'worker'));
      }, timeout);
      this.locks.set(id, { finish });
      lifetime.addEventListener('abort', abort, { once: true });
      try {
        this.send({ pointerLock: 'request', id, options: { timeout, unadjustedMovement } });
      } catch (error) {
        finish(error);
      }
    });
  }
  /** Asks the page to release this canvas's lock. The native change event updates pointerLocked. */
  exitPointerLock(): void {
    this.send({ pointerLock: 'exit' });
  }
  private send(message: object): void {
    if (!this.closing.signal.aborted) this.port.postMessage(message);
  }
  private resize({ width, height, left, top, ratio, low }: Record<string, number>): void {
    this.rect = { width, height, left, top };
    const global = scope();
    if (ratio) global.devicePixelRatio = ratio;
    if (low !== undefined) global.margoLow = low;
  }
  private dispatch({ name, fields, left, top }: { name: string; fields: object; left: number; top: number }): void {
    this.rect.left = left;
    this.rect.top = top;
    this.canvas.dispatchEvent(Object.assign(new Event(name, { cancelable: true }), fields));
  }
  private setHidden(hidden: boolean): void {
    const back = this.hidden && !hidden,
      engine = this.engine;
    this.hidden = hidden;
    if (!back || !engine || this.resuming) return;
    // The loop's step is the time since the last frame, at most maxDelta: 0 for one frame restarts its clock. Core does
    // this for itself from `document`, which a worker has none of.
    const most = engine.maxDelta;
    this.resuming = true;
    engine.maxDelta = 0;
    const done = engine.onFrame(() => {
      done();
      engine.maxDelta = most;
      this.resuming = false;
    });
  }
  private close(): void {
    const engine = this.engine;
    this.dispose();
    if (engine && !engine.disposed) engine.dispose();
  }
  /** Ties this canvas to `engine`: see the class. Disposing the engine then ends the link to the page. */
  attach(engine: EngineKernel): this {
    engine.use({ name: 'worker-canvas', setup() {}, dispose: () => this.dispose() });
    // Type only: a runtime import of the extension entry would load core into this small entry.
    this.engine = engine as unknown as Engine;
    return this;
  }
  /** Ends the link to the page. The page's canvas keeps the last frame. */
  dispose(): void {
    if (this.closing.signal.aborted) return;
    this.send({ closed: true });
    this.closing.abort();
    if (this.locked) {
      this.locked = false;
      this.canvas.dispatchEvent(new Event('pointerlockchange'));
    }
    this.engine = undefined;
    this.port.close();
  }
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * In a worker: waits for the canvas the page passes to `transferCanvas`. Rejects with `timeout` when the page never
 * sends one, or the signal's reason.
 */
export function receiveCanvas({ signal, timeout = 30_000 }: ReceiveCanvasOptions = {}): Promise<ReceivedCanvas> {
  return new Promise((resolve, reject) => {
    if (!(timeout > 0 && timeout < Number.POSITIVE_INFINITY))
      throw rangeError('receiveCanvas: timeout above 0', 'worker');
    signal?.throwIfAborted();
    const global = scope(),
      finish = () => {
        clearTimeout(limit);
        signal?.removeEventListener('abort', abort);
        global.removeEventListener('message', message);
      },
      abort = () => {
        finish();
        reject(signal!.reason);
      },
      message = (event: MessageEvent) => {
        const data = event.data;
        if (data?.[TAG] === 'ask') global.postMessage({ [TAG]: 'hello' });
        else if (data?.[TAG] === 'canvas') {
          finish();
          const received = new ReceivedCanvas(data.canvas, data.data, data.port, data);
          global.postMessage({ [TAG]: 'received' });
          resolve(received);
        }
      },
      limit = setTimeout(() => {
        finish();
        reject(fault('timeout', 'The page never called transferCanvas', 'worker'));
      }, timeout);
    signal?.addEventListener('abort', abort);
    global.addEventListener('message', message);
    // The page may only ask later, or may have asked before this listener existed: say hello either way.
    global.postMessage({ [TAG]: 'hello' });
  });
}
