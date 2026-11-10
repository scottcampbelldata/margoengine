import { defineSchema, type SchemaCodec, type SchemaShape, type UntypedSchema } from './schema.js';
import { CloseCode, fault, type Connection, type Delivery } from './transport.js';

const PREFIX = 112;
const control = defineSchema({
  types: {
    Snapshot: { sequence: 'uint', frame: 'uint', bytes: { type: 'bytes', maxLength: 2 ** 24 } },
    Packet: {
      kind: 'u8',
      epoch: 'uint',
      hash: 'u32',
      host: 'uint',
      snapshot: 'Snapshot',
      previous: { type: 'optional', of: 'Snapshot' },
      members: { type: 'array', of: 'uint', maxLength: 64 },
    },
  },
});
const PREPARE = 1,
  ACK = 2,
  COMMIT = 3,
  STORED = 4,
  STATUS = 5,
  RESUME = 6,
  RESUMED = 7,
  TRANSFER = 8,
  TRANSFERRED = 9,
  ACTIVATE = 10;
interface Snapshot {
  sequence: number;
  frame: number;
  bytes: Uint8Array;
}
interface Packet {
  kind: number;
  epoch: number;
  hash: number;
  host: number;
  snapshot: Snapshot;
  previous?: Snapshot;
  members: number[];
}
interface Pending {
  packet: Packet;
  stage: number;
  acks: Set<number>;
  resolve(): void;
  reject(error: unknown): void;
}
interface Link {
  connection: Connection;
  beforeMessage: Connection['onmessage'];
  beforeClose: Connection['onclose'];
  message(data: Uint8Array, channel: Delivery): void;
  close(code: number, reason: string): void;
}
/** A detached confirmed checkpoint and authority epoch. */
export interface MigrationState<State> {
  /** Elected peer id. */
  host: number;
  /** Authority generation, incremented on handoff/recovery. */
  epoch: number;
  /** Confirmed simulation frame to resume. */
  frame: number;
  /** Canonical decoded state; changing it never changes the saved checkpoint. */
  state: State;
}
/** Configuration of one peer in a trusted full mesh. */
export interface HostMigrationOptions<State> {
  /** Shared state schema. */
  schema: SchemaCodec<SchemaShape> | UntypedSchema;
  /** Name of the state struct. */
  stateType: string;
  /** Local unsigned player id. */
  local: number;
  /** Open reliable links to every other peer; this session owns and closes them. */
  peers: ReadonlyMap<number, Connection>;
  /** Initial host, default lowest player id. Same on all peers. */
  host?: number;
  /** Common starting state. */
  initial: State;
  /** Starting frame, default 0. */
  frame?: number;
  /** Confirmation, transfer, recovery and wait timeout in milliseconds, default 10000. */
  timeout?: number;
  /** Maximum encoded checkpoint bytes, default 1048576, at most 16777216. */
  maxSnapshotBytes?: number;
  /** Recovery failures, default console.error. Public operations also reject their promises. */
  onerror?(error: unknown): void;
}
const whole = (n: number, max = 2 ** 32 - 1): boolean => Number.isInteger(n) && n >= 0 && n <= max;
const equal = (a: Snapshot, b: Snapshot): boolean =>
  a.sequence === b.sequence &&
  a.frame === b.frame &&
  a.bytes.length === b.bytes.length &&
  a.bytes.every((v, i) => v === b.bytes[i]);
const rosterEqual = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * P2P authority migration from replicated confirmed state. Serial checkpoints are prepared and committed on every
 * connected peer. Recovery chooses the newest checkpoint common to the surviving mesh, then resumes the lowest id.
 * Requires trusted peers and a connected full mesh, not arbitrary network partitions or Byzantine consensus.
 */
export class HostMigration<State> {
  private readonly schema: UntypedSchema;
  private readonly links = new Map<number, Link>();
  private readonly timeout: number;
  private readonly maxBytes: number;
  private history: Snapshot[];
  private prepared: Snapshot | undefined;
  private hostId: number | undefined;
  private epochNumber = 0;
  private ready = true;
  private closed = false;
  private pending: Pending | undefined;
  private reports = new Map<number, Packet>();
  private future = new Map<number, Packet>();
  private resuming: Set<number> | undefined;
  private transferFrom: number | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters = new Set<{ resolve(value: MigrationState<State>): void; reject(error: unknown): void }>();

