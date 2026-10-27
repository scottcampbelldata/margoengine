// An in-memory network with a virtual clock and seeded, repeatable bad conditions: latency, jitter, loss,
// duplication and reordering. Tests and demos drive it with `advance(ms)`; nothing happens between calls.
import { createRandom } from '@margoengine/math/mathutils';
import type { Delivery, Connection, Listener } from './transport.js';

/** Conditions of one direction of a loopback link. Every value is checked when the network is made. */
export interface LinkConditions {
  /** One-way delay in milliseconds (default 0). */
  latency?: number;
  /** Extra random delay per message, uniform from 0 to `jitter` milliseconds (default 0). */
  jitter?: number;
  /** Chance from 0 to 1 that an unreliable message is lost (default 0). A lost reliable message is resent. */
  loss?: number;
  /** Chance from 0 to 1 that an unreliable message arrives twice (default 0). */
  duplicate?: number;
  /** Chance from 0 to 1 that an unreliable message is held back by up to two latencies more (default 0). */
  reorder?: number;
}

/** Options of {@link LoopbackNetwork}. */
export interface LoopbackOptions extends LinkConditions {
  /** Seed of the random stream: the same seed and calls give the same deliveries (default 1). */
  seed?: number;
  /** Time in milliseconds a lost reliable message waits before it is resent (default 2 x latency + 10). */
  retransmit?: number;
}

/** Counts since the network was made. */
export interface LoopbackStats {
  /** Messages handed to `send`. */
  sent: number;
  /** Messages delivered (duplicates count twice). */
  delivered: number;
  /** Unreliable messages dropped. */
  lost: number;
  /** Extra copies delivered. */
  duplicated: number;
  /** Reliable messages resent after a simulated loss. */
  resent: number;
  /** Bytes handed to `send`. */
  bytes: number;
}

interface Packet {
  at: number;
  order: number;
  run: () => void;
}

const checked = (name: string, value: number | undefined, fallback: number, max: number): number => {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max)
    throw new RangeError(`Loopback ${name} is ${v}; pass a number from 0 to ${max}`);
  return v;
};

interface Link {
  latency: number;
  jitter: number;
  loss: number;
  duplicate: number;
  reorder: number;
  retransmit: number;
}

const link = (options: LinkConditions & { retransmit?: number }, base?: Link): Link => {
  const latency = checked('latency', options.latency, base?.latency ?? 0, 60_000);
  return {
    latency,
    jitter: checked('jitter', options.jitter, base?.jitter ?? 0, 60_000),
    loss: checked('loss', options.loss, base?.loss ?? 0, 0.99),
    duplicate: checked('duplicate', options.duplicate, base?.duplicate ?? 0, 1),
    reorder: checked('reorder', options.reorder, base?.reorder ?? 0, 1),
    retransmit: checked('retransmit', options.retransmit, base?.retransmit ?? 2 * latency + 10, 60_000),
  };
};

/**
 * An in-memory network with a virtual clock. `listen()` gives the server end, `connect()` a client connection whose
 * server half arrives through the listener's `onconnection` at once. Messages are delivered only inside
 * {@link LoopbackNetwork.advance}, in time order, so a test is repeatable from its seed.
 *
 * @example
 * ```ts
 * const network = new LoopbackNetwork({ latency: 50, jitter: 10, loss: 0.05, seed: 7 });
 * const listener = network.listen();
 * listener.onconnection = (server) => (server.onmessage = (data) => server.send(data));
 * const client = network.connect();
 * client.onmessage = (data) => console.log('echo', data);
 * client.send(new Uint8Array([1, 2, 3]), 'unreliable');
 * network.advance(200);
 * ```
 */
export class LoopbackNetwork {
  /** The virtual time in milliseconds; starts at 0 and moves only in {@link LoopbackNetwork.advance}. */
  time = 0;
  /** Delivery counts. */
  readonly stats: LoopbackStats = { sent: 0, delivered: 0, lost: 0, duplicated: 0, resent: 0, bytes: 0 };
  private readonly random: () => number;
  private readonly conditions: Link;
  private readonly queue: Packet[] = [];
  private order = 0;
  private listener: (Listener & { closed: boolean }) | null = null;

  /** @throws RangeError for a condition out of range (latency and jitter 0 to 60,000 ms, loss 0 to 0.99). */
  constructor(options: LoopbackOptions = {}) {
    this.conditions = link(options);
    this.random = createRandom(options.seed ?? 1);
  }

