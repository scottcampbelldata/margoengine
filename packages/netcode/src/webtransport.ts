// A Connection over WebTransport (W3C WebTransport, Candidate Recommendation of 30 July 2026, on HTTP/3): 'unreliable'
// messages are datagrams, so a lost snapshot never holds up the next and no ICE or signalling is needed, and 'reliable'
// messages are length-prefixed on one bidirectional stream.
import { closeReason, CloseCode, fault, type Connection, type Delivery } from './transport.js';

/** The part of a WebTransport session this connection uses: the W3C class, or a server's session of the same shape. */
export interface WebTransportSession {
  /** Resolves once the session is up. */
  readonly ready: Promise<unknown>;
  /** Resolves with the close code and reason when the session ends; rejects when it ends in failure. */
  readonly closed: Promise<{ closeCode?: number; reason?: string }>;
  /** Ends the session. */
  close(info?: { closeCode?: number; reason?: string }): void;
  /** The datagram channel. */
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>;
    /** How big a datagram can be; the spec drops a bigger one without telling anyone. */
    readonly maxDatagramSize?: number;
    /** The spec's way to write. */
    createWritable?(): WritableStream<Uint8Array>;
    /** Older browsers' way to write. */
    readonly writable?: WritableStream<Uint8Array>;
  };
  /** Opens a bidirectional stream. */
  createBidirectionalStream(): Promise<WebTransportStreamPair>;
  /** Bidirectional streams the other end opened. */
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportStreamPair>;
}

/** One bidirectional stream of a {@link WebTransportSession}. */
export interface WebTransportStreamPair {
  /** Bytes from the other end. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Bytes to the other end. */
  readonly writable: WritableStream<Uint8Array>;
}

/** Options of {@link webTransportConnection}. */
export interface WebTransportConnectionOptions {
  /** Unreliable messages are dropped while this many bytes wait on the reliable stream (default 65,536). */
  dropUnreliableAbove?: number;
  /** Largest reliable message taken from the other end, in bytes (default 16 MiB); bigger closes the connection. */
  maxMessageBytes?: number;
}

/** Options of {@link openWebTransport}. */
export interface OpenWebTransportOptions extends WebTransportConnectionOptions {
  /** Aborts the connect (the promise rejects with the signal's reason). */
  signal?: AbortSignal;
  /** Hashes of a self-signed certificate of at most 14 days, for a server with no public certificate. */
  serverCertificateHashes?: readonly { algorithm: 'sha-256'; value: BufferSource }[];
  /** `'low-latency'` (the default here) or `'throughput'`. */
  congestionControl?: 'default' | 'throughput' | 'low-latency';
  /** The WebTransport class (default the global one). */
  WebTransport?: new (url: string, options?: object) => WebTransportSession;
}

