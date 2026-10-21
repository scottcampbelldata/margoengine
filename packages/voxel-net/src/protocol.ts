// The voxel-net wire format (design: packages/voxel-net/DESIGN.md, "Messages"): one byte of type, then the body.
// Integers are LEB128 varints (zigzag for signed ones), floats little-endian. Decoders check every length against the
// bytes they hold, so hostile input throws a RangeError instead of reading past its end.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import type { BlockTypes } from '@margoengine/voxel';
import type { EntityState } from '@margoengine/voxel/codec';
import type { VoxelMoveIntent } from '@margoengine/voxel/query';

/** Version of this wire format; a server closes connections that say another. */
export const PROTOCOL_VERSION = 1;

/** Seconds of one movement step: client and server both run `VoxelCharacter` at 120 steps per second. */
export const STEP_SECONDS = 1 / 120;

/** The fields the server sends for each player, for `EntityCodec`. */
export const PLAYER_SCHEMA = { position: 'position', rotation: 'rotation' } as const;

/** One player as `EntityCodec` decodes it with {@link PLAYER_SCHEMA}: feet position and look rotation. */
export type PlayerState = EntityState<typeof PLAYER_SCHEMA>;

/** Bits of {@link InputRun.keys}. */
export const Keys = {
  forward: 1,
  back: 2,
  left: 4,
  right: 8,
  jump: 16,
  descend: 32,
  sprint: 64,
  fly: 128,
} as const;

/** Consecutive movement steps with the same input. */
export interface InputRun {
  /** How many steps, 1 or more. */
  steps: number;
  /** {@link Keys} bits held. */
  keys: number;
  /** Heading, 0..65535 for a full turn: 0 looks along -z, a quarter turn (16384) along -x. */
  yaw: number;
  /** Look up or down, -127..127 for -90..90 degrees (drawn by others, not used for movement). */
  pitch: number;
}

/** A message from a client to the server. */
export type ClientMessage =
  /** First message: the client's protocol, wanted view distance in chunks and display name (at most 32 bytes). */
  | { type: 'hello'; version: number; view: number; name: string }
  /**
   * Movement steps `step`, `step + 1`, ... with their inputs, and where the client's own simulation ended up after the
   * last of them. `acked` is the step of the last correction the client applied (0 for none).
   */
  | { type: 'input'; step: number; acked: number; runs: InputRun[]; position: Vec3 }
  /** Set cell (x, y, z) to block state `state` (0 breaks). */
  | { type: 'edit'; x: number; y: number; z: number; state: number };

/** A message from the server to a client. */
export type ServerMessage =
  /** Answer to hello: the player's id and the distances the server grants (chunks, and blocks for players). */
  | {
      type: 'welcome';
      version: number;
      id: number;
      tickRate: number;
      view: number;
      viewHeight: number;
      simulation: number;
      simulationHeight: number;
      playerDistance: number;
      /** {@link blockTableHash} of the server's block types; a client with other types cannot play. */
      blocks: number;
      /** Whether flying is allowed. */
      flight: boolean;
    }
  /** Chunk (cx, cy, cz) as `encodeChunk` bytes (without light). */
  | { type: 'chunk'; cx: number; cy: number; cz: number; data: Uint8Array }
  /** The client should drop chunk (cx, cy, cz); the server will send it again when it is back in view. */
  | { type: 'unload'; cx: number; cy: number; cz: number }
  /**
   * The player's state after movement step `step`: where it spawns (`spawn`, step 0) or a correction the client
   * applies and then replays its later steps on.
   */
  | { type: 'state'; spawn: boolean; step: number; position: Vec3; velocity: Vec3; flying: boolean }
  /** `encodeBlockChanges` bytes: edits in chunks this client has. */
  | { type: 'blocks'; data: Uint8Array }
  /** Server tick `tick`, then `EntityCodec` bytes of the nearby players against the previous players message. */
  | { type: 'players'; tick: number; data: Uint8Array }
  /** The whole view has been sent once since joining. */
  | { type: 'loaded' };

const HELLO = 1,
  INPUT = 2,
  EDIT = 3,
  WELCOME = 16,
  CHUNK = 17,
  UNLOAD = 18,
  STATE = 19,
  BLOCKS = 20,
  PLAYERS = 21,
  LOADED = 22,
  NAME_BYTES = 32,
  MAX_RUNS = 1024,
  encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });

const zigzag = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n);
const unzigzag = (z: number): number => (z % 2 ? -(z + 1) / 2 : z / 2);

