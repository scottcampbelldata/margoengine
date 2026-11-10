// Clean-room live sources: WHATWG Fetch, SSE and WebSocket; RFC 6455. See docs/clean-room.md.
import { fault, rangeError } from '../../shared/errors.js';
/** Network source options: JSON decode, 16 MiB message limit, optional request options and AbortSignal. */
export interface SourceOptions<T = unknown> {
  readonly signal?: AbortSignal;
  readonly parse?: (text: string) => T | Promise<T>;
  readonly maxBytes?: number;
  readonly request?: Omit<RequestInit, 'signal'>;
  readonly fetch?: typeof globalThis.fetch;
}
/** WebSocket source buffers at most 128 pending messages by default, failing explicitly on overflow. */
export interface WebSocketSourceOptions<T = unknown> extends SourceOptions<T> {
  readonly capacity?: number;
  readonly protocols?: string | readonly string[];
}
const limit = (v = 16 * 1024 * 1024) => {
  if (!Number.isSafeInteger(v) || v < 1) throw rangeError('Set maxBytes to a positive safe integer', 'sciviz');
  return v;
};
const abortable = <T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return Promise.resolve(value);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort),
      abort = () => {
        cleanup();
        reject(signal.reason);
      };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
};
const decode = <T>(options: SourceOptions<T>, text: string): Promise<T> => {
  options.signal?.throwIfAborted();
  return abortable(options.parse ? options.parse(text) : (JSON.parse(text) as T), options.signal);
};
async function* abortableChunks(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await abortable(iterator.next(), signal);
      signal?.throwIfAborted();
      if (next.done) { ended = true; return; }
      yield next.value;
    }
  } finally {
    if (!ended && iterator.return) await abortable(iterator.return(), signal);
  }
}
const combined = (signal: AbortSignal | undefined, own: AbortSignal) => (signal ? AbortSignal.any([signal, own]) : own);
class Queue<T> {
  readonly values: T[] = [];
  closed = false;
  error: unknown;
  pending: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | undefined;
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  push(value: T) {
    if (this.closed) return;
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      p.resolve({ done: false, value });
    } else if (this.values.length === this.capacity)
      this.fail(
        fault('state', 'Consume the live source faster or raise capacity; no messages were silently dropped', 'sciviz'),
      );
    else this.values.push(value);
  }
  fail(error: unknown) {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    this.pending?.reject(error);
    this.pending = undefined;
  }
  close() {
    this.closed = true;
    this.pending?.resolve({ done: true, value: undefined });
    this.pending = undefined;
  }
  next(): Promise<IteratorResult<T>> {
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => (this.pending = { resolve, reject }));
  }
}
/** Yield parsed messages with a bounded backlog; close the socket on abort, parse failure, overflow or iterator return. */
export async function* webSocketSource<T = unknown>(
  url: string | URL,
  options: WebSocketSourceOptions<T> = {},
): AsyncGenerator<T> {
  options.signal?.throwIfAborted();
  const max = limit(options.maxBytes),
    capacity = options.capacity ?? 128;
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw rangeError('Set WebSocket capacity to a positive safe integer', 'sciviz');
  const queue = new Queue<string>(capacity),
    socket = new WebSocket(
      url,
      typeof options.protocols === 'string'
        ? options.protocols
        : options.protocols
          ? [...options.protocols]
          : undefined,
    );
  socket.binaryType = 'arraybuffer';
  const stop = () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
  };
  const abort = () => {
    queue.fail(options.signal!.reason);
    stop();
  };
  const message = (event: MessageEvent) => {
    const bytes = typeof event.data === 'string' ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
    if (bytes.byteLength > max) {
      queue.fail(fault('state', 'Raise maxBytes or send smaller WebSocket messages', 'sciviz'));
      stop();
      return;
    }
    queue.push(typeof event.data === 'string' ? event.data : new TextDecoder().decode(bytes));
    if (queue.error !== undefined) stop();
  };
  const error = () =>
    queue.fail(fault('failed', 'WebSocket connection failed; check the endpoint and connection', 'sciviz'));
  const close = (event: CloseEvent) => {
    if (event.code === 1000 || event.code === 1005) queue.close();
    else queue.fail(fault('failed', `WebSocket closed with code ${event.code}; check the server`, 'sciviz'));
  };
  socket.addEventListener('message', message);
  socket.addEventListener('error', error);
  socket.addEventListener('close', close);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const next = await queue.next();
      if (next.done) return;
      yield await decode(options, next.value);
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    socket.removeEventListener('message', message);
    socket.removeEventListener('error', error);
    socket.removeEventListener('close', close);
    stop();
  }
}
/** Parsed SSE event metadata. Event defaults to message; id and retry persist according to the protocol. No automatic reconnection is hidden. */
export interface ServerEvent<T> {
  readonly data: T;
  readonly event: string;
  readonly id: string;
  readonly retry?: number;
}
/** Parse streamed UTF-8 SSE including split CRLF, BOM, comments, multiline data and unterminated final-event discard. */
export async function* parseServerEvents<T = unknown>(
  chunks: AsyncIterable<Uint8Array>,
  options: SourceOptions<T> = {},
): AsyncGenerator<ServerEvent<T>> {
  options.signal?.throwIfAborted();
  const max = limit(options.maxBytes),
    decoder = new TextDecoder();
  let buffer = '',
    data: string[] = [],
    event = 'message',
    id = '',
    retry: number | undefined,
    dataBytes = 0;
  for await (const chunk of abortableChunks(chunks, options.signal)) {
    options.signal?.throwIfAborted();
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.search(/[\r\n]/)) >= 0) {
      if (buffer[index] === '\r' && index === buffer.length - 1) break;
      const line = buffer.slice(0, index),
        length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + length);
      if (new TextEncoder().encode(line).length > max + 7)
        throw fault('state', 'Raise maxBytes or send shorter SSE fields', 'sciviz');
      if (line === '') {
        if (data.length) yield { data: await decode(options, data.join('\n')), event: event || 'message', id, retry };
        data = [];
        dataBytes = 0;
        event = 'message';
        continue;
      }
      if (line[0] === ':') continue;
      const colon = line.indexOf(':'),
        field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'data') {
        dataBytes += new TextEncoder().encode(value).length + (data.length ? 1 : 0);
        if (dataBytes > max) throw fault('state', 'Raise maxBytes or send smaller server-sent events', 'sciviz');
        data.push(value);
      } else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\0')) id = value;
      else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) retry = Number(value);
    }
    if (new TextEncoder().encode(buffer).length > max + 7)
      throw fault('state', 'Raise maxBytes or send smaller server-sent events', 'sciviz');
  }
  // A trailing CR terminates a blank line just like LF; other unterminated events are discarded.
  buffer += decoder.decode();
  if (buffer === '\r' && data.length)
    yield { data: await decode(options, data.join('\n')), event: event || 'message', id, retry };
}
async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}
const checkResponse = (r: Response) => {
  if (!r.ok) throw fault('failed', `HTTP ${r.status}; check the live source endpoint`, 'sciviz');
};
/** Fetch SSE with natural stream backpressure. Cancels fetch on abort or early iteration return. HTTP and parse errors propagate. */
export async function* eventSource<T = unknown>(
  url: string | URL,
  options: SourceOptions<T> = {},
): AsyncGenerator<ServerEvent<T>> {
  options.signal?.throwIfAborted();
  const own = new AbortController(),
    signal = combined(options.signal, own.signal);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      ...options.request,
      signal,
      headers: { Accept: 'text/event-stream', ...Object.fromEntries(new Headers(options.request?.headers)) },
    });
    checkResponse(response);
    if (response.status === 204) return;
    if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? ''))
      throw fault('failed', 'Serve SSE with Content-Type text/event-stream', 'sciviz');
    yield* parseServerEvents(responseChunks(response), { ...options, signal });
  } finally {
    own.abort();
  }
}
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      timer = setTimeout(finish, ms),
      abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
    signal.addEventListener('abort', abort, { once: true });
  });
