// The page side of a worker canvas: written from the HTML specification (transferControlToOffscreen, MessagePort) and
// the UI Events and Pointer Events specifications. The worker side is ./canvas.ts; the two share only the message shapes.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { WorkerPointerLockOptions } from './canvas.js';

const TAG = 'margo-worker-canvas';
/** Events a worker can listen for on its canvas. Key events come from the document, the rest from the canvas. */
const POINTER = new Set([
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerenter',
  'pointerleave',
  'pointerover',
  'pointerout',
  'lostpointercapture',
  'gotpointercapture',
  'mousedown',
  'mousemove',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'focus',
  'blur',
]);
const KEYS = new Set(['keydown', 'keyup']);
/** Defaults only the page can stop, so a worker that listens for one of these has it stopped for it. */
const PREVENTED = new Set(['wheel', 'contextmenu']);
/** Every plain value of a forwarded event. */
const FIELDS = [
  'altKey',
  'button',
  'buttons',
  'clientX',
  'clientY',
  'code',
  'ctrlKey',
  'deltaMode',
  'deltaX',
  'deltaY',
  'deltaZ',
  'height',
  'isPrimary',
  'key',
  'location',
  'metaKey',
  'movementX',
  'movementY',
  'offsetX',
  'offsetY',
  'pageX',
  'pageY',
  'pointerId',
  'pointerType',
  'pressure',
  'repeat',
  'screenX',
  'screenY',
  'shiftKey',
  'tangentialPressure',
  'tiltX',
  'tiltY',
  'twist',
  'width',
  'x',
  'y',
] as const;

/** What {@link transferCanvas} needs of a worker: a `Worker`, or anything with the same messages. */
export type CanvasWorker = Pick<Worker, 'postMessage' | 'addEventListener' | 'removeEventListener'>;

/** Options of {@link transferCanvas}. */
export interface TransferCanvasOptions {
  /** Anything structured clone accepts, handed to the worker as `received.data`. Default undefined. */
  data?: unknown;
  /** Objects in `data` to transfer instead of copy. Default none. */
  transfer?: Transferable[];
  /** Aborts the wait for the worker; the canvas stays usable when it had not moved yet. Default none. */
  signal?: AbortSignal;
  /** Milliseconds to wait for the worker to call `receiveCanvas`, above 0. Default 30000. */
  timeout?: number;
}

/** True when this page can hand a canvas to a worker. Check it to keep a main-thread path for older browsers. */
export const workerCanvasSupported = (): boolean =>
  typeof Worker === 'function' &&
  typeof HTMLCanvasElement === 'function' &&
  'transferControlToOffscreen' in HTMLCanvasElement.prototype;

/**
 * The page's end of a canvas drawn by a worker, from {@link transferCanvas}. It keeps the worker told of the canvas's
 * size, position, pixel ratio and visibility, and forwards the input events the worker listens for.
 */
