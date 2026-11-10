import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { MargoError } from '@margoengine/math/errors';
import type { VoxelServer, VoxelServerConnection, VoxelServerOptions } from './server.js';
import { originAllowed } from './websocket.js';

/** Native listener options shared by Bun and Deno. */
export interface VoxelRuntimeListenOptions {
  /** Port, 0 for a free port. Default 0. */
  port?: number;
  /** Bind hostname. Default '127.0.0.1'. */
  hostname?: string;
  /** Abort closes listener, clients and generator workers. */
  signal?: AbortSignal;
}
/** Native host and its ordinary authoritative server. */
export interface VoxelRuntimeHost extends AsyncDisposable {
  /** Game hooks, world, metrics and persistence use the existing server. */
  readonly server: VoxelServer;
  /** Actual bound port. */
  readonly port: number;
  /** Bound hostname. */
  readonly hostname: string;
  /** WebSocket endpoint, including the selected free port. */
  readonly url: string;
  /** Closes all owned resources, idempotently. */
  close(): Promise<void>;
}

interface NativeSocket {
  send(data: Uint8Array): number | void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
  getBufferedAmount?(): number;
  ping?(): unknown;
  cork?(fn: () => void): void;
}
interface Pending {
  request: IncomingMessage;
  address: string;
  release(): void;
  connection?: NativeConnection;
}
interface BunSocket extends NativeSocket {
  data: Pending;
}
interface BunServer {
  port: number;
  hostname: string;
  upgrade(request: Request, options: { data: Pending }): boolean;
  requestIP(request: Request): { address: string } | null;
  stop(closeActive: boolean): void | Promise<void>;
}
interface BunRuntime {
  serve(options: {
    port: number;
    hostname: string;
    fetch(request: Request, server: BunServer): Response | undefined;
    websocket: {
      maxPayloadLength: number;
      backpressureLimit: number;
      closeOnBackpressureLimit: boolean;
      idleTimeout: number;
      open(socket: BunSocket): void;
      message(socket: BunSocket, message: string | Uint8Array): void;
      close(socket: BunSocket, code: number, reason: string): void;
      pong(socket: BunSocket): void;
    };
    tls?: VoxelServerOptions['tls'];
  }): BunServer;
}
interface DenoServer {
  addr: { hostname: string; port: number };
  shutdown(): Promise<void>;
}
interface DenoRuntime {
  serve(
    options: { port: number; hostname: string; onListen(): void; key?: string; cert?: string },
    handler: (request: Request, info: { remoteAddr: { hostname: string } }) => Response,
  ): DenoServer;
  upgradeWebSocket(request: Request, options: { idleTimeout: number }): { socket: WebSocket; response: Response };
}

class NativeConnection implements VoxelServerConnection {
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  bytesIn = 0;
  #closed = false;
  #held: Uint8Array[] | undefined;
  #heldBytes = 0;
  constructor(
    readonly socket: NativeSocket,
    readonly pending: Pending,
    readonly remove: () => void,
  ) {}
  get buffered(): number {
    return (this.socket.getBufferedAmount?.() ?? this.socket.bufferedAmount ?? 0) + this.#heldBytes;
  }
  send(data: Uint8Array): void {
    if (this.#closed) return;
    if (data[0] === 16) this.pending.release(); // welcome: no longer pending
    if (this.#held) {
      this.#held.push(data);
      this.#heldBytes += data.length;
    } else if (this.socket.send(data) === 0) this.close(1013, 'native-backpressure');
  }
  receive(data: string | Uint8Array | ArrayBuffer): void {
    if (this.#closed) return;
    if (typeof data === 'string') return this.close(1003, 'binary messages required');
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length > 4096) return this.close(1009, 'message exceeds 4096 bytes');
    this.bytesIn += bytes.length;
    this.onmessage?.(bytes.slice());
  }
  finish(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#held = undefined;
    this.#heldBytes = 0;
    this.pending.release();
    this.remove();
    this.onclose?.(code, reason);
  }
  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    this.socket.close(code, reason);
    this.finish(code, reason);
  }
  cork(): void {
    this.#held ??= [];
  }
  uncork(): void {
    const messages = this.#held;
    this.#held = undefined;
    this.#heldBytes = 0;
    if (!messages) return;
    const flush = (): void => {
      for (const data of messages) this.send(data);
    };
    if (this.socket.cork) this.socket.cork(flush);
    else flush();
  }
  ping(): void {
    this.socket.ping?.();
  }
}