class Writer {
  bytes = new Uint8Array(64);
  view = new DataView(this.bytes.buffer);
  at = 0;
  room(n: number): void {
    if (this.at + n <= this.bytes.length) return;
    const bytes = new Uint8Array(Math.max(2 * this.bytes.length, this.at + n));
    bytes.set(this.bytes);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer);
  }
  u8(v: number): void {
    this.room(1);
    this.bytes[this.at++] = v;
  }
  u16(v: number): void {
    this.room(2);
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }
  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.at, v, true);
    this.at += 4;
  }
  f32(v: number): void {
    this.room(4);
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }
  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }
  varint(v: number): void {
    this.room(5);
    for (; v > 127; v >>>= 7) this.bytes[this.at++] = (v & 127) | 128;
    this.bytes[this.at++] = v;
  }
  raw(b: Uint8Array): void {
    this.room(b.length);
    this.bytes.set(b, this.at);
    this.at += b.length;
  }
  done(): Uint8Array {
    return this.bytes.slice(0, this.at);
  }
}

class Reader {
  at = 1;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  fail(problem: string): RangeError {
    return new RangeError(
      `voxel-net message ${problem}; send what encodeClientMessage or encodeServerMessage returned`,
    );
  }
  need(n: number): void {
    if (this.at + n > this.bytes.length) throw this.fail(`is truncated at byte ${this.at} of ${this.bytes.length}`);
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.at++];
  }
  u16(): number {
    this.need(2);
    this.at += 2;
    return this.view.getUint16(this.at - 2, true);
  }
  u32(): number {
    this.need(4);
    this.at += 4;
    return this.view.getUint32(this.at - 4, true);
  }
  f32(): number {
    this.need(4);
    this.at += 4;
    return this.finite(this.view.getFloat32(this.at - 4, true));
  }
  f64(): number {
    this.need(8);
    this.at += 8;
    return this.finite(this.view.getFloat64(this.at - 8, true));
  }
  finite(v: number): number {
    if (!Number.isFinite(v)) throw this.fail(`holds a non-finite number at byte ${this.at}`);
    return v;
  }
  varint(): number {
    let value = 0,
      scale = 1;
    for (let n = 0; ; n++, scale *= 128) {
      const b = this.u8();
      if (n === 4 && b > 15) throw this.fail(`has a varint wider than 32 bits at byte ${this.at - 1}`);
      value += (b & 127) * scale;
      if (b < 128) return value;
    }
  }
  int(): number {
    return unzigzag(this.varint());
  }
  vec(f: () => number): MutableVec3 {
    return [f(), f(), f()];
  }
  rest(): Uint8Array {
    const out = this.bytes.slice(this.at);
    this.at = this.bytes.length;
    return out;
  }
  end(): void {
    if (this.at !== this.bytes.length) throw this.fail(`has ${this.bytes.length - this.at} bytes past its end`);
  }
}