export class WorkerCanvas {
  declare [Symbol.dispose]: () => void;
  /** True after `dispose`. */
  disposed = false;
  private readonly listening = new Map<EventTarget, Map<string, EventListener>>();
  private readonly resizing: ResizeObserver;
  private readonly closing = new AbortController();
  private readonly lockRequests = new Map<number, AbortController>();
  private readonly lockChanged = (): void => this.post({ type: 'pointerlock', locked: this.pointerLocked });
  private readonly lockError = (): void => this.post({ type: 'pointerlockerror' });
  private ratio?: MediaQueryList;
  private readonly send = (): void => this.post({ type: 'size', ...this.size() });
  private readonly ratioChanged = (): void => {
    this.watchRatio();
    this.send();
  };
  private readonly visibility = (): void =>
    this.post({ type: 'hidden', hidden: this.canvas.ownerDocument.visibilityState === 'hidden' });
  /** @internal Use {@link transferCanvas}. */
  constructor(
    /** The page's canvas. It shows what the worker draws and can no longer be drawn to from here. */
    readonly canvas: HTMLCanvasElement,
    /** The worker drawing it. It stays the caller's: `dispose` does not terminate it. */
    readonly worker: CanvasWorker,
    private readonly port: MessagePort,
  ) {
    port.onmessage = ({ data }) => {
      if (data.listen) this.listen(data.listen);
      else if (data.style) this.canvas.style.setProperty(data.style[0], data.style[1]);
      else if (data.closed) this.dispose();
      else if (data.pointerLock === 'exit') this.exitPointerLock();
      else if (data.pointerLock === 'cancel') this.lockRequests.get(data.id)?.abort();
      else if (data.pointerLock === 'request') {
        const controller = new AbortController();
        this.lockRequests.set(data.id, controller);
        void this.requestPointerLock({ ...data.options, signal: controller.signal })
          .then(
            () => this.post({ type: 'lock-result', id: data.id }),
            (error) =>
              this.post({
                type: 'lock-result',
                id: data.id,
                error: { name: error?.name, message: String(error?.message ?? error), code: error?.code },
              }),
          )
          .finally(() => this.lockRequests.delete(data.id));
      }
    };
    this.resizing = new ResizeObserver(this.send);
    this.resizing.observe(canvas);
    this.watchRatio();
    canvas.ownerDocument.addEventListener('visibilitychange', this.visibility);
    canvas.ownerDocument.addEventListener('pointerlockchange', this.lockChanged);
    canvas.ownerDocument.addEventListener('pointerlockerror', this.lockError);
    this.lockChanged();
  }
  /** True while the page has locked the pointer to this canvas. */
  get pointerLocked(): boolean {
    return this.canvas.ownerDocument.pointerLockElement === this.canvas;
  }
  /** Requests lock on the page. Call in a trusted user gesture; browser permission/activation rules still apply. */
  requestPointerLock({
    signal,
    timeout = 10_000,
    unadjustedMovement = false,
  }: WorkerPointerLockOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) throw fault('state', 'Worker canvas disposed; transfer a new canvas', 'worker');
      if (typeof this.canvas.requestPointerLock !== 'function')
        throw fault('unsupported', 'Pointer lock unavailable in this browser', 'worker');
      if (!(timeout > 0 && Number.isFinite(timeout)))
        throw rangeError('Pointer lock timeout must be finite and above zero', 'worker');
      const lifetime = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])]);
      lifetime.throwIfAborted();
      if (this.pointerLocked) {
        resolve();
        return;
      }
      const doc = this.canvas.ownerDocument;
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        doc.removeEventListener('pointerlockchange', change);
        doc.removeEventListener('pointerlockerror', failed);
        lifetime.removeEventListener('abort', abort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const change = () => {
        if (this.pointerLocked) finish();
      };
      const failed = () =>
        finish(fault('failed', 'Pointer lock denied; request it from a trusted page gesture', 'worker'));
      const abort = () => finish(lifetime.reason);
      const timer = setTimeout(
        () => finish(fault('timeout', 'Pointer lock deadline exceeded; request from a trusted gesture', 'worker')),
        timeout,
      );
      doc.addEventListener('pointerlockchange', change);
      doc.addEventListener('pointerlockerror', failed);
      lifetime.addEventListener('abort', abort, { once: true });
      try {
        void this.canvas.requestPointerLock({ unadjustedMovement })?.catch((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }
  /** Releases this canvas's lock. Leaves another element's lock alone. */
  exitPointerLock(): void {
    if (this.pointerLocked) this.canvas.ownerDocument.exitPointerLock();
  }
  /** @internal The size, position and pixel ratio the worker reads as the canvas's. */
  size(): Record<string, number | undefined> {
    const { left, top } = this.canvas.getBoundingClientRect(),
      view = this.canvas.ownerDocument.defaultView;
    return {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      left,
      top,
      ratio: view?.devicePixelRatio,
      low: (globalThis as { margoLow?: number }).margoLow,
    };
  }
  private post(message: object): void {
    if (!this.disposed) this.port.postMessage(message);
  }
  /** A pixel ratio change is no resize (a window moved to another screen): one media query per ratio tells of it. */
  private watchRatio(): void {
    const view = this.canvas.ownerDocument.defaultView;
    this.ratio?.removeEventListener('change', this.ratioChanged);
    this.ratio = view?.matchMedia?.(`(resolution: ${view.devicePixelRatio}dppx)`);
    this.ratio?.addEventListener('change', this.ratioChanged);
  }
  private listen(type: string): void {
    const target = KEYS.has(type) ? this.canvas.ownerDocument : POINTER.has(type) ? this.canvas : null;
    if (!target) return;
    let types = this.listening.get(target);
    if (!types) this.listening.set(target, (types = new Map()));
    if (types.has(type)) return;
    const forward = (event: Event) => {
      if (PREVENTED.has(type)) event.preventDefault();
      // A drag keeps reaching the canvas outside it, as the worker cannot ask in time. Scripted events have no pointer.
      if (type === 'pointerdown' && event.isTrusted) this.canvas.setPointerCapture((event as PointerEvent).pointerId);
      const fields: Record<string, unknown> = {},
        source = event as unknown as Record<string, unknown>;
      for (const field of FIELDS) if (field in event) fields[field] = source[field];
      const { left, top } = this.canvas.getBoundingClientRect();
      this.post({ type: 'event', name: type, fields, left, top });
    };
    const listener =
      type === 'mousemove'
        ? (event: Event) => {
            if (!this.pointerLocked) forward(event);
          }
        : forward;
    types.set(type, listener);
    target.addEventListener(type, listener, { passive: !PREVENTED.has(type) });
    if (type === 'mousemove') {
      const doc = this.canvas.ownerDocument;
      let documentTypes = this.listening.get(doc);
      if (!documentTypes) this.listening.set(doc, (documentTypes = new Map()));
      const lockedMove = (event: Event) => {
        if (this.pointerLocked) forward(event);
      };
      documentTypes.set(type, lockedMove);
      doc.addEventListener(type, lockedMove);
    }
  }
  /**
   * Stops forwarding and tells the worker: `received.signal` aborts there, and an engine attached to `received` is disposed.
   * The canvas cannot be taken back, and the worker stays running until you call `worker.terminate()`.
   */
  dispose(): void {
    if (this.disposed) return;
    this.exitPointerLock();
    this.closing.abort();
    this.post({ type: 'close' });
    this.disposed = true;
    for (const [target, types] of this.listening)
      for (const [type, forward] of types) target.removeEventListener(type, forward);
    this.listening.clear();
    this.resizing.disconnect();
    this.ratio?.removeEventListener('change', this.ratioChanged);
    this.canvas.ownerDocument.removeEventListener('visibilitychange', this.visibility);
    this.canvas.ownerDocument.removeEventListener('pointerlockchange', this.lockChanged);
    this.canvas.ownerDocument.removeEventListener('pointerlockerror', this.lockError);
    this.port.close();
  }
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Moves drawing of `canvas` to `worker`, once the worker calls `receiveCanvas` from `@margoengine/worker/canvas`.
 * Resolves when the worker holds the canvas. Rejects with `unsupported` where a canvas cannot move, `state` when this
 * canvas already moved or has a context, `failed` when the worker fails to start, `timeout` when it never asks, or the
 * signal's reason. Your own `postMessage` traffic with the worker is left alone.
 */
export function transferCanvas(
  canvas: HTMLCanvasElement,
  worker: CanvasWorker,
  { data, transfer = [], signal, timeout = 30_000 }: TransferCanvasOptions = {},
): Promise<WorkerCanvas> {
  return new Promise((resolve, reject) => {
    if (typeof canvas?.transferControlToOffscreen !== 'function')
      throw fault('unsupported', 'transferCanvas needs a canvas element in a browser with OffscreenCanvas', 'worker');
    if (typeof worker?.postMessage !== 'function') throw typeError('transferCanvas: expected a Worker', 'worker');
    if (!(timeout > 0 && timeout < Number.POSITIVE_INFINITY))
      throw rangeError('transferCanvas: timeout above 0', 'worker');
    signal?.throwIfAborted();
    let view: WorkerCanvas | undefined;
    const finish = () => {
        clearTimeout(limit);
        signal?.removeEventListener('abort', abort);
        worker.removeEventListener('message', message as EventListener);
        worker.removeEventListener('error', failed as EventListener);
        worker.removeEventListener('messageerror', failed as EventListener);
      },
      fail = (error: unknown) => {
        finish();
        reject(error);
      },
      abort = () => fail(signal!.reason),
      failed = (event: ErrorEvent) =>
        fail(fault('failed', `Worker failed before it took the canvas: ${event.message ?? 'bad message'}`, 'worker')),
      move = () => {
        if (view) return;
        try {
          const { port1, port2 } = new MessageChannel();
          let offscreen: OffscreenCanvas;
          try {
            offscreen = canvas.transferControlToOffscreen();
          } catch (error) {
            throw Object.assign(fault('state', 'This canvas has a context or already moved to a worker', 'worker'), {
              cause: error,
            });
          }
          view = new WorkerCanvas(canvas, worker, port1);
          worker.postMessage({ [TAG]: 'canvas', canvas: offscreen, port: port2, data, ...view.size() }, [
            offscreen,
            port2,
            ...transfer,
          ]);
        } catch (error) {
          view?.dispose();
          fail(error);
        }
      },
      message = (event: MessageEvent) => {
        if (event.data?.[TAG] === 'hello') move();
        else if (event.data?.[TAG] === 'received') {
          finish();
          resolve(view!);
        }
      },
      limit = setTimeout(() => fail(fault('timeout', 'The worker never called receiveCanvas', 'worker')), timeout);
    signal?.addEventListener('abort', abort);
    worker.addEventListener('message', message as EventListener);
    worker.addEventListener('error', failed as EventListener);
    worker.addEventListener('messageerror', failed as EventListener);
    // The worker may already have said hello, before anyone here listened: ask, and it says it again.
    worker.postMessage({ [TAG]: 'ask' });
  });
}
