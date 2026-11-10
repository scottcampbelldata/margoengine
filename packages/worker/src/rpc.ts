// Clean room: HTML messaging/structured serialization, DOM cancellation, and coarse task scheduling (Dryad, 2007).
import { fault, rangeError } from '../../shared/errors.js';

const TAG = 'margo-worker-rpc';
const TRANSFER = Symbol('rpc-transfer');
type Arguments<T> = T extends (...args: infer A) => unknown ? A : never;
type Result<T> = T extends (...args: never[]) => infer R ? Awaited<R> : never;
type Method<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T] & string;

/** A Worker, MessagePort, or worker global scope. Ports are started automatically; ownership stays with the caller. */
export interface RpcEndpoint {
  /** Sends a structured-clone message, optionally moving ownership of its transferables. */
  postMessage(message: unknown, transfer: Transferable[]): void;
  /** Subscribes to messages and transport failures. */
  addEventListener(type: string, listener: EventListener): void;
  /** Removes a subscription installed by this entry. */
  removeEventListener(type: string, listener: EventListener): void;
  /** Starts a MessagePort; Worker endpoints need no start method. */
  start?(): void;
}

/** Per-call cancellation and transport options. */
export interface RpcCallOptions {
  /** Cancels queued or running work. Running handlers receive an aborted context signal. Default none. */
  signal?: AbortSignal;
  /** Input ownership moves only when dispatched. Default none. */
  transfer?: Transferable[];
  /** Hard response deadline in milliseconds, above zero. Default 30000. A timeout closes the client/pool. */
  timeout?: number;
}

/** Context appended to each exposed handler's arguments. Cancellation is cooperative. */
export interface RpcContext {
  /** Aborted on caller cancellation or server disposal. A synchronous loop must yield to receive cancellation. */
  signal: AbortSignal;
}

/** Result plus ownership to move back to the caller. Construct with {@link rpcTransfer}. */
export interface RpcTransfer<T> {
  /** Returned value, containing the objects in transfer. */
  value: T;
  /** Transferables whose ownership moves to the caller. */
  transfer: Transferable[];
  /** @internal Local marker, never serialized. */
  [TRANSFER]: true;
}

/** Adds a cancellation context to each typed method. Handlers may return values, promises, or transferred results. */
export type RpcHandlers<T> = {
  [K in Method<T>]: (
    ...args: [...Arguments<T[K]>, RpcContext]
  ) => Result<T[K]> | RpcTransfer<Result<T[K]>> | PromiseLike<Result<T[K]> | RpcTransfer<Result<T[K]>>>;
};

/** Marks a handler's result for transfer rather than copy. Input transfer is specified in call options. */
export function rpcTransfer<T>(value: T, transfer: Transferable[]): RpcTransfer<T> {
  return { [TRANSFER]: true, value, transfer };
}

interface Wire {
  tag: string;
  channel: string;
  id: number;
  type: string;
  method: string;
  args: unknown[];
  value: unknown;
  error?: { name: string; message: string; code?: string; stack?: string };
}
interface Pending {
  finish(value?: unknown, error?: unknown): void;
  cancel(): void;
}
const deadline = (timeout: number): number => {
  if (!(timeout > 0 && Number.isFinite(timeout)))
    throw rangeError('RPC timeout must be finite and above zero', 'worker');
  return timeout;
};
const errorRecord = (error: unknown): NonNullable<Wire['error']> => {
  const value = error as Partial<Error> & { code?: unknown };
  return {
    name: typeof value?.name === 'string' ? value.name : 'Error',
    message: typeof value?.message === 'string' ? value.message : String(error),
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
    ...(typeof value?.stack === 'string' ? { stack: value.stack } : {}),
  };
};

