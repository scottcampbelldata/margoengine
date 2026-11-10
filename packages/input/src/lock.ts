import { MargoError } from '@margoengine/math/errors';
import type { ControlHost } from './motion.js';

/** Minimal native document surface used by PointerLock, also usable in deterministic tests. */
export interface InputLockDocument extends EventTarget {
  readonly pointerLockElement?: object | null;
  exitPointerLock?(): void;
}
/** A native HTMLElement is a compatible lock target. */
export interface InputLockTarget {
  readonly ownerDocument: InputLockDocument;
  requestPointerLock?(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
}
/** Options for one lock request. Call request from a user activation. */
export interface InputLockOptions {
  /** Request movement without OS acceleration. Default true. */
  unadjustedMovement?: boolean;
  /** Fall back to adjusted movement only on NotSupportedError. Default true. */
  fallback?: boolean;
  /** Cancels the wait and releases a late native acquisition while this object is alive. */
  signal?: AbortSignal;
  /** Hard bound on the complete request, including fallback. Default 5000 ms. */
  timeout?: number;
}
/**
 * Pointer lock and per-tick relative mouse counts, independent of camera controls.
 * Attach to Input and bind control id 'lock', axes 'x' and 'y'. Call update before Input.update.
 * x/y retain unbounded mouse counts; Input actions apply their usual scale and scalar clamp.
 */
export class PointerLock {
  /** Mouse counts sampled by the most recent update. */
  x = 0;
  /** Mouse counts sampled by the most recent update. */
  y = 0;
  /** True for confirmed raw movement, false for adjusted, null if a legacy void API cannot confirm options. */
  raw: boolean | null = false;
  private dx = 0;
  private dy = 0;
  private disposed = false;
  private requesting = false;
  private canceled = false;
  private cancelPending?: (error: unknown) => void;
  private readonly doc: InputLockDocument;
  private readonly hosts = new Map<ControlHost, { id: string; values: Record<string, number> }>();
  /** Listen only on the target's document. The constructor does not request a lock. */
  constructor(private readonly element: InputLockTarget) {
    this.doc = element.ownerDocument;
    this.doc.addEventListener('mousemove', this.onMove);
    this.doc.addEventListener('pointerlockchange', this.onChange);
  }
  /** Whether this element currently owns the lock. */
  get locked(): boolean {
    return this.doc.pointerLockElement === this.element;
  }
  /** Whether the target and document expose pointer lock. */
  get supported(): boolean {
    return typeof this.element.requestPointerLock === 'function' && typeof this.doc.exitPointerLock === 'function';
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'Pointer lock is disposed; create a new PointerLock');
  }
  private readonly onMove = (event: Event): void => {
    if (!this.locked) return;
    const { movementX, movementY } = event as MouseEvent;
    if (Number.isFinite(movementX)) this.dx += movementX;
    if (Number.isFinite(movementY)) this.dy += movementY;
  };
  private readonly onChange = (): void => {
    if (this.canceled && this.locked) this.doc.exitPointerLock?.();
    if (!this.locked) {
      this.clear();
      this.raw = false;
    }
  };
  /**
   * Acquire lock, negotiating raw movement where supported. Modern promise and legacy event APIs both work.
   * @throws RangeError for invalid timeout; DOMException on rejection, abort, unsupported API or a concurrent request.
   */
  async request({
    unadjustedMovement = true,
    fallback = true,
    signal,
    timeout = 5000,
  }: InputLockOptions = {}): Promise<void> {
    this.check();
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new RangeError('Invalid pointer lock timeout; use positive finite milliseconds');
    signal?.throwIfAborted();
    if (!this.supported)
      throw new DOMException(
        'Pointer lock is unavailable; use a browser with the Pointer Lock API',
        'NotSupportedError',
      );
    if (this.requesting)
      throw new DOMException(
        'Pointer lock request already pending; await it before requesting again',
        'InvalidStateError',
      );
    this.requesting = true;
    this.canceled = false;
    const controller = new AbortController(),
      timer = setTimeout(
        () =>
          controller.abort(
            new DOMException('Pointer lock timed out; request again from a user gesture', 'TimeoutError'),
          ),
        timeout,
      );
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      try {
        await this.attempt(unadjustedMovement, combined);
      } catch (error) {
        if (
          unadjustedMovement &&
          fallback &&
          (error as { name?: string })?.name === 'NotSupportedError' &&
          !combined.aborted
        )
          await this.attempt(false, combined);
        else throw error;
      }
    } catch (error) {
      this.canceled = true;
      this.release();
      throw error;
    } finally {
      clearTimeout(timer);
      this.requesting = false;
    }
  }
  private attempt(raw: boolean, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        this.doc.removeEventListener('pointerlockchange', change);
        this.doc.removeEventListener('pointerlockerror', fail);
        signal.removeEventListener('abort', abort);
        this.cancelPending = undefined;
        if (error !== undefined) reject(error);
        else resolve();
      };
      const change = () => {
        if (this.locked) finish();
      };
      const fail = () =>
        finish(
          new DOMException(
            'Pointer lock refused; request from a user gesture and allow pointer lock',
            'OperationError',
          ),
        );
      const abort = () => finish(signal.reason);
      this.cancelPending = finish;
      this.doc.addEventListener('pointerlockchange', change);
      this.doc.addEventListener('pointerlockerror', fail);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        const promise = this.element.requestPointerLock!({ unadjustedMovement: raw });
        this.raw = promise ? raw : null;
        if (promise)
          promise.then(() => {
            if (this.disposed || this.canceled || signal.aborted) {
              if (this.locked) this.doc.exitPointerLock?.();
            } else if (this.locked) finish();
          }, finish);
        else change();
      } catch (error) {
        finish(error);
      }
    });
  }
  /** Exit only this object's lock, cancel a pending request and discard accumulated counts. */
  release(): void {
    this.canceled = true;
    this.cancelPending?.(new DOMException('Pointer lock released; request again from a user gesture', 'AbortError'));
    if (this.locked) this.doc.exitPointerLock?.();
    this.raw = false;
    this.clear();
  }
  /** Publish per-tick counts to an Input (default control id 'lock'). Returns an idempotent detach function. */
  attach(host: ControlHost, id = 'lock'): () => void {
    this.check();
    if (!id || this.hosts.has(host))
      throw new TypeError('Invalid pointer lock host; use a nonempty id and attach each host once');
    this.hosts.set(host, { id, values: host.control(id) });
    return () => {
      if (this.hosts.delete(host)) host.removeControl(id);
    };
  }
  /** Sample and consume movement once per tick. @throws MargoError after disposal. */
  update(): void {
    this.check();
    this.x = this.dx;
    this.y = this.dy;
    this.dx = this.dy = 0;
    for (const { values } of this.hosts.values()) {
      values.x = this.x;
      values.y = this.y;
    }
  }
  private clear(): void {
    this.x = this.y = this.dx = this.dy = 0;
    for (const { values } of this.hosts.values()) values.x = values.y = 0;
  }
  /** Release lock, cancel waits, remove listeners and remove published controls. Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
    this.doc.removeEventListener('mousemove', this.onMove);
    this.doc.removeEventListener('pointerlockchange', this.onChange);
    for (const [host, { id }] of this.hosts) host.removeControl(id);
    this.hosts.clear();
  }
  /** Deterministic disposal for using declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
