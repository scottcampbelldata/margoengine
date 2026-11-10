import { Room, type RoomOptions, type RoomServer } from './rooms.js';
import { fault, type Connection } from './transport.js';

/** Searchable JSON scalars, copied on publication and retrieval. */
export type RoomMetadata = Record<string, string | number | boolean | null>;
/** Public room listing. Tokens and join options are never listed. */
export interface LobbyListing {
  /** Room id accepted by RoomsClient.joinById. */
  roomId: string;
  /** Registered room name. */
  name: string;
  /** Application metadata. */
  metadata: RoomMetadata;
  /** Connected clients. */
  clients: number;
  /** Reserved and reconnecting seats. */
  reserved: number;
  /** Total seat capacity. */
  maxClients: number;
}
/** Exact-match room search; all supplied metadata keys must match. */
export interface LobbyFilter {
  /** Registered room name; omitted means any. */
  name?: string;
  /** Scalar equality filters; omitted means any metadata. */
  metadata?: RoomMetadata;
}
/** One-time bearer credential; send privately over an authenticated encrypted channel. */
export interface SeatReservation {
  /** Room id for joinById. */
  roomId: string;
  /** Pass as the sole join option `seatToken`. */
  seatToken: string;
  /** Unix milliseconds after which the token is invalid. */
  expiresAt: number;
}
type HeldSeat = { options: RoomOptions; expiresAt: number; timer: ReturnType<typeof setTimeout> };

/** Room with metadata, visibility and capacity-safe one-time reservations. Subclass in place of Room. */
export abstract class LobbyRoom<State = unknown> extends Room<State> {
  /** Hide from public listings (default false); explicit id and reservations still work. */
  privateRoom = false;
  private metadataValue: RoomMetadata = {};
  private readonly reservations = new Map<string, HeldSeat>();
  private lobbyClosed = false;

  /** A detached metadata copy. Use setMetadata to update it. */
  get metadata(): RoomMetadata {
    return { ...this.metadataValue };
  }
  /** Publish searchable JSON scalars. @throws TypeError for non-scalar values; use finite JSON scalars. */
  setMetadata(metadata: RoomMetadata): void {
    for (const value of Object.values(metadata))
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))
      )
        throw new TypeError('Room metadata must contain finite JSON scalars; use strings, booleans, numbers or null');
    this.metadataValue = { ...metadata };
  }
  /** Reserved seats, excluding reconnecting clients. Expired credentials are swept before counting. */
  get reservedSeats(): number {
    this.sweep();
    return this.reservations.size;
  }
  /** Includes one-time reservations in addition to the ordinary capacity and manual lock. */
  override get locked(): boolean {
    const reserved = this.reservedSeats;
    return this.lobbyClosed || super.locked || this.clients.length + this.dropped.length + reserved >= this.maxClients;
  }
  /** Reservations keep an otherwise empty room alive. */
  override get empty(): boolean {
    return super.empty && this.reservedSeats === 0;
  }
  /**
   * Reserve one seat with immutable server-side join options. Default lifetime 15 seconds.
   * @throws MargoError `failed` if locked/full/closed; RangeError for a lifetime outside 1..2147483647 ms.
   */
  reserve(options: RoomOptions = {}, lifetime = 15_000): SeatReservation {
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 2_147_483_647)
      throw new RangeError('Reservation lifetime must be 1..2147483647 ms; pass an integer in range');
    if (this.lobbyClosed || this.locked) throw fault('failed', 'Room cannot reserve a seat; choose a joinable room');
    const copy = JSON.parse(JSON.stringify(options)) as RoomOptions;
    delete copy.seatToken;
    const seatToken = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const expiresAt = Date.now() + lifetime;
    const timer = setTimeout(() => {
      this.reservations.delete(seatToken);
      if (this.empty && this.autoDispose) this.release();
    }, lifetime);
    this.reservations.set(seatToken, { options: copy, expiresAt, timer });
    return { roomId: this.roomId, seatToken, expiresAt };
  }
  /** Cancel a token, freeing its seat immediately. Returns false for an unknown/already consumed token. */
  cancelReservation(seatToken: string): boolean {
    const seat = this.reservations.get(seatToken);
    if (!seat) return false;
    clearTimeout(seat.timer);
    this.reservations.delete(seatToken);
    if (this.empty && this.autoDispose) this.release();
    return true;
  }
  /** @internal Resolve server-held options before authentication; callers cannot replace the matched identity. */
  override async admit(
    connection: Connection,
    sessionId: string,
    options: RoomOptions,
  ): Promise<'joined' | 'refused' | 'failed'> {
    if ('seatToken' in options) {
      this.sweep();
      const seat = this.reservations.get(String(options.seatToken));
      if (!seat) return 'refused';
      options = { ...JSON.parse(JSON.stringify(seat.options)), seatToken: options.seatToken };
    }
    return super.admit(connection, sessionId, options);
  }
  /** Atomically consume a valid credential after async authentication; ordinary joins cannot take its seat. */
  protected override claimSeat(options: RoomOptions): boolean {
    if (!('seatToken' in options)) return super.claimSeat(options);
    this.sweep();
    const token = String(options.seatToken),
      seat = this.reservations.get(token);
    if (!seat || this.lobbyClosed || super.locked) return false;
    clearTimeout(seat.timer);
    this.reservations.delete(token);
    return true;
  }
  private sweep(): void {
    const now = Date.now();
    let expired = false;
    for (const [token, seat] of this.reservations)
      if (seat.expiresAt <= now) {
        clearTimeout(seat.timer);
        this.reservations.delete(token);
        expired = true;
      }
    if (expired && super.empty && !this.reservations.size && this.autoDispose) this.release();
  }
  /** @internal Dispose all pending reservations alongside the room. */
  override release(): void {
    this.lobbyClosed = true;
    for (const seat of this.reservations.values()) clearTimeout(seat.timer);
    this.reservations.clear();
    super.release();
  }
}

/** A live view of a RoomServer, suitable for exposing through an application's authenticated HTTP API. */
export class RoomLobby {
  /** Server whose rooms are listed. */
  constructor(private readonly server: RoomServer) {}
  /** Joinable public rooms with detached metadata. Ordinary Room subclasses have empty metadata. */
  list(filter: LobbyFilter = {}): LobbyListing[] {
    return this.server.rooms
      .filter((room) => !room.locked && !(room instanceof LobbyRoom && room.privateRoom))
      .map((room) => ({
        roomId: room.roomId,
        name: room.roomName,
        metadata: room instanceof LobbyRoom ? room.metadata : {},
        clients: room.clients.length,
        reserved: room.dropped.length + (room instanceof LobbyRoom ? room.reservedSeats : 0),
        maxClients: room.maxClients,
      }))
      .filter(
        (room) =>
          (!filter.name || room.name === filter.name) &&
          Object.entries(filter.metadata ?? {}).every(
            ([key, value]) => Object.hasOwn(room.metadata, key) && room.metadata[key] === value,
          ),
      )
      .sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  }
  /** Reserve on the authoritative room. @throws MargoError `failed` if missing or not a LobbyRoom. */
  reserve(roomId: string, options: RoomOptions = {}, lifetime = 15_000): SeatReservation {
    const room = this.server.rooms.find((room) => room.roomId === roomId);
    if (!(room instanceof LobbyRoom)) throw fault('failed', 'Room does not support reservations; define a LobbyRoom');
    return room.reserve(options, lifetime);
  }
}
