import { MargoError } from '@margoengine/math/errors';
import type { VoxelServer } from './server.js';
import { PROTOCOL_VERSION, decodeServerMessage } from './protocol.js';

/** One exact outbound message in its original server order. */
export interface VoxelReplayRecord {
  /** Authoritative integer tick. */
  tick: number;
  /** Recipient's player id. Select one id when replaying. */
  player: number;
  /** Original encoded server message. */
  data: Uint8Array;
}
/** A fully validated recording. */
export interface VoxelRecording {
  /** Original server tick rate. */
  tickRate: number;
  /** Messages in exact emission order. */
  records: readonly VoxelReplayRecord[];
}
/** An asynchronous byte sink; write must consume all supplied bytes before resolving. */
export interface VoxelRecordingSink {
  /** Writes the complete buffer, in order. */
  write(data: Uint8Array): Promise<void>;
  /** Flushes and releases the destination. */
  close(): Promise<void>;
}

const MAGIC = [0x4d, 0x56, 0x52, 1];
const MAX_RECORD = 16 * 1024 * 1024;
function frame(tick: number, player: number, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(16 + data.length),
    view = new DataView(bytes.buffer);
  view.setFloat64(0, tick, true);
  view.setUint32(8, player, true);
  view.setUint32(12, data.length, true);
  bytes.set(data, 16);
  return bytes;
}

