// Signalling for WebRTC: peers find each other through a small server that only passes messages between members of a
// room. Offers, answers and ICE candidates travel over it (JSEP, RFC 8829; trickle ICE, RFC 8838), and from then on
// the peers talk directly and the server carries nothing. It runs on any Connection, so a WebSocket or the loopback.
import { CloseCode, fault, type Connection } from './transport.js';
import { createDataChannels, dataChannelConnection, type DataChannels } from './webrtc.js';

const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
const send = (connection: Connection, message: unknown): void =>
  connection.send(encoder.encode(JSON.stringify(message)), 'reliable');

/** Options of {@link SignalServer}. */
export interface SignalServerOptions {
  /** Most rooms at once (default 1,024); a join that would make one more is refused. */
  maxRooms?: number;
  /** Most peers in a room (default 16); the next join is refused. */
  maxPeers?: number;
  /** Largest message in bytes (default 65,536, room for a long offer); bigger closes with `CloseCode.rateLimit`. */
  maxMessageBytes?: number;
  /** Messages a second a peer may send on average (default 100); past that it closes with `CloseCode.rateLimit`. */
  messagesPerSecond?: number;
  /** Messages a peer may send at once (default 200): the burst of candidates at the start of a call. */
  burst?: number;
  /** Milliseconds a connection has to send its join (default 10,000), or it closes with `CloseCode.timeout`. */
  joinTimeout?: number;
  /** Return false to refuse a join; `token` is what the client passed. Default: anyone with the room's name joins. */
  authorize?(room: string, token: string | undefined): boolean | Promise<boolean>;
  /** The clock in milliseconds (default `performance.now`). */
  now?: () => number;
}

interface Member {
  id: number;
  room: string;
  connection: Connection;
  tokens: number;
  refilled: number;
}

const count = (what: string, v: number): number => {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`SignalServer ${what} is ${v}; pass an integer above 0`);
  return v;
};

/**
 * Passes messages between the peers of a room. It sees only what peers choose to send through it, keeps no history,
 * and says who sent each message itself, so a peer cannot pose as another.
 *
 * @example
 * ```ts
 * const signals = new SignalServer();
 * const listener = await listenWebSocket({ port: 8788 });
 * listener.onconnection = (connection) => signals.accept(connection);
 * ```
 */
export class SignalServer {
  private readonly rooms = new Map<string, Map<number, Member>>();
  private readonly waiting = new Set<Connection>();
  private readonly maxRooms: number;
  private readonly maxPeers: number;
  private readonly maxBytes: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly joinTimeout: number;
  private readonly now: () => number;
  private nextId = 1;
  private closed = false;

  /** @throws RangeError for an option out of range. */
  constructor(private readonly options: SignalServerOptions = {}) {
    this.maxRooms = count('maxRooms', options.maxRooms ?? 1024);
    this.maxPeers = count('maxPeers', options.maxPeers ?? 16);
    this.maxBytes = count('maxMessageBytes', options.maxMessageBytes ?? 65536);
    this.rate = count('messagesPerSecond', options.messagesPerSecond ?? 100);
    this.burst = count('burst', options.burst ?? 200);
    this.joinTimeout = count('joinTimeout', options.joinTimeout ?? 10_000);
    this.now = options.now ?? (() => performance.now());
  }

  /** How many rooms hold a peer. */
  get roomCount(): number {
    return this.rooms.size;
  }
  /** How many peers are in `room`. */
  peers(room: string): number {
    return this.rooms.get(room)?.size ?? 0;
  }

  /**
   * Takes a new connection: it has `joinTimeout` to join a room.
   * @throws MargoError `disposed` once the server is closed.
   */
  accept(connection: Connection): void {
    if (this.closed) throw fault('disposed', 'SignalServer is closed; create a new SignalServer');
    this.waiting.add(connection);
    const timer = setTimeout(() => connection.close(CloseCode.timeout, 'no join in time'), this.joinTimeout);
    (timer as { unref?(): void }).unref?.();
    connection.onclose = () => {
      clearTimeout(timer);
      this.waiting.delete(connection);
    };
    connection.onmessage = (data) => {
      connection.onmessage = null;
      clearTimeout(timer);
      this.waiting.delete(connection);
      const message = this.parse(connection, data);
      if (message) void this.join(connection, message);
    };
  }

