// A WebSocket (RFC 6455) for Node, written for @margoengine/voxel-net on node:http and node:crypto alone (design:
// packages/voxel-net/DESIGN.md, "Transport"). Binary messages only: a text frame closes the connection with 1003. The
// server side accepts an upgrade request; the client side (bots, tests) connects to a ws:// URL. No extensions.
import { createHash, randomBytes, randomFillSync } from 'node:crypto';
import { type IncomingMessage, request } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { MargoError } from '@margoengine/math/errors';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
  EMPTY = Buffer.alloc(0),
  CONTINUATION = 0,
  TEXT = 1,
  BINARY = 2,
  CLOSE = 8,
  PING = 9,
  PONG = 10,
  CLOSE_LINGER = 2000; // milliseconds a closing socket waits for its peer before it is destroyed

/** `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key`: base64 of the SHA-1 of the key and the RFC 6455 GUID. */
export const acceptKey = (key: string): string =>
  createHash('sha1')
    .update(key + GUID)
    .digest('base64');

/** Options of {@link WebSocketConnection}. */
export interface WebSocketOptions {
  /** Largest message accepted, in bytes; a longer one closes the connection with 1009. Default 4,096. */
  maxMessage?: number;
}

/**
 * One open WebSocket over a Node socket, either end. Frames from a client must be masked and frames from a server must
 * not be, or the connection closes with 1002. Messages may arrive in fragments; pings are answered; a close frame is
 * echoed. {@link WebSocketConnection.onmessage} receives each whole binary message.
 */