class Context {
  readonly connections = new Set<NativeConnection>();
  #pending = 0;
  readonly #addresses = new Map<string, number>();
  closed = false;
  constructor(
    readonly server: VoxelServer,
    readonly options: VoxelServerOptions,
  ) {}
  reserve(request: Request, address: string): Pending | Response {
    if (this.closed) return new Response('server is closing', { status: 503 });
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('voxel-net: connect with a WebSocket', { status: 426 });
    const node = new IncomingMessage(new Socket());
    const url = new URL(request.url);
    node.url = url.pathname + url.search;
    node.method = request.method;
    node.headers = Object.fromEntries(request.headers);
    node.headers.host ??= url.host;
    node.rawHeaders = [...request.headers].flat();
    Object.defineProperty(node.socket, 'remoteAddress', { value: address });
    if (!originAllowed(node, this.options.origins))
      return new Response('origin-refused: add this origin to origins', { status: 403 });
    if (this.#pending >= (this.options.maxPending ?? 64))
      return new Response('server-busy: maxPending reached', { status: 503 });
    const count = this.#addresses.get(address) ?? 0;
    if (count >= (this.options.maxPerAddress ?? 8))
      return new Response('too-many: maxPerAddress reached', { status: 429 });
    this.#pending++;
    this.#addresses.set(address, count + 1);
    let released = false;
    return {
      request: node,
      address,
      release: () => {
        if (released) return;
        released = true;
        this.#pending--;
        const left = (this.#addresses.get(address) ?? 1) - 1;
        if (left) this.#addresses.set(address, left);
        else this.#addresses.delete(address);
        node.destroy();
      },
    };
  }
  open(socket: NativeSocket, pending: Pending): NativeConnection {
    const connection = new NativeConnection(socket, pending, () => this.connections.delete(connection));
    this.connections.add(connection);
    pending.connection = connection;
    try {
      this.server.accept(connection, pending.request, pending.address);
    } catch (error) {
      connection.close(1011, 'server-accept-failed');
      this.server.onError(error);
    }
    return connection;
  }
}

async function context(options: VoxelServerOptions, listen: VoxelRuntimeListenOptions): Promise<Context> {
  listen.signal?.throwIfAborted();
  const { VoxelServer } = await import('./server.js');
  const server = new VoxelServer(options);
  try {
    await server.start();
    listen.signal?.throwIfAborted();
    return new Context(server, options);
  } catch (error) {
    await server.close();
    throw error;
  }
}
function host(
  ctx: Context,
  port: number,
  hostname: string,
  stop: () => Promise<void>,
  signal?: AbortSignal,
): VoxelRuntimeHost {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    ctx.closed = true;
    signal?.removeEventListener('abort', aborted);
    closing = ctx.server.close().finally(stop);
    return closing;
  };
  const aborted = (): void => {
    void close().catch((error) => ctx.server.onError(error));
  };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  return {
    server: ctx.server,
    port,
    hostname,
    url: `${ctx.options.tls ? 'wss' : 'ws'}://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`,
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** Starts a Bun.serve WebSocket listener with the existing authoritative world, codec and server rules. */
export async function serveVoxelBun(
  options: VoxelServerOptions,
  listen: VoxelRuntimeListenOptions = {},
): Promise<VoxelRuntimeHost> {
  const native = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  if (!native?.serve) throw new MargoError('unsupported', 'Bun native server requires Bun; run this entry with bun');
  const ctx = await context(options, listen);
  try {
    const server = native.serve({
      port: listen.port ?? 0,
      hostname: listen.hostname ?? '127.0.0.1',
      tls: options.tls,
      fetch: (request, server) => {
        const pending = ctx.reserve(request, server.requestIP(request)?.address ?? '');
        if (pending instanceof Response) return pending;
        if (server.upgrade(request, { data: pending })) return;
        pending.release();
        return new Response('invalid WebSocket upgrade', { status: 400 });
      },
      websocket: {
        maxPayloadLength: 4096,
        backpressureLimit: 4 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        idleTimeout: 0,
        open: (socket) => {
          ctx.open(socket, socket.data);
        },
        message: (socket, message) => socket.data.connection?.receive(message),
        close: (socket, code, reason) => {
          socket.data.release();
          socket.data.connection?.finish(code, reason);
        },
        pong: (socket) => {
          if (socket.data.connection) socket.data.connection.bytesIn++;
        },
      },
    });
    return host(
      ctx,
      server.port,
      server.hostname,
      async () => {
        await server.stop(true);
      },
      listen.signal,
    );
  } catch (error) {
    await ctx.server.close();
    throw error;
  }
}

/** Starts Deno.serve and Deno.upgradeWebSocket with the existing authoritative world and message codec. */
export async function serveVoxelDeno(
  options: VoxelServerOptions,
  listen: VoxelRuntimeListenOptions = {},
): Promise<VoxelRuntimeHost> {
  const native = (globalThis as unknown as { Deno?: DenoRuntime }).Deno;
  if (!native?.serve || !native.upgradeWebSocket)
    throw new MargoError('unsupported', 'Deno native server requires Deno; run this entry with deno run');
  const ctx = await context(options, listen);
  try {
    if (options.tls && (typeof options.tls.key !== 'string' || typeof options.tls.cert !== 'string'))
      throw new TypeError('Deno TLS needs PEM strings; decode key and cert as text');
    const server = native.serve(
      {
        port: listen.port ?? 0,
        hostname: listen.hostname ?? '127.0.0.1',
        onListen: () => {},
        ...(options.tls ? { key: options.tls.key as string, cert: options.tls.cert as string } : {}),
      },
      (request, info) => {
        const pending = ctx.reserve(request, info.remoteAddr.hostname);
        if (pending instanceof Response) return pending;
        let upgraded: ReturnType<DenoRuntime['upgradeWebSocket']>;
        try {
          upgraded = native.upgradeWebSocket(request, { idleTimeout: 0 });
        } catch (error) {
          pending.release();
          ctx.server.onError(error);
          return new Response('invalid WebSocket upgrade', { status: 400 });
        }
        const socket = upgraded.socket;
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => {
          ctx.open(socket as NativeSocket, pending);
        });
        socket.addEventListener('message', (event) => pending.connection?.receive(event.data));
        socket.addEventListener('close', (event) => {
          pending.release();
          pending.connection?.finish(event.code, event.reason);
        });
        socket.addEventListener('error', () => {
          pending.release();
          pending.connection?.finish(1006, 'native-socket-error');
        });
        return upgraded.response;
      },
    );
    return host(ctx, server.addr.port, server.addr.hostname, () => server.shutdown(), listen.signal);
  } catch (error) {
    await ctx.server.close();
    throw error;
  }
}