  private parse(connection: Connection, data: Uint8Array): Record<string, unknown> | undefined {
    if (data.length > this.maxBytes) {
      connection.close(CloseCode.rateLimit, `message over ${this.maxBytes} bytes (maxMessageBytes)`);
      return undefined;
    }
    let message: unknown;
    try {
      message = JSON.parse(decoder.decode(data));
    } catch {
      connection.close(CloseCode.protocol, 'not JSON text');
      return undefined;
    }
    if (message === null || typeof message !== 'object') {
      connection.close(CloseCode.protocol, 'not a signal message');
      return undefined;
    }
    return message as Record<string, unknown>;
  }

  private async join(connection: Connection, message: Record<string, unknown>): Promise<void> {
    const { kind, room, token } = message;
    if (kind !== 'join' || typeof room !== 'string' || !room || room.length > 128)
      return connection.close(CloseCode.protocol, 'join first, with a room name of 1 to 128 characters');
    const allowed = (await this.options.authorize?.(room, token as string | undefined)) ?? true;
    if (!connection.open || this.closed) return;
    if (!allowed) return this.refuse(connection, 'not allowed in this room');
    const peers = this.rooms.get(room);
    if (!peers && this.rooms.size >= this.maxRooms) return this.refuse(connection, 'the server holds its most rooms');
    if (peers && peers.size >= this.maxPeers) return this.refuse(connection, 'the room is full');
    const members = peers ?? new Map<number, Member>(),
      member: Member = { id: this.nextId++, room, connection, tokens: this.burst, refilled: this.now() };
    this.rooms.set(room, members);
    send(connection, { kind: 'joined', id: member.id, peers: [...members.keys()] });
    for (const other of members.values()) send(other.connection, { kind: 'peer', id: member.id });
    members.set(member.id, member);
    connection.onmessage = (data) => this.receive(member, data);
    connection.onclose = () => this.leave(member);
  }

  private refuse(connection: Connection, reason: string): void {
    send(connection, { kind: 'refused', reason });
    connection.close(CloseCode.normal, 'refused');
  }

  private leave(member: Member): void {
    const members = this.rooms.get(member.room);
    if (!members?.delete(member.id)) return;
    if (!members.size) this.rooms.delete(member.room);
    for (const other of members.values()) send(other.connection, { kind: 'left', id: member.id });
  }

  private receive(member: Member, data: Uint8Array): void {
    const now = this.now(),
      connection = member.connection;
    member.tokens = Math.min(this.burst, member.tokens + ((now - member.refilled) * this.rate) / 1000);
    member.refilled = now;
    if (member.tokens < 1) return connection.close(CloseCode.rateLimit, 'too many messages');
    member.tokens--;
    const message = this.parse(connection, data);
    if (!message) return;
    if (message.kind !== 'signal' || !Number.isInteger(message.to))
      return connection.close(CloseCode.protocol, 'expected a signal message');
    // A peer that has just left, or is in another room, is not an error: it simply gets nothing.
    const target = this.rooms.get(member.room)?.get(message.to as number);
    if (target) send(target.connection, { kind: 'signal', from: member.id, data: message.data });
  }