export class WebSocketConnection {
  /**
   * Called with each binary message. The bytes stay valid; they are not reused. Messages that arrive before a handler
   * is set (a hello sent in the same packet as the upgrade request, say) are kept, up to 4 x `maxMessage` bytes, and
   * delivered in order in a microtask after it is set.
   */
  get onmessage(): (data: Uint8Array) => void {
    return this.#onmessage ?? ignore;
  }
  set onmessage(handler: (data: Uint8Array) => void) {
    this.#onmessage = handler;
    this.#schedule();
  }
  /**
   * Called once when the connection ends, with the close code (1006 when the socket ended without one). A connection
   * that ended before a handler was set reports it in a microtask after it is set (after the early messages, when
   * onmessage is set too).
   */
  get onclose(): (code: number, reason: string) => void {
    return this.#onclose ?? ignore;
  }
  set onclose(handler: (code: number, reason: string) => void) {
    this.#onclose = handler;
    this.#schedule();
  }
  /** Bytes read from the socket, frame headers included. */
  bytesIn = 0;
  /** Bytes written to the socket, frame headers included. */
  bytesOut = 0;
  readonly #socket: Duplex;
  readonly #client: boolean;
  readonly #max: number;
  #buffer: Buffer = EMPTY;
  #parts: Buffer[] = [];
  #size = 0;
  #fragmented = false;
  #sentClose = false;
  #closed = false;
  #onmessage: ((data: Uint8Array) => void) | undefined;
  #onclose: ((code: number, reason: string) => void) | undefined;
  /** Messages not yet delivered: they arrived before onmessage was set, or while earlier ones wait to be. */
  #early: Uint8Array[] = [];
  #earlyBytes = 0;
  /** The close not yet reported, when the connection ended before onclose was set or before early messages left. */
  #ended: [number, string] | undefined;
  #flushing = false;
  #linger: ReturnType<typeof setTimeout> | undefined;
  /**
   * Takes over `socket` after the opening handshake. `client` is true on the connecting end (its frames are masked).
   * `head` holds bytes that arrived with the handshake.
   * @throws RangeError when `maxMessage` is not an integer >= 125.
   */
  constructor(socket: Duplex, client: boolean, options: WebSocketOptions = {}, head: Buffer = EMPTY) {
    const max = options.maxMessage ?? 4096;
    if (!Number.isInteger(max) || max < 125)
      throw new RangeError(`WebSocket maxMessage ${max} is invalid; pass an integer of at least 125 bytes`);
    this.#socket = socket;
    this.#client = client;
    this.#max = max;
    (socket as Socket).setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => this.#data(chunk));
    // HTTP server sockets allow half-open connections: a peer that leaves without a close frame must be ended here.
    socket.on('end', () => {
      socket.end();
      this.#end(1006, 'socket ended');
    });
    socket.on('close', () => {
      clearTimeout(this.#linger);
      this.#end(1006, 'socket closed');
    });
    socket.on('error', () => this.#end(1006, 'socket error'));
    if (head.length) this.#data(head);
  }
  /** Bytes written but not yet sent by the socket. */
  get buffered(): number {
    return this.#socket.writableLength;
  }
  /** Whether the connection has ended or is closing. */
  get closed(): boolean {
    return this.#closed || this.#sentClose;
  }
  /** Sends `data` as one binary message. Does nothing once the connection is closing. */
  send(data: Uint8Array): void {
    if (!this.closed) this.#frame(BINARY, data);
  }
  /**
   * Sends a ping frame. The other end's WebSocket answers by itself, a browser's too while its page's scripts are
   * throttled, and the answer shows in {@link WebSocketConnection.bytesIn}. Does nothing once the connection is closing.
   */
  ping(): void {
    if (!this.closed) this.#frame(PING, EMPTY);
  }
  /** Holds writes until {@link WebSocketConnection.uncork}, so a burst of messages leaves in few packets. */
  cork(): void {
    this.#socket.cork();
  }
  /** Releases writes held by {@link WebSocketConnection.cork}. */
  uncork(): void {
    this.#socket.uncork();
  }
  /**
   * Starts the closing handshake with `code` (default 1000) and `reason`, then ends the socket. A peer that has not
   * finished closing 2 s later is cut off, so one that stopped reading cannot hold the socket and its unsent bytes.
   */
  close(code = 1000, reason = ''): void {
    if (this.#sentClose || this.#closed) return;
    const text = Buffer.from(reason.slice(0, 120)),
      body = Buffer.allocUnsafe(2 + text.length);
    body.writeUInt16BE(code, 0);
    text.copy(body, 2);
    this.#frame(CLOSE, body);
    this.#sentClose = true;
    this.#shut();
    this.#end(code, reason);
  }
  #shut(): void {
    this.#socket.end();
    this.#linger = setTimeout(() => this.#socket.destroy(), CLOSE_LINGER);
    this.#linger.unref();
  }
  #end(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#parts = [];
    if (this.#onclose && !this.#early.length) this.#onclose(code, reason);
    else {
      this.#ended = [code, reason];
      this.#schedule();
    }
  }
  #message(data: Uint8Array): void {
    if (this.#onmessage && !this.#early.length) return this.#onmessage(data);
    this.#early.push(data);
    this.#earlyBytes += data.length;
    if (this.#earlyBytes > 4 * this.#max) {
      this.#early = [];
      this.#earlyBytes = 0;
      this.#fail(1008, 'messages arrived before a message handler was set');
    }
  }
  #schedule(): void {
    if (this.#flushing || (!this.#early.length && !this.#ended)) return;
    this.#flushing = true;
    queueMicrotask(() => {
      this.#flushing = false;
      if (this.#onmessage) {
        const early = this.#early;
        this.#early = [];
        this.#earlyBytes = 0;
        for (const data of early) this.#onmessage(data);
      }
      const ended = this.#ended;
      if (ended && this.#onclose) {
        this.#ended = undefined;
        this.#onclose(ended[0], ended[1]);
      }
    });
  }
  #frame(opcode: number, data: Uint8Array): void {
    const n = data.length,
      head = n < 126 ? 2 : n < 65536 ? 4 : 10,
      mask = this.#client ? 4 : 0,
      small = n <= 1024,
      out = Buffer.allocUnsafe(head + mask + (small ? n : 0));
    out[0] = 0x80 | opcode;
    if (n < 126) out[1] = n;
    else if (n < 65536) {
      out[1] = 126;
      out.writeUInt16BE(n, 2);
    } else {
      out[1] = 127;
      out.writeUInt32BE(Math.floor(n / 2 ** 32), 2);
      out.writeUInt32BE(n >>> 0, 6);
    }
    let body: Uint8Array = data;
    if (mask) {
      out[1] |= 0x80;
      randomFillSync(out, head, 4);
      const masked = small ? out.subarray(head + 4) : Buffer.allocUnsafe(n);
      for (let i = 0; i < n; i++) masked[i] = data[i] ^ out[head + (i & 3)];
      body = masked;
    } else if (small) out.set(data, head);
    this.#socket.write(out);
    if (!small) this.#socket.write(body);
    this.bytesOut += head + mask + n;
  }
  #fail(code: number, reason: string): void {
    this.close(code, reason);
    this.#buffer = EMPTY;
  }
  #data(chunk: Buffer): void {
    if (this.#closed) return;
    this.bytesIn += chunk.length;
    const b = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    let at = 0;
    while (!this.#closed && !this.#sentClose) {
      const left = b.length - at;
      if (left < 2) break;
      const b0 = b[at],
        b1 = b[at + 1],
        fin = (b0 & 0x80) !== 0,
        opcode = b0 & 15,
        masked = (b1 & 0x80) !== 0;
      let length = b1 & 127,
        head = 2;
      if (b0 & 0x70) return this.#fail(1002, 'reserved bits set');
      if (masked === this.#client)
        return this.#fail(1002, this.#client ? 'server frames must not be masked' : 'client frames must be masked');
      if (length === 126) {
        if (left < 4) break;
        length = b.readUInt16BE(at + 2);
        head = 4;
      } else if (length === 127) {
        if (left < 10) break;
        if (b.readUInt32BE(at + 2)) return this.#fail(1009, 'message too big');
        length = b.readUInt32BE(at + 6);
        head = 10;
      }
      if (opcode >= 8) {
        if (!fin || length > 125) return this.#fail(1002, 'control frames must be whole and at most 125 bytes');
      } else if (this.#size + length > this.#max) return this.#fail(1009, 'message too big');
      const start = at + head + (masked ? 4 : 0),
        end = start + length;
      if (end > b.length) break;
      const payload = b.subarray(start, end);
      if (masked) for (let i = 0; i < length; i++) payload[i] ^= b[at + head + (i & 3)];
      at = end;
      this.#handle(opcode, fin, payload);
    }
    this.#buffer = at < b.length && !this.#closed ? Buffer.from(b.subarray(at)) : EMPTY;
  }
  #handle(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === BINARY || opcode === CONTINUATION) {
      if ((opcode === CONTINUATION) !== this.#fragmented)
        return this.#fail(1002, this.#fragmented ? 'expected a continuation frame' : 'continuation without a message');
      if (fin && !this.#fragmented) return this.#message(payload);
      this.#parts.push(payload);
      this.#size += payload.length;
      this.#fragmented = !fin;
      if (fin) {
        const whole = Buffer.concat(this.#parts, this.#size);
        this.#parts = [];
        this.#size = 0;
        this.#message(whole);
      }
    } else if (opcode === TEXT) this.#fail(1003, 'binary messages only');
    else if (opcode === PING) this.#frame(PONG, payload);
    else if (opcode === CLOSE) {
      if (payload.length === 1) return this.#fail(1002, 'close frame of one byte');
      const code = payload.length ? payload.readUInt16BE(0) : 1005,
        reason = payload.subarray(2).toString('utf8');
      if (!this.#sentClose) {
        this.#frame(CLOSE, payload.length ? payload.subarray(0, 2) : EMPTY);
        this.#sentClose = true;
        this.#shut();
      }
      this.#end(code, reason);
    } else if (opcode !== PONG) this.#fail(1002, `unknown opcode ${opcode}`);
  }
}

const ignore = (): void => {};

const bad = (socket: Duplex, status: string, message = ''): undefined => {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
  return undefined;
};

/** Options of {@link acceptWebSocket}. */
export interface AcceptWebSocketOptions extends WebSocketOptions {
  /**
   * Which pages may connect, by their `Origin` header. Default: only pages served from this server's own host (the
   * Origin must be `http://` or `https://` plus the request's `Host` header). `'*'` allows any origin; a list allows
   * exactly those origins (and then a request without an Origin is refused too). Without a list, a request that sends
   * no Origin (Node, bots, native clients; browsers always send one) is accepted.
   */
  origins?: readonly string[] | '*';
  /**
   * Called after the request checks pass and before the 101 answer, so a refusal costs no connection object: return
   * `[status, message]` (for example `['429 Too Many Requests', 'too many connections']`) to answer with that HTTP
   * status and plain-text message instead, or undefined to accept. Default: accept.
   */
  admit?: (req: IncomingMessage) => readonly [status: string, message: string] | undefined;
}

/** Whether `req` comes from an origin that `origins` allows (see {@link AcceptWebSocketOptions.origins}). */
export function originAllowed(req: IncomingMessage, origins?: readonly string[] | '*'): boolean {
  const origin = req.headers.origin;
  if (origins === '*') return true;
  if (origins) return origins.includes(String(origin ?? ''));
  if (origin === undefined) return true;
  const host = String(req.headers.host ?? '').toLowerCase(),
    from = origin.toLowerCase();
  return host !== '' && (from === `http://${host}` || from === `https://${host}`);
}

/**
 * Answers a `node:http` server's `'upgrade'` event: checks the request (GET, `Upgrade: websocket`, version 13, a
 * 16-byte key, an allowed `Origin`), asks `admit`, writes the 101 response and returns the connection. A bad request
 * gets 400, an origin not allowed 403 with a message that names the `origins` option, a refusal by `admit` its own
 * status; each returns undefined.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: AcceptWebSocketOptions = {},
): WebSocketConnection | undefined {
  const key = req.headers['sec-websocket-key'],
    upgrade = String(req.headers.upgrade ?? '').toLowerCase(),
    connection = String(req.headers.connection ?? '').toLowerCase();
  if (
    req.method !== 'GET' ||
    upgrade !== 'websocket' ||
    !connection.split(/\s*,\s*/).includes('upgrade') ||
    req.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    Buffer.from(key, 'base64').length !== 16
  )
    return bad(socket, '400 Bad Request');
  if (!originAllowed(req, options.origins)) {
    const origin = req.headers.origin ?? '(none)';
    return bad(
      socket,
      '403 Forbidden',
      options.origins
        ? `origin-refused: Origin ${origin} is not in the origins option; add it to origins`
        : `origin-refused: Origin ${origin} is not this server's own host (${req.headers.host ?? 'no Host'}); ` +
            `pass origins: ['${origin}'], or '*' for any page, to allow it`,
    );
  }
  const refused = options.admit?.(req);
  if (refused) return bad(socket, refused[0], refused[1]);
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WebSocketConnection(socket, false, options, head);
}