/** Promise RPC over a caller-owned endpoint. Multiple clients can share one endpoint without ID collisions. */
export class RpcClient<T extends object> {
  declare [Symbol.dispose]: () => void;
  private readonly channel = crypto.randomUUID();
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private closed?: unknown;
  private readonly message = ((event: MessageEvent<Wire>) => {
    const data = event.data;
    if (data?.tag !== TAG || data.channel !== this.channel || data.type !== 'result') return;
    this.pending
      .get(data.id)
      ?.finish(data.value, data.error && Object.assign(new Error(data.error.message), data.error));
  }) as EventListener;
  private readonly failed = (() =>
    this.close(fault('failed', 'RPC transport failed; create a new client', 'worker'))) as EventListener;
  /** Starts listening, without taking ownership of the worker or port. */
  constructor(private readonly endpoint: RpcEndpoint) {
    endpoint.addEventListener('message', this.message);
    endpoint.addEventListener('error', this.failed);
    endpoint.addEventListener('messageerror', this.failed);
    endpoint.start?.();
  }
  /** True after disposal, timeout, or a transport failure. */
  get disposed(): boolean {
    return this.closed !== undefined;
  }
  /** Calls a named method with its typed arguments and promised result. */
  call<K extends Method<T>>(method: K, args: Arguments<T[K]>, options: RpcCallOptions = {}): Promise<Result<T[K]>> {
    return this.dispatch(method, args, options).result;
  }
  /** @internal The pool retains a slot until a cancelled handler actually finishes. */
  dispatch<K extends Method<T>>(
    method: K,
    args: Arguments<T[K]>,
    { signal, transfer = [], timeout = 30_000 }: RpcCallOptions,
  ): { result: Promise<Result<T[K]>>; done: Promise<void> } {
    let completed!: () => void;
    const done = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const result = new Promise<Result<T[K]>>((resolve, reject) => {
      if (this.disposed) {
        completed();
        reject(this.closed);
        return;
      }
      if (signal?.aborted) {
        completed();
        reject(signal.reason);
        return;
      }
      let wait: number;
      try {
        wait = deadline(timeout);
      } catch (error) {
        completed();
        reject(error);
        return;
      }
      const id = ++this.next;
      const send = (type: string) => this.endpoint.postMessage({ tag: TAG, channel: this.channel, type, id }, []);
      const abort = () => {
        reject(signal!.reason);
        try {
          send('cancel');
        } catch (error) {
          this.close(error);
        }
      };
      const timer = setTimeout(
        () => this.close(fault('timeout', 'RPC response deadline exceeded; create a new client', 'worker')),
        wait,
      );
      const finish = (value?: unknown, error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        completed();
        if (error !== undefined) reject(error);
        else resolve(value as Result<T[K]>);
      };
      this.pending.set(id, { finish, cancel: () => send('cancel') });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.endpoint.postMessage({ tag: TAG, channel: this.channel, type: 'call', id, method, args }, transfer);
      } catch (error) {
        finish(undefined, error);
      }
    });
    return { result, done };
  }
  private close(error: unknown): void {
    if (this.disposed) return;
    this.closed = error;
    this.endpoint.removeEventListener('message', this.message);
    this.endpoint.removeEventListener('error', this.failed);
    this.endpoint.removeEventListener('messageerror', this.failed);
    for (const pending of this.pending.values()) {
      // A dead transport cannot deliver cancellation; settlement still must release every caller.
      try {
        pending.cancel();
      } catch {
        /* The transport failure is already reported to every caller below. */
      }
      pending.finish(undefined, error);
    }
  }
  /** Rejects pending calls, cancels handlers and removes listeners. Does not terminate the caller's worker. */
  dispose(): void {
    this.close(fault('state', 'RPC client disposed; create a new client', 'worker'));
  }
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** Exposes only own, named functions on an endpoint. Returns a disposable server; unrelated messages are untouched. */
export function exposeRpc<T extends object>(
  handlers: RpcHandlers<T>,
  endpoint: RpcEndpoint = globalThis as unknown as RpcEndpoint,
): { dispose(): void; [Symbol.dispose](): void } {
  const running = new Map<string, { controller: AbortController; reply(value?: unknown, error?: unknown): void }>();
  const message = ((event: MessageEvent<Wire>) => {
    const data = event.data;
    if (data?.tag !== TAG || typeof data.channel !== 'string' || !Number.isSafeInteger(data.id)) return;
    const key = `${data.channel}:${data.id}`;
    if (data.type === 'cancel') {
      running.get(key)?.controller.abort();
      return;
    }
    if (data.type !== 'call' || running.has(key)) return;
    const controller = new AbortController();
    const reply = (value?: unknown, error?: unknown) => {
      if (!running.delete(key)) return;
      const moved =
        value && typeof value === 'object' && TRANSFER in value ? (value as RpcTransfer<unknown>) : undefined;
      try {
        endpoint.postMessage(
          {
            tag: TAG,
            channel: data.channel,
            id: data.id,
            type: 'result',
            value: moved ? moved.value : value,
            ...(error !== undefined ? { error: errorRecord(error) } : {}),
          },
          moved?.transfer ?? [],
        );
      } catch (failure) {
        // An uncloneable result is a per-call error, not a lost response or an unhandled rejection.
        endpoint.postMessage(
          { tag: TAG, channel: data.channel, id: data.id, type: 'result', error: errorRecord(failure) },
          [],
        );
      }
    };
    running.set(key, { controller, reply });
    void (async () => {
      try {
        if (!Object.hasOwn(handlers, data.method) || typeof handlers[data.method as Method<T>] !== 'function')
          throw fault('state', `Unknown RPC method ${data.method}; expose a named handler`, 'worker');
        if (!Array.isArray(data.args)) throw fault('state', 'RPC arguments must be an array', 'worker');
        const handler = handlers[data.method as Method<T>] as (...args: unknown[]) => unknown;
        const value = await handler.apply(handlers, [...data.args, { signal: controller.signal }]);
        reply(value);
      } catch (error) {
        reply(undefined, errorRecord(error));
      }
    })();
  }) as EventListener;
  endpoint.addEventListener('message', message);
  endpoint.start?.();
  const dispose = () => {
    endpoint.removeEventListener('message', message);
    for (const task of running.values()) {
      task.controller.abort();
      task.reply(undefined, fault('state', 'RPC server disposed; expose a new server', 'worker'));
    }
  };
  return { dispose, [Symbol.dispose]: dispose };
}