  /** Closes every connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connection of [...this.waiting]) connection.close(CloseCode.removed, 'server closed');
    for (const members of [...this.rooms.values()])
      for (const member of [...members.values()]) member.connection.close(CloseCode.removed, 'server closed');
  }
  /** Same as {@link SignalServer.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/** Options of {@link SignalClient.join}. */
export interface SignalJoinOptions {
  /** What the server's `authorize` gets. */
  token?: string;
  /** Aborts the join (it rejects with the signal's reason and closes the connection). */
  signal?: AbortSignal;
}

/** One peer's place in a room of a {@link SignalServer}. */
export class SignalClient {
  /** Called when a peer joins the room after this one. */
  onpeer: ((id: number) => void) | null = null;
  /** Called when a peer leaves the room. */
  onleft: ((id: number) => void) | null = null;
  /** Called with what a peer sent this one. It comes from another peer: check it before use. */
  onsignal: ((from: number, data: unknown) => void) | null = null;
  /** Called once when the connection to the server closes. */
  onclose: ((code: number, reason: string) => void) | null = null;
  /** The peers in the room now, this one aside. */
  readonly peers = new Set<number>();

  private constructor(
    private readonly connection: Connection,
    /** This peer's id in the room, given by the server. */
    readonly id: number,
    peers: readonly number[],
  ) {
    for (const peer of peers) this.peers.add(peer);
    connection.onmessage = (data) => this.receive(data);
    connection.onclose = (code, reason) => this.onclose?.(code, reason);
  }

  /**
   * Joins `room` over `connection` to a {@link SignalServer}.
   * @throws MargoError `failed` (as a rejection) when the server refuses or the connection closes first; the signal's
   * reason when `signal` aborts.
   */
  static join(connection: Connection, room: string, { token, signal }: SignalJoinOptions = {}): Promise<SignalClient> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        connection.close(CloseCode.normal, 'aborted');
        return reject(signal.reason);
      }
      // A closed connection never calls onclose again, so waiting for it would wait for ever.
      if (!connection.open) return reject(fault('failed', 'Signal connection is closed; open a new one and join'));
      const abort = () => {
        connection.onclose = null;
        connection.close(CloseCode.normal, 'aborted');
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      connection.onclose = (code, reason) => {
        signal?.removeEventListener('abort', abort);
        reject(fault('failed', `Signal connection closed before joining (${code} ${reason}); check the server`));
      };
      connection.onmessage = (data) => {
        const message = JSON.parse(decoder.decode(data));
        signal?.removeEventListener('abort', abort);
        if (message.kind === 'joined') return resolve(new SignalClient(connection, message.id, message.peers));
        connection.onclose = null;
        reject(fault('failed', `Signal join refused: ${message.reason}; check the room name and token`));
      };
      send(connection, { kind: 'join', room, token });
    });
  }

  private receive(bytes: Uint8Array): void {
    const message = JSON.parse(decoder.decode(bytes));
    if (message.kind === 'peer') {
      this.peers.add(message.id);
      this.onpeer?.(message.id);
    } else if (message.kind === 'left') {
      this.peers.delete(message.id);
      this.onleft?.(message.id);
    } else if (message.kind === 'signal') this.onsignal?.(message.from, message.data);
  }

  /** Sends `data` (any JSON value) to peer `to`, through the server. */
  send(to: number, data: unknown): void {
    send(this.connection, { kind: 'signal', to, data });
  }

  /** Leaves the room. */
  close(): void {
    this.connection.close(CloseCode.normal, 'left');
  }
  /** Same as {@link SignalClient.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/** Options of {@link PeerMesh}. */
export interface PeerMeshOptions {
  /** The peer connection's settings; put your STUN and TURN servers in `iceServers` (default none: same network only). */
  configuration?: RTCConfiguration;
  /** The RTCPeerConnection class (default the global one, in a browser). */
  RTCPeerConnection?: typeof RTCPeerConnection;
  /** Called with each peer's connection once its data channels are open. */
  onconnection?(peer: number, connection: Connection): void;
  /** Called when a peer's link could not be made or failed, or a peer sent something that is not a description or candidate. */
  onerror?(peer: number, error: unknown): void;
}

interface Link {
  peer: RTCPeerConnection;
  channels: DataChannels;
  /** One step at a time per peer: an answer or candidate must not overtake the description before it. */
  queue: Promise<void>;
  /** Candidates found before the description went out: a candidate must not reach the other end ahead of it. */
  held: RTCIceCandidateInit[] | null;
}