/** Options of {@link connectWebSocket}. */
export interface ConnectWebSocketOptions extends WebSocketOptions {
  /** Extra request headers, such as `Authorization` or `Cookie` for a server's `authenticate` hook. Default none. */
  headers?: Record<string, string>;
}

/**
 * Opens a WebSocket to a `ws://host:port/path` URL from Node (bots and tests; browsers have their own WebSocket).
 * @throws TypeError (rejects) when `url` is not a ws:// URL.
 * @throws MargoError `'failed'` (rejects) when the server refuses the upgrade (the message holds the server's reason)
 * or answers with a wrong accept key.
 */
export function connectWebSocket(
  url: string | URL,
  options: ConnectWebSocketOptions = {},
): Promise<WebSocketConnection> {
  const target = new URL(url);
  if (target.protocol !== 'ws:')
    return Promise.reject(
      new TypeError(`connectWebSocket needs a ws:// URL, not ${target.protocol}; use ws://host:port`),
    );
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = request({
      host: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      headers: {
        ...options.headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        reject(
          new MargoError('failed', `WebSocket server at ${target} sent a wrong accept key; is it a WebSocket server?`),
        );
      } else resolve(new WebSocketConnection(socket, true, { maxMessage: options.maxMessage ?? 1 << 24 }, head));
    });
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part: string) => {
        if (text.length < 1024) text += part;
      });
      const refused = () =>
        reject(
          new MargoError(
            'failed',
            `WebSocket upgrade to ${target} was refused with ${res.statusCode}` +
              (text ? ` (${text.slice(0, 1024)})` : '; check the URL'),
          ),
        );
      res.on('end', refused);
      res.on('error', refused);
    });
    req.on('error', (error) =>
      reject(new MargoError('failed', `WebSocket connection to ${target} failed (${error.message}); start the server`)),
    );
    req.end();
  });
}