  /** @throws TypeError/RangeError for inconsistent roster, invalid limits or a state the schema cannot encode. */
  constructor(private readonly options: HostMigrationOptions<State>) {
    const ids = [options.local, ...options.peers.keys()].sort((a, b) => a - b);
    if (
      ids.length > 64 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !whole(id)) ||
      [...options.peers.values()].some((c) => !c.open)
    )
      throw new TypeError(
        'Migration needs 1..64 unique unsigned ids and open full-mesh links; pass the same roster to every peer',
      );
    this.hostId = options.host ?? ids[0];
    if (!ids.includes(this.hostId))
      throw new TypeError('Migration host is outside the roster; choose an existing peer');
    this.timeout = options.timeout ?? 10_000;
    this.maxBytes = options.maxSnapshotBytes ?? 1_048_576;
    if (!whole(this.timeout, 2_147_483_647) || this.timeout < 1 || !whole(this.maxBytes, 2 ** 24) || this.maxBytes < 1)
      throw new RangeError(
        'Migration timeout/byte limit is outside range; use positive integers within the documented limits',
      );
    const frame = options.frame ?? 0;
    if (!whole(frame)) throw new RangeError('Migration frame must be an unsigned integer; pass a simulation frame');
    this.schema = options.schema as UntypedSchema;
    this.history = [{ sequence: 0, frame, bytes: this.encode(options.initial) }];
    for (const [id, connection] of options.peers) {
      const link: Link = {
        connection,
        beforeMessage: connection.onmessage,
        beforeClose: connection.onclose,
        message: (data, channel) => {
          if (data[0] !== PREFIX) return link.beforeMessage?.(data, channel);
          try {
            if (data.length > 2 * this.maxBytes + 1024)
              throw new RangeError('Migration packet exceeds limit; reduce snapshot bytes');
            this.receive(id, control.decode('Packet', data.subarray(1)) as Packet);
          } catch (error) {
            if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
            connection.close(CloseCode.protocol, 'invalid migration packet');
          }
        },
        close: (code, reason) => {
          try {
            link.beforeClose?.(code, reason);
          } finally {
            this.lost(id);
          }
        },
      };
      this.links.set(id, link);
      connection.onmessage = link.message;
      connection.onclose = link.close;
    }
  }
  /** Current host; undefined during crash recovery. */
  get host(): number | undefined {
    return this.hostId;
  }
  /** Only a ready local authority may simulate or publish new confirmed state. */
  get isHost(): boolean {
    return !this.closed && this.ready && this.hostId === this.options.local;
  }
  /** Current authority generation. */
  get epoch(): number {
    return this.epochNumber;
  }
  /** A fresh decoded copy of the latest locally committed checkpoint. */
  get confirmed(): { frame: number; state: State } {
    const s = this.current;
    return { frame: s.frame, state: this.schema.decode(this.options.stateType, s.bytes) as State };
  }
  private get current(): Snapshot {
    return this.history[this.history.length - 1];
  }
  private members(): number[] {
    return [this.options.local, ...[...this.links].filter(([, l]) => l.connection.open).map(([id]) => id)].sort(
      (a, b) => a - b,
    );
  }
  private encode(state: State): Uint8Array {
    const bytes = this.schema.encode(this.options.stateType, state);
    if (bytes.length > this.maxBytes)
      throw new RangeError('Migration checkpoint exceeds maxSnapshotBytes; reduce state or raise the limit');
    return bytes;
  }
  private packet(kind: number, snapshot = this.current, host = this.hostId ?? this.members()[0]): Packet {
    return {
      kind,
      epoch: this.epochNumber,
      hash: this.schema.hash,
      host,
      snapshot,
      previous: this.history.at(-2),
      members: this.members(),
    };
  }
  private send(id: number, packet: Packet): void {
    const bytes = control.encode('Packet', packet),
      framed = new Uint8Array(bytes.length + 1);
    framed[0] = PREFIX;
    framed.set(bytes, 1);
    this.links.get(id)?.connection.send(framed, 'reliable');
  }
  private broadcast(packet: Packet): void {
    for (const [id, link] of this.links) if (link.connection.open) this.send(id, packet);
  }
  private save(snapshot: Snapshot): void {
    this.history = [...this.history.filter((s) => s.sequence < snapshot.sequence), snapshot].slice(-2);
  }
  private authority(): void {
    if (!this.isHost)
      throw fault('failed', 'Only a ready host may publish or transfer authority; await waitForHost and check isHost');
    if (this.pending) throw fault('failed', 'A migration operation is pending; await it before starting another');
  }
  /**
   * Replicate a canonical checkpoint to every connected peer. Resolves after every peer stored its commit.
   * Abort/timeout retires this session and closes its links, preventing reuse of an uncertain checkpoint.
   * @throws MargoError `failed` outside host authority; RangeError for a frame that does not advance.
   */
  confirm(state: State, frame: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    this.authority();
    if (!whole(frame) || frame <= this.current.frame || this.current.sequence === 2 ** 32 - 1)
      throw new RangeError('Confirmation must advance an unsigned frame/sequence; start a new session before overflow');
    const snapshot = { sequence: this.current.sequence + 1, frame, bytes: this.encode(state) };
    return this.operation(this.packet(PREPARE, snapshot), PREPARE, options.signal);
  }
  /** Transfer authority to any connected peer without leaving. Resolves once every peer accepted the handoff. */
  handoff(target: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    this.authority();
    if (target === this.options.local || !this.links.get(target)?.connection.open)
      throw new RangeError('Handoff target must be another connected peer; choose an id from the mesh');
    if (this.epochNumber === 2 ** 32 - 1) throw new RangeError('Migration epoch exhausted; create a new session');
    this.epochNumber++;
    this.ready = false;
    return this.operation(this.packet(TRANSFER, this.current, target), TRANSFER, options.signal);
  }
  private operation(packet: Packet, stage: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        const reason = signal?.reason ?? fault('failed', 'Migration operation timed out; reconnect a fresh session');
        this.pending = undefined;
        finish();
        reject(reason);
        this.close();
      };
      const timer = setTimeout(abort, this.timeout);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending = {
        packet,
        stage,
        acks: new Set([this.options.local]),
        resolve: () => {
          finish();
          resolve();
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      this.broadcast(packet);
      this.progress();
    });
  }
  private progress(): void {
    const pending = this.pending;
    if (!pending || !this.members().every((id) => pending.acks.has(id))) return;
    if (pending.stage === PREPARE) {
      this.save(pending.packet.snapshot);
      pending.stage = COMMIT;
      pending.acks = new Set([this.options.local]);
      this.broadcast({ ...pending.packet, kind: COMMIT });
      this.progress();
    } else {
      this.pending = undefined;
      if (pending.stage === TRANSFER) {
        this.hostId = pending.packet.host;
        this.ready = true;
        this.broadcast({ ...pending.packet, kind: ACTIVATE });
        this.notify();
      }
      pending.resolve();
    }
  }
  private validate(packet: Packet): void {
    if (packet.hash !== this.schema.hash || packet.kind < PREPARE || packet.kind > ACTIVATE)
      throw new RangeError('Migration protocol/schema mismatch; use matching peers');
    for (const snapshot of [packet.snapshot, packet.previous])
      if (snapshot) {
        if (snapshot.bytes.length > this.maxBytes)
          throw new RangeError('Migration snapshot too large; respect maxSnapshotBytes');
        this.schema.decode(this.options.stateType, snapshot.bytes);
      }
  }
  private receive(from: number, packet: Packet): void {
    if (this.closed || !this.links.get(from)?.connection.open) return;
    this.validate(packet);
    if (packet.kind === STATUS && packet.epoch === this.epochNumber + 1 && this.hostId !== undefined) {
      this.future.set(from, packet);
      if (from === this.hostId) this.beginRecovery(packet.epoch);
      return;
    }
    if (
      packet.kind === TRANSFER &&
      from === this.hostId &&
      packet.epoch === this.epochNumber + 1 &&
      packet.members.includes(packet.host) &&
      rosterEqual(packet.members, this.members())
    ) {
      if (!equal(this.current, packet.snapshot))
        throw new RangeError('Handoff checkpoint differs; finish confirmation before transferring');
      this.epochNumber = packet.epoch;
      this.transferFrom = from;
      this.hostId = packet.host;
      this.ready = false;
      this.send(from, { ...packet, kind: TRANSFERRED });
      return;
    }
    if (packet.kind === STATUS && this.hostId === undefined && packet.epoch > this.epochNumber) {
      // A survivor that saw more departures during this recovery is already in a later round; join it, or the two
      // peers drop each other's reports forever and the recovery barrier never completes.
      this.future.set(from, packet);
      this.beginRecovery(packet.epoch);
      return;
    }
    if (packet.epoch !== this.epochNumber) return;
    const pending = this.pending;
    if (
      pending &&
      equal(packet.snapshot, pending.packet.snapshot) &&
      ((pending.stage === PREPARE && packet.kind === ACK) ||
        (pending.stage === COMMIT && packet.kind === STORED) ||
        (pending.stage === TRANSFER && packet.kind === TRANSFERRED))
    ) {
      pending.acks.add(from);
      this.progress();
      return;
    }
    if (packet.kind === ACTIVATE && from === this.transferFrom && packet.host === this.hostId) {
      this.transferFrom = undefined;
      this.ready = true;
      this.notify();
      return;
    }
    if (
      packet.kind === PREPARE &&
      from === this.hostId &&
      packet.snapshot.sequence === this.current.sequence + 1 &&
      packet.snapshot.frame > this.current.frame
    ) {
      if (this.transferFrom !== undefined) {
        this.transferFrom = undefined;
        this.ready = true;
        this.notify();
      }
      this.prepared = packet.snapshot;
      this.send(from, { ...packet, kind: ACK });
      return;
    }
    if (packet.kind === COMMIT && from === this.hostId && this.prepared && equal(this.prepared, packet.snapshot)) {
      this.save(packet.snapshot);
      this.prepared = undefined;
      this.send(from, { ...packet, kind: STORED });
      return;
    }
    if (packet.kind === STATUS && this.hostId === undefined && rosterEqual(packet.members, this.members())) {
      this.reports.set(from, packet);
      this.recover();
      return;
    }
    if (
      packet.kind === RESUME &&
      from === this.members()[0] &&
      this.hostId === undefined &&
      rosterEqual(packet.members, this.members())
    ) {
      if (!this.history.some((s) => equal(s, packet.snapshot)))
        throw new RangeError('Recovery checkpoint is not locally confirmed; reconnect a matching session');
      this.save(packet.snapshot);
      this.hostId = from;
      this.ready = true;
      this.clearRecovery();
      this.send(from, { ...packet, kind: RESUMED });
      this.notify();
      return;
    }
    if (packet.kind === RESUMED && this.resuming && equal(packet.snapshot, this.current)) {
      this.resuming.add(from);
      this.completeRecovery();
    }
  }
  private lost(id: number): void {
    if (this.closed) return;
    if (this.pending?.stage === TRANSFER && this.pending.packet.host === id) {
      this.pending.reject(fault('failed', 'Handoff target left; await the recovered host'));
      this.pending = undefined;
      this.beginRecovery();
      return;
    }
    if (id === this.hostId || id === this.transferFrom || this.hostId === undefined) this.beginRecovery();
    else {
      this.progress();
      this.completeRecovery();
    }
  }
  private beginRecovery(epoch?: number): void {
    if (epoch !== undefined) this.epochNumber = epoch;
    else if (this.hostId !== undefined || this.resuming) {
      if (this.epochNumber === 2 ** 32 - 1) return this.close();
      this.epochNumber++;
    }
    this.hostId = undefined;
    this.ready = false;
    this.prepared = undefined;
    this.transferFrom = undefined;
    this.resuming = undefined;
    this.reports.clear();
    const status = this.packet(STATUS);
    this.reports.set(this.options.local, status);
    for (const [id, packet] of this.future)
      if (packet.epoch === this.epochNumber && rosterEqual(packet.members, status.members))
        this.reports.set(id, packet);
    this.future.clear();
    this.clearRecovery();
    this.recoveryTimer = setTimeout(() => {
      const error = fault('failed', 'Host recovery timed out; reconnect the full peer mesh');
      this.close();
      (this.options.onerror ?? console.error)(error);
    }, this.timeout);
    this.broadcast(status);
    this.recover();
  }
  private recover(): void {
    const members = this.members();
    if (
      this.ready ||
      this.hostId !== undefined ||
      this.resuming ||
      members[0] !== this.options.local ||
      !members.every((id) => this.reports.has(id))
    )
      return;
    const reports = members.map((id) => this.reports.get(id) as Packet);
    const sequence = Math.min(...reports.map((r) => r.snapshot.sequence));
    const checkpoint = [reports[0].snapshot, reports[0].previous].find((s) => s?.sequence === sequence);
    if (!checkpoint || reports.some((r) => ![r.snapshot, r.previous].some((s) => s && equal(s, checkpoint)))) {
      const error = fault('failed', 'Survivors have no common confirmed checkpoint; reconnect a matching session');
      this.close();
      (this.options.onerror ?? console.error)(error);
      return;
    }
    this.save(checkpoint);
    this.resuming = new Set([this.options.local]);
    this.broadcast(this.packet(RESUME));
    this.completeRecovery();
  }
  private completeRecovery(): void {
    if (!this.resuming || !this.members().every((id) => this.resuming?.has(id))) return;
    this.hostId = this.options.local;
    this.ready = true;
    this.resuming = undefined;
    this.clearRecovery();
    this.notify();
  }
  private clearRecovery(): void {
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }
  private result(): MigrationState<State> {
    return { host: this.hostId as number, epoch: this.epochNumber, ...this.confirmed };
  }
  private notify(): void {
    if (this.ready && this.hostId !== undefined) {
      for (const waiter of this.waiters) waiter.resolve(this.result());
      this.waiters.clear();
    }
  }
  /** Wait for a ready authority and restored checkpoint. Bounded by timeout and optional AbortSignal. */
  waitForHost(options: { signal?: AbortSignal } = {}): Promise<MigrationState<State>> {
    options.signal?.throwIfAborted();
    if (this.closed) return Promise.reject(fault('disposed', 'Migration session is closed; create a new session'));
    if (this.ready && this.hostId !== undefined) return Promise.resolve(this.result());
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        this.waiters.delete(waiter);
      };
      const abort = () => {
        finish();
        reject(options.signal?.reason ?? fault('failed', 'Waiting for host timed out; reconnect the peer mesh'));
      };
      const timer = setTimeout(abort, this.timeout);
      const waiter = {
        resolve: (value: MigrationState<State>) => {
          finish();
          resolve(value);
        },
        reject: (error: unknown) => {
          finish();
          reject(error);
        },
      };
      this.waiters.add(waiter);
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  /** Leave the mesh, rejecting waits and notifying peers through their connection close events. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.clearRecovery();
    const error = fault('disposed', 'Migration session closed; resume on the elected peer or create a new session');
    this.pending?.reject(error);
    this.pending = undefined;
    for (const waiter of [...this.waiters]) waiter.reject(error);
    this.waiters.clear();
    for (const link of this.links.values()) {
      if (link.connection.onmessage === link.message) link.connection.onmessage = link.beforeMessage;
      if (link.connection.onclose === link.close) link.connection.onclose = link.beforeClose;
      link.connection.close(CloseCode.normal, 'peer left migration session');
    }
  }
  /** Leave, for using. */
  [Symbol.dispose](): void {
    this.close();
  }
}