/**
 * A WebRTC link to every peer of a room: joining peers offer to those already there, so two peers never offer to each
 * other. Each link is two data channels (`@margoengine/netcode/webrtc`) wrapped as a `Connection`, ready for
 * `GameClient`, `GameServer` or `RollbackSession`.
 *
 * @example
 * ```ts
 * const room = await SignalClient.join(await openWebSocket('wss://game.example.com/signal'), 'lobby-7');
 * const mesh = new PeerMesh(room, {
 *   configuration: { iceServers: [{ urls: 'stun:stun.example.com' }] },
 *   onconnection: (peer, connection) => connection.send(new Uint8Array([1])),
 * });
 * ```
 */
export class PeerMesh {
  /** The open connection of each peer. */
  readonly connections = new Map<number, Connection>();
  private readonly links = new Map<number, Link>();
  private readonly Peer: typeof RTCPeerConnection;
  private closed = false;

  /** @throws MargoError `unsupported` when there is no RTCPeerConnection here. */
  constructor(
    private readonly client: SignalClient,
    private readonly options: PeerMeshOptions = {},
  ) {
    const Peer = options.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    if (!Peer) throw fault('unsupported', 'PeerMesh needs RTCPeerConnection; run it in a browser or pass the class');
    this.Peer = Peer;
    client.onsignal = (from, data) => this.signal(from, data);
    // A link that is up does not need the room: it ends when its channels close, not when the signalling goes.
    client.onleft = (id) => {
      if (!this.connections.has(id)) this.drop(id);
    };
    for (const id of client.peers) this.offer(id);
  }

  private report(id: number, error: unknown): void {
    this.options.onerror?.(id, error);
  }

  private link(id: number): Link {
    const known = this.links.get(id);
    if (known) return known;
    const peer = new this.Peer(this.options.configuration),
      channels = createDataChannels(peer),
      link: Link = { peer, channels, queue: Promise.resolve(), held: [] };
    this.links.set(id, link);
    peer.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (link.held) link.held.push(candidate);
      else this.client.send(id, { candidate });
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState !== 'failed') return;
      this.report(id, fault('failed', `The link to peer ${id} failed; check the STUN and TURN servers`));
      this.drop(id);
    });
    channels.reliable.addEventListener(
      'open',
      () => {
        const connection = dataChannelConnection(channels);
        this.connections.set(id, connection);
        this.options.onconnection?.(id, connection);
      },
      { once: true },
    );
    channels.reliable.addEventListener('close', () => this.drop(id), { once: true });
    return link;
  }

  private step(id: number, link: Link, run: () => Promise<void>): void {
    link.queue = link.queue.then(run).catch((error) => this.report(id, error));
  }

  /** Sets and sends this end's description, then the candidates that waited for it. */
  private async describe(id: number, link: Link): Promise<void> {
    await link.peer.setLocalDescription();
    this.client.send(id, { description: link.peer.localDescription });
    for (const candidate of link.held ?? []) this.client.send(id, { candidate });
    link.held = null;
  }

  private offer(id: number): void {
    const link = this.link(id);
    this.step(id, link, () => this.describe(id, link));
  }

  private signal(from: number, data: unknown): void {
    const { description, candidate } = (data ?? {}) as {
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    if (this.closed) return;
    if (description === undefined && candidate === undefined)
      return this.report(from, new TypeError('A peer sent neither a description nor a candidate'));
    const link = this.link(from);
    this.step(from, link, async () => {
      if (candidate !== undefined) return link.peer.addIceCandidate(candidate);
      await link.peer.setRemoteDescription(description as RTCSessionDescriptionInit);
      if (description?.type === 'offer') await this.describe(from, link);
    });
  }

  private drop(id: number): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    const connection = this.connections.get(id);
    this.connections.delete(id);
    connection?.close(CloseCode.normal, 'peer left');
    link.peer.close();
  }

  /** Closes every link. The room stays joined; close the {@link SignalClient} to leave it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.links.keys()]) this.drop(id);
  }
  /** Same as {@link PeerMesh.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}