  /** The server end. One listener per network; listening again replaces it. */
  listen(): Listener {
    const listener = {
      closed: false,
      onconnection: null as ((connection: Connection) => void) | null,
      close() {
        listener.closed = true;
      },
    };
    this.listener = listener;
    return listener;
  }

  /**
   * A new client connection, open at once; its server half goes to the listener's `onconnection` now. `conditions`
   * override the network's for this link (both directions).
   * @throws RangeError for a condition out of range.
   */
  connect(conditions: LinkConditions = {}): Connection {
    const conditionsOfLink = link(conditions, this.conditions),
      client = new LoopbackEnd(this, conditionsOfLink),
      server = new LoopbackEnd(this, conditionsOfLink);
    client.peer = server;
    server.peer = client;
    const listener = this.listener;
    if (!listener || listener.closed) this.schedule(this.time, () => client.close(1006, 'no loopback listener'));
    else listener.onconnection?.(server);
    return client;
  }

  /**
   * Two connected ends without a listener, for peer-to-peer sessions (one pair per two peers). `conditions` override
   * the network's for this link (both directions).
   * @throws RangeError for a condition out of range.
   */
  pair(conditions: LinkConditions = {}): [Connection, Connection] {
    const conditionsOfLink = link(conditions, this.conditions),
      a = new LoopbackEnd(this, conditionsOfLink),
      b = new LoopbackEnd(this, conditionsOfLink);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  /**
   * Moves the clock forward by `ms` and delivers, in time order, every message due by then (and any message those
   * deliveries send that is also due).
   * @throws RangeError for a negative or non-finite `ms`.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Loopback advance(${ms}); pass a finite ms of 0 or more`);
    const end = this.time + ms;
    for (;;) {
      const next = this.next(end);
      if (!next) break;
      this.time = Math.max(this.time, next.at);
      next.run();
    }
    this.time = end;
  }

  /** Delivers everything queued, moving the clock to the last delivery. */
  flush(): void {
    while (this.queue.length) this.advance(Math.max(0, Math.max(...this.queue.map((p) => p.at)) - this.time));
  }

  private next(end: number): Packet | undefined {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const p = this.queue[i];
      if (p.at > end) continue;
      if (best < 0 || p.at < this.queue[best].at || (p.at === this.queue[best].at && p.order < this.queue[best].order))
        best = i;
    }
    return best < 0 ? undefined : this.queue.splice(best, 1)[0];
  }

  /** @internal Schedules `run` at virtual time `at`. */
  schedule(at: number, run: () => void): void {
    this.queue.push({ at, order: this.order++, run });
  }

  /** @internal The seeded random stream. */
  roll(): number {
    return this.random();
  }
}

class LoopbackEnd implements Connection {
  open = true;
  onmessage: ((data: Uint8Array, channel: Delivery) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  peer!: LoopbackEnd;
  /** The time the last reliable message arrives at the peer: reliable messages never overtake each other. */
  private reliableAt = 0;
  constructor(
    private readonly network: LoopbackNetwork,
    private readonly link: Link,
  ) {}

  send(data: Uint8Array, channel: Delivery = 'reliable'): void {
    if (!this.open) return;
    if (!(data instanceof Uint8Array)) throw new TypeError('Loopback send needs a Uint8Array; pass the message bytes');
    const net = this.network,
      link = this.link,
      stats = net.stats,
      copy = data.slice(),
      delay = () => link.latency + link.jitter * net.roll();
    stats.sent++;
    stats.bytes += data.length;
    const deliver = (at: number) =>
      net.schedule(at, () => {
        if (!this.peer.open) return;
        stats.delivered++;
        this.peer.onmessage?.(copy, channel);
      });
    if (channel === 'reliable') {
      let at = net.time + delay();
      while (net.roll() < link.loss) {
        stats.resent++;
        at += link.retransmit;
      }
      this.reliableAt = Math.max(this.reliableAt, at);
      deliver(this.reliableAt);
      return;
    }
    if (net.roll() < link.loss) {
      stats.lost++;
      return;
    }
    let at = net.time + delay();
    if (net.roll() < link.reorder) at += 2 * (link.latency + 1) * net.roll();
    deliver(at);
    if (net.roll() < link.duplicate) {
      stats.duplicated++;
      deliver(net.time + delay());
    }
  }

  close(code = 1000, reason = ''): void {
    if (!this.open) return;
    this.open = false;
    const peer = this.peer;
    this.onclose?.(code, reason);
    // The peer hears it after the reliable messages already on their way.
    this.network.schedule(Math.max(this.network.time + this.link.latency, this.reliableAt), () => {
      if (!peer.open) return;
      peer.open = false;
      peer.onclose?.(code, reason);
    });
  }
}