/** Sized pool configuration. Workers are created once and owned by the pool. */
export interface RpcPoolOptions {
  /** Concurrent workers, a positive integer. Default 2. */
  size?: number;
  /** Maximum waiting jobs; running jobs do not count. Default 1024. */
  maxQueue?: number;
}
interface Queued {
  run(client: RpcClient<object>): void;
  reject(error: unknown): void;
}

/** FIFO task pool with a fixed worker count, backpressure, input/output transfer and cooperative cancellation. */
export class RpcPool<T extends object> {
  declare [Symbol.dispose]: () => void;
  private readonly slots: { worker: RpcEndpoint & { terminate(): unknown }; client: RpcClient<T>; busy: boolean }[] =
    [];
  private readonly queue: Queued[] = [];
  private closed = false;
  private readonly maxQueue: number;
  /** Creates `size` workers using the factory. A creation failure cleans up all workers already created. */
  constructor(
    factory: (index: number) => RpcEndpoint & { terminate(): unknown },
    { size = 2, maxQueue = 1024 }: RpcPoolOptions = {},
  ) {
    if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(maxQueue) || maxQueue < 0)
      throw rangeError('RPC pool needs a positive size and nonnegative maxQueue', 'worker');
    this.maxQueue = maxQueue;
    try {
      for (let i = 0; i < size; i++) {
        const worker = factory(i);
        this.slots.push({ worker, client: new RpcClient<T>(worker), busy: false });
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  /** Number of workers, fixed at construction. */
  get size(): number {
    return this.slots.length;
  }
  /** Number of calls waiting for a worker. */
  get queued(): number {
    return this.queue.length;
  }
  /** Schedules one call. Cancellation before dispatch leaves transferables attached to the caller. */
  call<K extends Method<T>>(method: K, args: Arguments<T[K]>, options: RpcCallOptions = {}): Promise<Result<T[K]>> {
    return new Promise((resolve, reject) => {
      if (this.closed) throw fault('state', 'RPC pool disposed; create a new pool', 'worker');
      options.signal?.throwIfAborted();
      const wait = deadline(options.timeout ?? 30_000);
      if (this.slots.every((slot) => slot.busy) && this.queue.length >= this.maxQueue)
        throw fault('state', 'RPC pool queue is full; await a task before submitting more', 'worker');
      const queuedAt = Date.now();
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      const remove = (error: unknown) => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        cleanup();
        reject(error);
      };
      const abort = () => remove(options.signal!.reason);
      const job: Queued = {
        reject: remove,
        run: (client) => {
          cleanup();
          const task = (client as unknown as RpcClient<T>).dispatch(method, args, {
            ...options,
            timeout: Math.max(1, wait - (Date.now() - queuedAt)),
          });
          void task.result.then(resolve, reject);
          void task.done.then(() => {
            const slot = this.slots.find((slot) => slot.client === (client as unknown as RpcClient<T>))!;
            slot.busy = false;
            if (slot.client.disposed) this.dispose();
            else this.drain();
          });
        },
      };
      const timer = setTimeout(
        () => remove(fault('timeout', 'RPC queue deadline exceeded; submit less work', 'worker')),
        wait,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  private drain(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.busy || !this.queue.length) continue;
      slot.busy = true;
      this.queue.shift()!.run(slot.client as unknown as RpcClient<object>);
    }
  }
  /** Cancels all queued/running calls and terminates every owned worker, idempotently. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of [...this.queue]) job.reject(fault('state', 'RPC pool disposed; create a new pool', 'worker'));
    for (const slot of this.slots) {
      slot.client.dispose();
      slot.worker.terminate();
    }
  }
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
