// Node only: a WebSocket server (RFC 6455, written here on node:http and node:crypto, binary messages only) that
// hands each connection over as a netcode Connection, and `serve`, which runs a GameServer on it.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Game } from './game.js';
import { GameServer, type GameServerOptions } from './server.js';
import { CloseCode, type Connection, type Delivery, type Listener } from './transport.js';

/** Options of {@link listenWebSocket}. */
export interface WebSocketServerOptions {
  /** TCP port; 0 picks a free one (default 0). */
  port?: number;
  /** Interface to bind (default '127.0.0.1'; pass '0.0.0.0' to accept other machines). */
  host?: string;
  /** The URL path that accepts WebSocket upgrades (default any path). */
  path?: string;
  /** Allowed `Origin` headers; other origins get 403 (default any, including none). */
  origins?: readonly string[];
  /** Largest message accepted from a client, in bytes (default 64 KiB); a bigger one closes with 1009. */
  maxPayload?: number;
  /** Bytes queued in a socket above which 'unreliable' messages are dropped (default 64 KiB). */
  dropUnreliableAbove?: number;
  /** Bytes queued in a socket above which the client is closed as too slow (default 8 MiB). */
  maxBuffered?: number;
  /** An existing HTTP server to attach to instead of creating one (`port` and `host` are then ignored). */
  server?: Server;
}

/** A listening WebSocket server. */
export interface WebSocketListener extends Listener {
  /** The port it listens on. */
  readonly port: number;
  /** The HTTP server underneath. */
  readonly http: Server;
  /** Stops accepting, closes every connection with 1001 and resolves when the HTTP server has closed. */
  close(): void;
  /** Resolves when the HTTP server has closed. */
  readonly closed: Promise<void>;
  /** Same as close, for `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One server-side WebSocket: frames in, frames out (RFC 6455 section 5). */
class SocketConnection implements Connection {
  onmessage: ((data: Uint8Array, channel: Delivery) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  private closed = false;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentKind = 0;

  constructor(
    private readonly socket: Duplex,
    private readonly options: Required<
      Pick<WebSocketServerOptions, 'maxPayload' | 'dropUnreliableAbove' | 'maxBuffered'>
    >,
    private readonly forget: (connection: SocketConnection) => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.data(chunk));
    socket.on('close', () => this.finish(1006, 'connection lost'));
    socket.on('error', () => this.finish(1006, 'connection error'));
  }

  get open(): boolean {
    return !this.closed;
  }

  private frame(opcode: number, payload: Uint8Array): Buffer {
    const n = payload.length,
      head = n < 126 ? 2 : n < 65536 ? 4 : 10,
      out = Buffer.allocUnsafe(head + n);
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
    out.set(payload, head);
    return out;
  }

  send(data: Uint8Array, channel: Delivery = 'reliable'): void {
    if (this.closed) return;
    const queued = (this.socket as unknown as { writableLength: number }).writableLength;
    if (channel === 'unreliable' && queued > this.options.dropUnreliableAbove) return;
    if (queued > this.options.maxBuffered) return this.close(1008, 'client too slow');
    this.socket.write(this.frame(2, data));
  }

  close(code: number = CloseCode.normal, reason = ''): void {
    if (this.closed) return;
    const text = Buffer.from(reason.slice(0, 120)),
      payload = Buffer.allocUnsafe(2 + text.length);
    payload.writeUInt16BE(code === 1005 || code === 1006 ? 1000 : code, 0);
    text.copy(payload, 2);
    this.socket.end(this.frame(8, payload));
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.forget(this);
    this.onclose?.(code, reason);
  }

  private data(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0,
        opcode = b[0] & 0x0f,
        masked = (b[1] & 0x80) !== 0;
      if (b[0] & 0x70) return this.close(1002, 'reserved bits set');
      if (!masked) return this.close(1002, 'client frames must be masked');
      let length = b[1] & 0x7f,
        at = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        const high = b.readUInt32BE(2);
        if (high) return this.close(1009, 'message too big');
        length = b.readUInt32BE(6);
        at = 10;
      }
      const control = opcode >= 8;
      if (control && (length > 125 || !fin)) return this.close(1002, 'bad control frame');
      if (length > this.options.maxPayload || this.fragmentBytes + length > this.options.maxPayload)
        return this.close(1009, 'message too big');
      if (b.length < at + 4 + length) return;
      const mask = b.subarray(at, at + 4),
        payload = Buffer.from(b.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(at + 4 + length);
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        return this.close(code === 1005 ? 1000 : code, payload.subarray(2).toString('utf8'));
      }
      if (opcode === 9) {
        this.socket.write(this.frame(10, payload));
        continue;
      }
      if (opcode === 10) continue;
      if (opcode === 1) return this.close(1003, 'binary messages only');
      if (opcode === 2) {
        if (this.fragments.length) return this.close(1002, 'new message inside a fragmented one');
        if (fin) this.onmessage?.(payload, 'reliable');
        else {
          this.fragmentKind = 2;
          this.fragments.push(payload);
          this.fragmentBytes = length;
        }
        continue;
      }
      if (opcode === 0) {
        if (!this.fragments.length && this.fragmentKind !== 2) return this.close(1002, 'continuation without a start');
        this.fragments.push(payload);
        this.fragmentBytes += length;
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentKind = 0;
          this.onmessage?.(whole, 'reliable');
        }
        continue;
      }
      return this.close(1002, `unknown opcode ${opcode}`);
    }
  }
}