/** Records every recipient's stream, including welcome, to an ordered bounded sink. Attach before clients join. */
export class VoxelRecorder implements AsyncDisposable {
  /** A failed or overflowing sink stops recording and reports once. close()/flush() also reject. Default console.error. */
  onError: (error: unknown) => void = (error) => console.error(error);
  readonly #sink: VoxelRecordingSink;
  readonly #max: number;
  #pending = 0;
  #queue: Promise<void> = Promise.resolve();
  #failure: unknown;
  #failed = false;
  #off: (() => void) | undefined;
  #abortOff: (() => void) | undefined;
  #closing: Promise<void> | undefined;
  #tick = 0;
  /** maxPendingBytes defaults to 64 MiB; signal stops capture, then close() releases the sink. */
  constructor(
    server: VoxelServer,
    sink: VoxelRecordingSink,
    options: { maxPendingBytes?: number; signal?: AbortSignal } = {},
  ) {
    if (typeof server?.onSend !== 'function' || typeof sink?.write !== 'function' || typeof sink.close !== 'function')
      throw new TypeError(
        'VoxelRecorder needs a VoxelServer and a complete asynchronous sink; attach before clients join',
      );
    options.signal?.throwIfAborted();
    this.#max = options.maxPendingBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#max) || this.#max < 16)
      throw new RangeError('maxPendingBytes must be a safe integer of at least 16; use 67108864');
    this.#sink = sink;
    const head = new Uint8Array(16),
      view = new DataView(head.buffer);
    head.set(MAGIC);
    view.setUint32(4, PROTOCOL_VERSION, true);
    view.setFloat64(8, server.tickRate, true);
    this.#enqueue(head);
    this.#off = server.onSend((player, data, tick) => {
      if (data.length > MAX_RECORD)
        return this.#fail(new MargoError('failed', 'Recording message exceeds 16 MiB; reduce message size'));
      this.#tick = tick;
      this.#enqueue(frame(tick, player.id, data));
    });
    if (options.signal) {
      const signal = options.signal,
        abort = (): void => this.#fail(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.#abortOff = () => signal.removeEventListener('abort', abort);
    }
  }
  #fail(error: unknown): void {
    if (this.#failed) return;
    this.#failure = error;
    this.#failed = true;
    this.#off?.();
    this.#abortOff?.();
    this.onError(error);
  }
  #enqueue(data: Uint8Array): void {
    if (this.#failed) return;
    if (this.#pending + data.length > this.#max)
      return this.#fail(
        new MargoError('failed', 'Recording sink is too slow; use a faster sink or raise maxPendingBytes'),
      );
    this.#pending += data.length;
    this.#queue = this.#queue.then(async () => {
      try {
        if (!this.#failed) await this.#sink.write(data);
      } catch (error) {
        this.#fail(error);
      } finally {
        this.#pending -= data.length;
      }
    });
  }
  /** Waits for every message queued before this call; rejects on any lost recording data. */
  async flush(): Promise<void> {
    await this.#queue;
    if (this.#failed) throw this.#failure;
  }
  /** Stops capture, writes the complete-file footer, flushes and closes. Idempotent, including on failure. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#off?.();
    this.#off = undefined;
    this.#abortOff?.();
    this.#closing = (async () => {
      await this.flush();
      await this.#sink.write(frame(this.#tick, 0, new Uint8Array()));
    })().finally(() => this.#sink.close());
    return this.#closing;
  }
  /** await using flushes and releases the sink. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Creates a new recording file exclusively; existing reports are never overwritten. Node, Bun and Deno Node compatibility. */
export async function recordVoxelFile(
  server: VoxelServer,
  path: string | URL,
  options: { signal?: AbortSignal; maxPendingBytes?: number } = {},
): Promise<VoxelRecorder> {
  options.signal?.throwIfAborted();
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'wx');
  try {
    options.signal?.throwIfAborted();
    return new VoxelRecorder(
      server,
      {
        write: async (data) => {
          let offset = 0;
          while (offset < data.length) {
            const { bytesWritten } = await file.write(data, offset, data.length - offset);
            if (!bytesWritten) throw new MargoError('failed', 'Recording file write made no progress; check storage');
            offset += bytesWritten;
          }
        },
        close: () => file.close(),
      },
      options,
    );
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Validates the version, every frame, monotonic ticks and footer before exposing any messages. No damaged prefix replay. */
export function decodeVoxelRecording(bytes: Uint8Array): VoxelRecording {
  if (!(bytes instanceof Uint8Array) || bytes.length < 32)
    throw new RangeError('Recording is truncated; provide a complete MVR1 file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (MAGIC.some((b, i) => bytes[i] !== b) || view.getUint32(4, true) !== PROTOCOL_VERSION)
    throw new RangeError('Recording version does not match this client; use the matching voxel-net version');
  const tickRate = view.getFloat64(8, true);
  if (!(Number.isFinite(tickRate) && tickRate > 0))
    throw new RangeError('Invalid recording tick rate; use an undamaged file');
  const records: VoxelReplayRecord[] = [];
  let offset = 16,
    previous = 0,
    ended = false;
  while (offset + 16 <= bytes.length) {
    const tick = view.getFloat64(offset, true),
      player = view.getUint32(offset + 8, true),
      length = view.getUint32(offset + 12, true);
    offset += 16;
    if (!Number.isSafeInteger(tick) || tick < previous || length > MAX_RECORD || offset + length > bytes.length)
      throw new RangeError('Invalid recording frame or tick order; use an undamaged file');
    previous = tick;
    if (length === 0) {
      ended = player === 0 && offset === bytes.length;
      break;
    }
    const data = new Uint8Array(bytes.subarray(offset, offset + length));
    decodeServerMessage(data);
    records.push({ tick, player, data });
    offset += length;
  }
  if (!ended)
    throw new RangeError('Recording footer is missing or has trailing data; close the recorder before replay');
  return { tickRate, records };
}

/** Loads a complete file with cancellation and a default 256 MiB input bound. */
export async function readVoxelRecording(
  path: string | URL,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<VoxelRecording> {
  options.signal?.throwIfAborted();
  const max = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 32) throw new RangeError('maxBytes must be at least 32; use 268435456');
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'r');
  try {
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      options.signal?.throwIfAborted();
      const buffer = new Uint8Array(Math.min(65536, max + 1 - size));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > max) throw new RangeError('Recording exceeds maxBytes; raise the explicit input limit');
      parts.push(buffer.subarray(0, bytesRead));
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return decodeVoxelRecording(bytes);
  } finally {
    await file.close();
  }
}

/** Forward-only tick playback into a fresh VoxelNetClient or a message consumer. */
export class VoxelReplay {
  readonly #records: readonly VoxelReplayRecord[];
  readonly #receive: (data: Uint8Array) => void;
  readonly #rate: number;
  #cursor = 0;
  #tick = 0;
  /** Select one recipient's complete stream, starting with welcome. The target must use a fresh world and a no-op send transport. */
  constructor(recording: VoxelRecording, player: number, target: { receive(data: Uint8Array): void }) {
    this.#records = recording.records.filter((r) => r.player === player);
    if (!this.#records.length || decodeServerMessage(this.#records[0]!.data).type !== 'welcome')
      throw new RangeError(
        'Replay needs a complete player stream beginning with welcome; record before that player joins',
      );
    if (typeof target?.receive !== 'function')
      throw new TypeError('Replay target needs receive(bytes); pass a fresh VoxelNetClient');
    this.#receive = (data) => target.receive(data);
    this.#rate = recording.tickRate;
  }
  /** Whether every selected message has been delivered. */
  get done(): boolean {
    return this.#cursor === this.#records.length;
  }
  /** Delivers all remaining records through tick inclusively, preserving equal-tick order. Returns delivered count. */
  advanceTo(tick: number): number {
    if (!Number.isFinite(tick) || tick < this.#tick)
      throw new RangeError('Replay tick must move forward and be finite; create a fresh replay to restart');
    this.#tick = tick;
    let count = 0;
    while (this.#cursor < this.#records.length && this.#records[this.#cursor]!.tick <= tick) {
      this.#receive(this.#records[this.#cursor]!.data.slice());
      this.#cursor++;
      count++;
    }
    return count;
  }
  /** Plays at the recorded tick rate. Cancellation interrupts waits immediately. Default speed 1, hard limit 1 hour. */
  async play(options: { speed?: number; signal?: AbortSignal; maxDuration?: number } = {}): Promise<void> {
    const speed = options.speed ?? 1,
      maxDuration = options.maxDuration ?? 3_600_000;
    if (!(Number.isFinite(speed) && speed > 0 && Number.isFinite(maxDuration) && maxDuration > 0))
      throw new RangeError('Playback speed and maxDuration must be positive finite values; use 1 and 3600000');
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(maxDuration)])
      : AbortSignal.timeout(maxDuration);
    const start = performance.now(),
      base = this.#records[this.#cursor]?.tick ?? this.#tick;
    while (!this.done) {
      signal.throwIfAborted();
      const tick = this.#records[this.#cursor]!.tick,
        due = ((tick - base) * 1000) / (this.#rate * speed);
      const remaining = due - (performance.now() - start);
      if (remaining > 0)
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(signal.reason);
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener('abort', abort);
              resolve();
            },
            Math.min(remaining, 60_000),
          );
          signal.addEventListener('abort', abort, { once: true });
        });
      else this.advanceTo(tick);
    }
  }
}