/** Polling interval defaults to 1000 ms, measured after the consumer finishes the previous item; requests never overlap. */
export interface PollingSourceOptions<T = unknown> extends SourceOptions<T> {
  readonly interval?: number;
}
/** Yield bounded parsed HTTP responses. Aborting cancels an active request or interval; iterator return cancels owned work. */
export async function* pollingSource<T = unknown>(
  url: string | URL,
  options: PollingSourceOptions<T> = {},
): AsyncGenerator<T> {
  const max = limit(options.maxBytes),
    interval = options.interval ?? 1000;
  if (!Number.isFinite(interval) || interval < 0 || interval > 2147483647)
    throw rangeError('Set polling interval to milliseconds in [0,2147483647]', 'sciviz');
  options.signal?.throwIfAborted();
  const own = new AbortController(),
    signal = combined(options.signal, own.signal);
  try {
    while (true) {
      signal.throwIfAborted();
      const response = await (options.fetch ?? globalThis.fetch)(url, { ...options.request, signal });
      checkResponse(response);
      let bytes = 0,
        text = '';
      const decoder = new TextDecoder();
      for await (const chunk of responseChunks(response)) {
        bytes += chunk.length;
        if (bytes > max) throw fault('state', 'Raise maxBytes or return a smaller polling response', 'sciviz');
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      yield await decode(options, text);
      await delay(interval, signal);
    }
  } finally {
    own.abort();
  }
}