class SessionConnection implements Connection {
  onmessage: ((data: Uint8Array, channel: Delivery) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  private closed = false;
  private waiting = 0;
  private readonly datagrams: WritableStreamDefaultWriter<Uint8Array>;
  private readonly stream: WritableStreamDefaultWriter<Uint8Array>;
  private readonly dropAbove: number;
  private readonly maxBytes: number;

  constructor(
    private readonly session: WebTransportSession,
    pair: WebTransportStreamPair,
    options: WebTransportConnectionOptions,
  ) {
    this.dropAbove = options.dropUnreliableAbove ?? 65536;
    this.maxBytes = options.maxMessageBytes ?? 1 << 24;
    const out = session.datagrams.createWritable?.() ?? session.datagrams.writable;
    if (!out) throw new TypeError('WebTransport session has no way to write datagrams; update the browser or server');
    this.datagrams = out.getWriter();
    this.stream = pair.writable.getWriter();
    session.closed.then(
      (info) => this.finish(info?.closeCode ?? CloseCode.normal, info?.reason ?? ''),
      (error) => this.finish(CloseCode.timeout, String(error?.message ?? error)),
    );
    void this.readDatagrams();
    void this.readStream(pair.readable);
  }

  get open(): boolean {
    return !this.closed;
  }

  private async readDatagrams(): Promise<void> {
    const reader = this.session.datagrams.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || this.closed) return;
      this.onmessage?.(value as Uint8Array, 'unreliable');
    }
  }

  /** Frames of a 4-byte little-endian length and that many bytes; a read can end anywhere in one. */
  private async readStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    let held = new Uint8Array(4096),
      used = 0;
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || this.closed) return;
      const chunk = value as Uint8Array;
      if (used + chunk.length > held.length) {
        const bigger = new Uint8Array(Math.max(held.length * 2, used + chunk.length));
        bigger.set(held.subarray(0, used));
        held = bigger;
      }
      held.set(chunk, used);
      used += chunk.length;
      let at = 0;
      while (used - at >= 4) {
        const size = new DataView(held.buffer, at, 4).getUint32(0, true);
        if (size > this.maxBytes) return this.close(CloseCode.rateLimit, 'message too large');
        if (used - at - 4 < size) break;
        this.onmessage?.(held.slice(at + 4, at + 4 + size), 'reliable');
        if (this.closed) return;
        at += 4 + size;
      }
      // Bytes move only after a whole message left, so a long message arriving in many reads is not copied each time.
      if (at > 0) held.copyWithin(0, at, used);
      used -= at;
    }
  }

  send(data: Uint8Array, channel: Delivery = 'reliable'): void {
    if (this.closed) return;
    if (channel === 'unreliable') {
      const size = this.session.datagrams.maxDatagramSize ?? Infinity;
      if (data.length <= size) {
        // A full queue means the link is behind: a stale snapshot queued behind others is worse than none.
        if ((this.datagrams.desiredSize ?? 1) > 0) this.datagrams.write(data).catch(() => {});
        return;
      }
      // Too big for a datagram, which would vanish without a word: it goes on the stream, as on a WebSocket.
      if (this.waiting > this.dropAbove) return;
    }
    const frame = new Uint8Array(4 + data.length);
    new DataView(frame.buffer).setUint32(0, data.length, true);
    frame.set(data, 4);
    this.waiting += frame.length;
    this.stream.write(frame).then(
      () => (this.waiting -= frame.length),
      () => {},
    );
  }

  close(code: number = CloseCode.normal, reason = ''): void {
    if (this.closed) return;
    this.session.close({ closeCode: code, reason: closeReason(reason, 1024) });
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(code, reason);
  }
}

/**
 * A {@link Connection} over a session that is up and one bidirectional stream of it. Use {@link openWebTransport} on a
 * client and {@link acceptWebTransport} on a server; this is for a stream you opened yourself.
 * @throws TypeError when the session cannot write datagrams.
 */
export function webTransportConnection(
  session: WebTransportSession,
  stream: WebTransportStreamPair,
  options: WebTransportConnectionOptions = {},
): Connection {
  return new SessionConnection(session, stream, options);
}

/**
 * The server end: waits for the session and for the stream the client opens, and resolves with a {@link Connection} for
 * `GameServer.accept`. Pass a session of the W3C shape, as the HTTP/3 server you run gives you.
 * @throws MargoError `failed` (as a rejection) when the session ends before the client opened its stream.
 */
export async function acceptWebTransport(
  session: WebTransportSession,
  options: WebTransportConnectionOptions = {},
): Promise<Connection> {
  await session.ready;
  const reader = session.incomingBidirectionalStreams.getReader(),
    { done, value } = await reader.read();
  reader.releaseLock();
  if (done || !value) throw fault('failed', 'WebTransport session ended before its stream opened; check the client');
  return webTransportConnection(session, value, options);
}

/**
 * Opens a {@link Connection} to an `https://` HTTP/3 server, where the WebTransport class exists.
 *
 * @example
 * ```ts
 * const connection = await openWebTransport('https://game.example.com/play');
 * const client = await GameClient.join(game, connection, { input: readInput });
 * ```
 *
 * @throws MargoError `unsupported` where there is no WebTransport, `failed` (as a rejection) when the session does not
 * come up; the signal's reason when `signal` aborts.
 */
export async function openWebTransport(url: string, options: OpenWebTransportOptions = {}): Promise<Connection> {
  const { signal, serverCertificateHashes, congestionControl = 'low-latency' } = options,
    Class =
      options.WebTransport ??
      (globalThis as { WebTransport?: OpenWebTransportOptions['WebTransport'] }).WebTransport;
  signal?.throwIfAborted();
  if (!Class) throw fault('unsupported', 'WebTransport is not available here; use openWebSocket instead');
  const session = new Class(url, {
    congestionControl,
    requireUnreliable: true,
    ...(serverCertificateHashes ? { serverCertificateHashes } : {}),
  });
  session.closed.catch(() => {});
  const abort = () => session.close({ closeCode: CloseCode.normal, reason: 'aborted' });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await session.ready;
    const stream = await session.createBidirectionalStream();
    signal?.throwIfAborted();
    return webTransportConnection(session, stream, options);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw fault('failed', `WebTransport to ${url} did not open (${(error as Error).message}); check the server`);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
