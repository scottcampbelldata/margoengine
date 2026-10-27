// The transport contract: what GameServer and GameClient need from a connection, whatever carries the bytes
// (the in-memory loopback, a WebSocket, a WebRTC data channel or your own).
import { MargoError } from '@margoengine/math/errors';

/**
 * How a message travels. `reliable`: arrives once, in order (retransmitted under loss). `unreliable`: may be lost,
 * duplicated or reordered, never delayed by an earlier lost message. A transport without an unreliable path (a
 * WebSocket) sends both kinds reliably.
 */
export type Channel = 'reliable' | 'unreliable';

/** Close codes the netcode uses, in the WebSocket application range (4000 to 4999) plus 1000 for a normal close. */
export const CloseCode = {
  /** Closed on purpose. */
  normal: 1000,
  /** The peer sent bytes that do not decode, or a message out of turn. */
  protocol: 4001,
  /** The peer sent more messages or bytes than the server's limits allow. */
  rateLimit: 4002,
  /** The two ends run different protocol versions or schemas. */
  mismatch: 4003,
  /** The server holds its maximum number of players. */
  full: 4004,
  /** The server removed the player (kick, or it shut down). */
  removed: 4005,
  /** The peer stopped answering. */
  timeout: 4006,
} as const;

/**
 * One end of a two-way message connection. GameServer and GameClient set `onmessage` and `onclose`; anything else
 * that implements this shape is a transport.
 */
export interface Connection {
  /** False once either end closed. */
  readonly open: boolean;
  /** Sends one message; does nothing once closed. `channel` defaults to `'reliable'`. */
  send(data: Uint8Array, channel?: Channel): void;
  /** Closes both ends; the other end's `onclose` gets `code` and `reason`. Closing twice does nothing. */
  close(code?: number, reason?: string): void;
  /** Called for each message that arrives. */
  onmessage: ((data: Uint8Array, channel: Channel) => void) | null;
  /** Called once when the connection closes, from either end. */
  onclose: ((code: number, reason: string) => void) | null;
}

/** A server end that accepts connections. */
export interface Listener {
  /** Called for each new connection. */
  onconnection: ((connection: Connection) => void) | null;
  /** Stops accepting connections (open ones stay open). */
  close(): void;
}

/** One message from {@link messages}. */
export interface ConnectionMessage {
  /** The message bytes. */
  data: Uint8Array;
  /** The channel it came on. */
  channel: Channel;
}

/**
 * The messages of `connection` as an async iterator, for code that reads a connection directly (GameServer and
 * GameClient do not need it). The iterator ends when the connection closes or `signal` aborts; it takes over
 * `onmessage` and `onclose`.
 *
 * @example
 * ```ts
 * for await (const { data } of messages(connection, { signal })) console.log(data.length);
 * ```
 */
export async function* messages(
  connection: Connection,
  { signal }: { signal?: AbortSignal } = {},
): AsyncGenerator<ConnectionMessage, void, undefined> {
  const queue: ConnectionMessage[] = [];
  let wake: (() => void) | null = null,
    done = !connection.open;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  connection.onmessage = (data, channel) => {
    queue.push({ data, channel });
    notify();
  };
  connection.onclose = () => {
    done = true;
    notify();
  };
  const abort = () => {
    done = true;
    notify();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      while (queue.length) yield queue.shift() as ConnectionMessage;
      if (done || signal?.aborted) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** A coded MargoError. */
export const fault = (code: 'state' | 'failed' | 'disposed' | 'unsupported', message: string): MargoError =>
  new MargoError(code, message);