/**
 * Starts a WebSocket server and resolves once it listens. Each accepted socket arrives through `onconnection` as a
 * {@link Connection}; pass it to `GameServer.accept`.
 *
 * @example
 * ```ts
 * const listener = await listenWebSocket({ port: 8080, host: '0.0.0.0', origins: ['https://game.example.com'] });
 * listener.onconnection = (connection) => server.accept(connection);
 * ```
 * @throws RangeError (as a rejection) for a port or limit out of range; the server's error when it cannot listen.
 */
export async function listenWebSocket(options: WebSocketServerOptions = {}): Promise<WebSocketListener> {
  const port = options.port ?? 0,
    maxPayload = options.maxPayload ?? 65536,
    limits = {
      maxPayload,
      dropUnreliableAbove: options.dropUnreliableAbove ?? 65536,
      maxBuffered: options.maxBuffered ?? 8 * 1024 * 1024,
    };
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError(`WebSocket port is ${port}; pass an integer from 0 to 65535`);
  if (!Number.isInteger(maxPayload) || maxPayload < 1 || maxPayload > 2 ** 31)
    throw new RangeError(`WebSocket maxPayload is ${maxPayload}; pass bytes from 1 to 2^31`);
  const http = options.server ?? createServer((_request, response) => response.writeHead(426).end('Upgrade required')),
    connections = new Set<SocketConnection>();
  let accepting = true;
  const refuse = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const key = request.headers['sec-websocket-key'],
      path = new URL(request.url ?? '/', 'http://localhost').pathname,
      origin = request.headers.origin;
    if (!accepting) return refuse(socket, '503 Service Unavailable');
    if (options.path !== undefined && path !== options.path) return refuse(socket, '404 Not Found');
    if (options.origins && (origin === undefined || !options.origins.includes(origin)))
      return refuse(socket, '403 Forbidden');
    if (
      request.method !== 'GET' ||
      String(request.headers.upgrade).toLowerCase() !== 'websocket' ||
      request.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' ||
      Buffer.from(key, 'base64').length !== 16
    )
      return refuse(socket, '400 Bad Request');
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    (socket as unknown as { setNoDelay?(on: boolean): void }).setNoDelay?.(true);
    const connection = new SocketConnection(socket, limits, (c) => connections.delete(c));
    connections.add(connection);
    listener.onconnection?.(connection);
    if (head.length) socket.unshift(head);
  };
  http.on('upgrade', upgrade);
  if (!options.server)
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, options.host ?? '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
  let done: () => void = () => {};
  const closed = new Promise<void>((resolve) => (done = resolve));
  const listener: WebSocketListener = {
    onconnection: null,
    get port() {
      const address = http.address();
      return typeof address === 'object' && address ? address.port : port;
    },
    http,
    closed,
    close() {
      if (!accepting) return;
      accepting = false;
      http.off('upgrade', upgrade);
      for (const connection of [...connections]) connection.close(1001, 'server closing');
      if (options.server) done();
      else http.close(() => done());
    },
    async [Symbol.asyncDispose]() {
      listener.close();
      await closed;
    },
  };
  return listener;
}

/** Options of {@link serve}: the WebSocket server's and the GameServer's. */
export interface ServeOptions<State, Input> extends WebSocketServerOptions, GameServerOptions<State, Input> {
  /** Stops the server: ticks end, connections close, the HTTP server closes. */
  signal?: AbortSignal;
}

/** A running game server from {@link serve}. */
export interface Served<State, Input> {
  /** The game server. */
  server: GameServer<State, Input>;
  /** The WebSocket listener. */
  listener: WebSocketListener;
  /** The port it listens on. */
  port: number;
  /** Resolves when the server stopped (after `close` or the signal). */
  done: Promise<void>;
  /** Stops ticking and closes everything. */
  close(): Promise<void>;
  /** Same as close, for `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Runs `game` on a WebSocket server in real time: the self-hosted server in one call.
 *
 * @example
 * ```ts
 * // server.mjs: node server.mjs
 * import { serve } from '@margoengine/netcode/node';
 * import { game } from './game.js';
 * const { port } = await serve(game, { port: 8080, host: '0.0.0.0' });
 * console.log(`listening on ${port}`);
 * ```
 */
export async function serve<State, Input>(
  game: Game<State, Input>,
  options: ServeOptions<State, Input> = {},
): Promise<Served<State, Input>> {
  const listener = await listenWebSocket(options),
    server = new GameServer(game, options),
    stop = new AbortController(),
    signal = options.signal;
  listener.onconnection = (connection) => server.accept(connection);
  const close = async () => {
    stop.abort();
    await done;
  };
  signal?.addEventListener('abort', () => void close(), { once: true });
  if (signal?.aborted) stop.abort();
  const done = server.run({ signal: stop.signal }).then(async () => {
    server.close();
    listener.close();
    await listener.closed;
  });
  return { server, listener, port: listener.port, done, close, [Symbol.asyncDispose]: close };
}
