// A Connection over a WebSocket (browsers, Deno, Bun and Node 22+ all have the standard WebSocket class). A WebSocket
// is a reliable ordered stream, so 'unreliable' messages are sent reliably too; for real unreliable delivery in a
// browser use the WebRTC transport.
import { CloseCode, fault, type Connection, type Delivery } from './transport.js';

/** Options of {@link openWebSocket}. */
export interface OpenWebSocketOptions {
  /** Subprotocols to offer (default none). */
  protocols?: string | string[];
  /** Aborts the connect (the promise rejects with the signal's reason). */
  signal?: AbortSignal;
  /**
   * Bytes buffered in the socket above which 'unreliable' messages are dropped instead of queued (default 64 KiB):
   * a stale snapshot queued behind others is worse than none.
   */
  dropUnreliableAbove?: number;
  /** The WebSocket class to use (default the global one). */
  WebSocket?: typeof WebSocket;
}

/** A {@link Connection} over an open standard WebSocket (binary messages only). */
class WebSocketConnection implements Connection {
  onmessage: ((data: Uint8Array, channel: Delivery) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  private closed = false;
  constructor(
    private readonly socket: WebSocket,
    private readonly dropAbove: number,
  ) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      if (this.closed) return;
      if (!(event.data instanceof ArrayBuffer)) {
        this.close(CloseCode.protocol, 'text frame');
        return;
      }
      this.onmessage?.(new Uint8Array(event.data), 'reliable');
    });
    socket.addEventListener('close', (event) => this.finish(event.code, event.reason));
  }
  get open(): boolean {
    return !this.closed && this.socket.readyState === 1;
  }
  send(data: Uint8Array, channel: Delivery = 'reliable'): void {
    if (!this.open) return;
    if (channel === 'unreliable' && this.socket.bufferedAmount > this.dropAbove) return;
    this.socket.send(data as Uint8Array<ArrayBuffer>);
  }
  close(code: number = CloseCode.normal, reason = ''): void {
    if (this.closed) return;
    // The WebSocket API accepts 1000 and 3000 to 4999 from applications.
    this.socket.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason.slice(0, 120));
    this.finish(code, reason);
  }
  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(code, reason);
  }
}

/**
 * Opens a WebSocket to `url` and resolves with a {@link Connection} once it is open.
 *
 * @example
 * ```ts
 * const connection = await openWebSocket('wss://game.example.com/play');
 * const client = await GameClient.join(game, connection, { input: readKeys });
 * ```
 * @throws MargoError `unsupported` (as a rejection) when there is no WebSocket class; `failed` when the socket closes
 * before it opens; the signal's reason when `signal` aborts.
 */
export function openWebSocket(url: string | URL, options: OpenWebSocketOptions = {}): Promise<Connection> {
  const Socket = options.WebSocket ?? globalThis.WebSocket,
    signal = options.signal,
    dropAbove = options.dropUnreliableAbove ?? 65536;
  if (typeof Socket !== 'function')
    return Promise.reject(fault('unsupported', 'No WebSocket class here; pass options.WebSocket or use Node 22+'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const socket = new Socket(url, options.protocols);
    socket.binaryType = 'arraybuffer';
    const abort = () => {
      socket.close();
      reject(signal?.reason);
    };
    const stop = () => {
      signal?.removeEventListener('abort', abort);
      socket.removeEventListener('close', failed);
      socket.removeEventListener('error', errored);
    };
    const failed = (event: CloseEvent) => {
      stop();
      reject(fault('failed', `WebSocket to ${url} closed before it opened (${event.code}); check the URL and server`));
    };
    // A failed connection fires 'error' and then 'close' in browsers and Node 24, but only 'error' in Node 22's
    // WebSocket (readyState stays CONNECTING), so the error alone settles the promise.
    const errored = () => {
      stop();
      socket.close();
      reject(fault('failed', `WebSocket to ${url} failed before it opened; check the URL and server`));
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.addEventListener('close', failed, { once: true });
    socket.addEventListener('error', errored, { once: true });
    socket.addEventListener(
      'open',
      () => {
        stop();
        resolve(new WebSocketConnection(socket, dropAbove));
      },
      { once: true },
    );
  });
}