const integer = (what: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number') throw new TypeError(`${what} must be a number`);
  if (!Number.isInteger(v) || v < min || v > max)
    throw new RangeError(`${what} ${v} is not an integer in ${min}..${max}`);
  return v;
};
const finite = (what: string, v: unknown): number => {
  if (typeof v !== 'number') throw new TypeError(`${what} must be a number`);
  if (!Number.isFinite(v)) throw new RangeError(`${what} ${v} is not finite`);
  return v;
};
const vector = (what: string, v: unknown): Vec3 => {
  if (!v || typeof v !== 'object' || (v as Vec3).length !== 3) throw new TypeError(`${what} must be [x, y, z]`);
  const a = v as Vec3;
  return [finite(`${what} x`, a[0]), finite(`${what} y`, a[1]), finite(`${what} z`, a[2])];
};
const cell = (what: string, v: unknown): number => integer(what, v, -(2 ** 31), 2 ** 31 - 1);
const chunk = (what: string, v: unknown): number => integer(what, v, -(2 ** 26), 2 ** 26 - 1);
const bytesOf = (what: string, v: unknown): Uint8Array => {
  if (!(v instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array`);
  return v;
};

/**
 * Bytes of a {@link ClientMessage}.
 * @throws TypeError for a message of unknown type or a field of the wrong type.
 * @throws RangeError for a field out of range: a name over 32 UTF-8 bytes, no runs or more than 1,024, a non-finite
 * position, a cell outside the 32-bit cells.
 */
export function encodeClientMessage(message: ClientMessage): Uint8Array {
  const w = new Writer();
  switch (message?.type) {
    case 'hello': {
      const name = encoder.encode(String(message.name ?? ''));
      if (name.length > NAME_BYTES)
        throw new RangeError(`Player name is ${name.length} bytes; use at most ${NAME_BYTES}`);
      w.u8(HELLO);
      w.varint(integer('hello version', message.version, 0, 2 ** 32 - 1));
      w.varint(integer('hello view', message.view, 0, 64));
      w.varint(name.length);
      w.raw(name);
      break;
    }
    case 'input': {
      const runs = message.runs;
      if (!Array.isArray(runs)) throw new TypeError('input runs must be an array of InputRun');
      if (!runs.length || runs.length > MAX_RUNS)
        throw new RangeError(`input has ${runs.length} runs; send 1..${MAX_RUNS} per message`);
      w.u8(INPUT);
      w.varint(integer('input step', message.step, 1, 2 ** 32 - 1));
      w.varint(integer('input acked', message.acked, 0, 2 ** 32 - 1));
      w.varint(runs.length);
      for (const run of runs) {
        w.varint(integer('input run steps', run?.steps, 1, 2 ** 16));
        w.u8(integer('input run keys', run.keys, 0, 255));
        w.u16(integer('input run yaw', run.yaw, 0, 65535));
        w.u8(integer('input run pitch', run.pitch, -127, 127) & 255);
      }
      for (const v of vector('input position', message.position)) w.f64(v);
      break;
    }
    case 'edit':
      w.u8(EDIT);
      w.varint(zigzag(cell('edit x', message.x)));
      w.varint(zigzag(cell('edit y', message.y)));
      w.varint(zigzag(cell('edit z', message.z)));
      w.varint(integer('edit state', message.state, 0, 2 ** 32 - 1));
      break;
    default:
      throw new TypeError(`Unknown client message type ${String((message as { type?: unknown })?.type)}`);
  }
  return w.done();
}

/**
 * The {@link ClientMessage} in `bytes`.
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError for an unknown type, truncated or trailing bytes, or a field out of range.
 */
export function decodeClientMessage(bytes: Uint8Array): ClientMessage {
  const r = new Reader(bytesOf('decodeClientMessage bytes', bytes)),
    type = bytes[0];
  let message: ClientMessage;
  if (type === HELLO) {
    const version = r.varint(),
      view = r.varint(),
      n = r.varint();
    if (n > NAME_BYTES) throw r.fail(`has a name of ${n} bytes, over ${NAME_BYTES}`);
    r.need(n);
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(r.at, (r.at += n)));
    } catch {
      throw r.fail('has a name that is not UTF-8');
    }
    message = { type: 'hello', version, view, name };
  } else if (type === INPUT) {
    const step = r.varint(),
      acked = r.varint(),
      n = r.varint();
    if (!step || !n || n > MAX_RUNS) throw r.fail(`has step ${step} and ${n} runs`);
    const runs: InputRun[] = [];
    for (let i = 0; i < n; i++) {
      const steps = r.varint();
      if (!steps || steps > 2 ** 16) throw r.fail(`has a run of ${steps} steps`);
      runs.push({ steps, keys: r.u8(), yaw: r.u16(), pitch: (r.u8() << 24) >> 24 });
    }
    message = { type: 'input', step, acked, runs, position: r.vec(() => r.f64()) };
  } else if (type === EDIT) {
    const x = r.int(),
      y = r.int(),
      z = r.int(),
      state = r.varint();
    if (![x, y, z].every((v) => (v | 0) === v)) throw r.fail(`edits cell (${x}, ${y}, ${z}), outside the 32-bit cells`);
    message = { type: 'edit', x, y, z, state };
  } else throw r.fail(`has unknown type ${type}`);
  r.end();
  return message;
}

/**
 * Bytes of a {@link ServerMessage}.
 * @throws TypeError for a message of unknown type or a field of the wrong type.
 * @throws RangeError for a field out of range.
 */
export function encodeServerMessage(message: ServerMessage): Uint8Array {
  const w = new Writer();
  switch (message?.type) {
    case 'welcome':
      w.u8(WELCOME);
      for (const key of [
        'version',
        'id',
        'tickRate',
        'view',
        'viewHeight',
        'simulation',
        'simulationHeight',
        'playerDistance',
      ] as const)
        w.varint(integer(`welcome ${key}`, message[key], 0, 2 ** 32 - 1));
      w.u32(integer('welcome blocks', message.blocks, 0, 2 ** 32 - 1));
      w.u8(message.flight ? 1 : 0);
      break;
    case 'chunk':
    case 'unload':
      w.u8(message.type === 'chunk' ? CHUNK : UNLOAD);
      w.varint(zigzag(chunk('chunk cx', message.cx)));
      w.varint(zigzag(chunk('chunk cy', message.cy)));
      w.varint(zigzag(chunk('chunk cz', message.cz)));
      if (message.type === 'chunk') w.raw(bytesOf('chunk data', message.data));
      break;
    case 'state':
      w.u8(STATE);
      w.u8(message.spawn ? 1 : 0);
      w.varint(integer('state step', message.step, 0, 2 ** 32 - 1));
      for (const v of vector('state position', message.position)) w.f64(v);
      for (const v of vector('state velocity', message.velocity)) w.f32(v);
      w.u8(message.flying ? 1 : 0);
      break;
    case 'blocks':
      w.u8(BLOCKS);
      w.raw(bytesOf('blocks data', message.data));
      break;
    case 'players':
      w.u8(PLAYERS);
      w.varint(integer('players tick', message.tick, 0, 2 ** 32 - 1));
      w.raw(bytesOf('players data', message.data));
      break;
    case 'loaded':
      w.u8(LOADED);
      break;
    default:
      throw new TypeError(`Unknown server message type ${String((message as { type?: unknown })?.type)}`);
  }
  return w.done();
}

/**
 * The {@link ServerMessage} in `bytes`. Chunk, block and player bodies are returned as bytes for the voxel codecs.
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError for an unknown type, truncated or trailing bytes, or a field out of range.
 */
export function decodeServerMessage(bytes: Uint8Array): ServerMessage {
  const r = new Reader(bytesOf('decodeServerMessage bytes', bytes)),
    type = bytes[0];
  let message: ServerMessage;
  if (type === WELCOME) {
    const [version, id, tickRate, view, viewHeight, simulation, simulationHeight, playerDistance] = Array.from(
      { length: 8 },
      () => r.varint(),
    );
    message = {
      type: 'welcome',
      version,
      id,
      tickRate,
      view,
      viewHeight,
      simulation,
      simulationHeight,
      playerDistance,
      blocks: r.u32(),
      flight: r.u8() === 1,
    };
  } else if (type === CHUNK || type === UNLOAD) {
    const cx = r.int(),
      cy = r.int(),
      cz = r.int();
    if (![cx, cy, cz].every((c) => (c << 5) >> 5 === c))
      throw r.fail(`names chunk (${cx}, ${cy}, ${cz}), out of range`);
    message = type === CHUNK ? { type: 'chunk', cx, cy, cz, data: r.rest() } : { type: 'unload', cx, cy, cz };
  } else if (type === STATE) {
    const spawn = r.u8() === 1,
      step = r.varint(),
      position = r.vec(() => r.f64()),
      velocity = r.vec(() => r.f32());
    message = { type: 'state', spawn, step, position, velocity, flying: r.u8() === 1 };
  } else if (type === BLOCKS) message = { type: 'blocks', data: r.rest() };
  else if (type === PLAYERS) message = { type: 'players', tick: r.varint(), data: r.rest() };
  else if (type === LOADED) message = { type: 'loaded' };
  else throw r.fail(`has unknown type ${type}`);
  r.end();
  return message;
}

/**
 * A 32-bit FNV-1a hash of `blocks`' names and the flags movement depends on (solid, liquid), in id order. Server and
 * client compare it so both simulate the same world.
 * @throws TypeError when `blocks` has no block table.
 */
export function blockTableHash(blocks: BlockTypes): number {
  if (!Array.isArray(blocks?.table)) throw new TypeError('blockTableHash expects BlockTypes');
  let h = 0x811c9dc5;
  for (const type of blocks.table)
    for (const c of encoder.encode(`${type.name}:${type.solid ? 1 : 0}${type.liquid ? 1 : 0};`))
      h = Math.imul(h ^ c, 0x01000193);
  return h >>> 0;
}

/**
 * The `VoxelCharacter` intent of one step's input: walking direction from the {@link Keys} bits turned by `yaw`
 * (0..65535), and the jump, descend and sprint keys. Client and server both call it, so they move alike.
 */
export function moveIntent(keys: number, yaw: number): VoxelMoveIntent {
  const angle = (yaw * Math.PI) / 32768,
    ahead = (keys & Keys.forward ? 1 : 0) - (keys & Keys.back ? 1 : 0),
    side = (keys & Keys.right ? 1 : 0) - (keys & Keys.left ? 1 : 0),
    sin = Math.sin(angle),
    cos = Math.cos(angle);
  return {
    direction: [-sin * ahead + cos * side, 0, -cos * ahead - sin * side],
    jump: (keys & Keys.jump) !== 0,
    descend: (keys & Keys.descend) !== 0,
    sprint: (keys & Keys.sprint) !== 0,
  };
}

/** `yaw` in radians as the 16-bit heading of {@link InputRun.yaw}. */
export const quantizeYaw = (yaw: number): number => Math.round((yaw / (2 * Math.PI)) * 65536) & 65535;

/** `pitch` in radians (-pi/2..pi/2) as {@link InputRun.pitch}. */
export const quantizePitch = (pitch: number): number =>
  Math.max(-127, Math.min(127, Math.round((pitch / (Math.PI / 2)) * 127)));
