// The voxel-net wire format (design: packages/voxel-net/DESIGN.md, "Messages"): one byte of type, then the body.
// Integers are LEB128 varints (zigzag for signed ones), floats little-endian. Decoders check every length against the
// bytes they hold, so hostile input throws a RangeError instead of reading past its end.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import type { BlockTypes } from '@margoengine/voxel';
import type { EntityState } from '@margoengine/voxel/codec';
import type { VoxelMoveIntent } from '@margoengine/voxel/query';
import { ByteReader, ByteWriter, unzigzag, zigzag } from '../../shared/bytes.js';

/** Version of this wire format; a server closes connections that say another. */
export const PROTOCOL_VERSION = 2;

/** Most UTF-8 bytes of a player's display name, on the wire and after {@link cleanPlayerName}. */
export const MAX_NAME_BYTES = 32;

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

/** A player's id and display name, as the {@link ServerMessage} `names` carries them. */
export interface PlayerName {
  /** The player's id, as in the players messages. */
  id: number;
  /** Its display name, at most {@link MAX_NAME_BYTES} UTF-8 bytes. */
  name: string;
}

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
  | { type: 'loaded' }
  /** Names of the players about to enter this client's players messages; players without a name are left out. */
  | { type: 'names'; names: PlayerName[] };

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
  NAMES = 23,
  MAX_RUNS = 1024,
  MAX_NAMES = 65535, // VoxelServer's largest maxPlayers
  encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });

// voxel-net also writes doubles.
class Writer extends ByteWriter {
  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }
}

// voxel-net messages start after their kind byte; floats must be finite.
class Reader extends ByteReader {
  constructor(bytes: Uint8Array) {
    super(bytes, 'voxel-net message', 'send what encodeClientMessage or encodeServerMessage returned', 1);
  }
  override f32(): number {
    return this.finite(super.f32());
  }
  f64(): number {
    this.need(8);
    this.at += 8;
    return this.finite(this.view.getFloat64(this.at - 8, true));
  }
  name(): string {
    const n = this.varint();
    if (n > MAX_NAME_BYTES) throw this.fail(`has a name of ${n} bytes, over ${MAX_NAME_BYTES}`);
    this.need(n);
    try {
      return decoder.decode(this.bytes.subarray(this.at, (this.at += n)));
    } catch {
      throw this.fail('has a name that is not UTF-8');
    }
  }
  rest(): Uint8Array {
    const out = this.bytes.slice(this.at);
    this.at = this.bytes.length;
    return out;
  }
  finite(v: number): number {
    if (!Number.isFinite(v)) throw this.fail(`holds a non-finite number at byte ${this.at}`);
    return v;
  }
  int(): number {
    return unzigzag(this.varint());
  }
  vec(f: () => number): MutableVec3 {
    return [f(), f(), f()];
  }
}

const integer = (what: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number') throw new TypeError(`${what} must be a number`);
  if (!Number.isInteger(v) || v < min || v > max)
    throw new RangeError(`${what} ${v} is not an integer in ${min}..${max}; pass a whole number in that range`);
  return v;
};
const finite = (what: string, v: unknown): number => {
  if (typeof v !== 'number') throw new TypeError(`${what} must be a number`);
  if (!Number.isFinite(v)) throw new RangeError(`${what} ${v} is not finite; pass a finite number`);
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

// Characters a name never shows: controls and format marks (bidi overrides, zero widths), surrogates left alone,
// private use, unassigned, blank letters that look like nothing, and the angle brackets of markup.
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}<>\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0]/gu;

/**
 * `name` as safe to show other players: NFC, without invisible characters (controls, bidi overrides, zero widths, blank
 * letters), angle brackets or stacks of more than 2 combining marks, its whitespace collapsed and trimmed, cut on a
 * character boundary to {@link MAX_NAME_BYTES} bytes. `VoxelServer` runs every hello's name through it. Anything but a
 * string, or a name with nothing visible left, gives `''`. Still show the result as text, never as HTML.
 */
export function cleanPlayerName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const clean = name
    .normalize('NFC')
    .replace(/[\p{Z}\t\n\v\f\r\u0085]+/gu, ' ') // first: a line break must leave a space, not join two words
    .replace(UNSHOWN, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (encoder.encode(clean).length <= MAX_NAME_BYTES) return clean;
  let cut = '',
    bytes = 0;
  for (const c of clean) {
    bytes += encoder.encode(c).length;
    if (bytes > MAX_NAME_BYTES) break;
    cut += c;
  }
  return cut.trimEnd();
}

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
      if (name.length > MAX_NAME_BYTES)
        throw new RangeError(`Player name is ${name.length} bytes; use at most ${MAX_NAME_BYTES}`);
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
      throw new TypeError(
        `Unknown client message type ${String((message as { type?: unknown })?.type)}; use one of the ClientMessage types`,
      );
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
      view = r.varint();
    message = { type: 'hello', version, view, name: r.name() };
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
 * @throws RangeError for a field out of range: a chunk past the 27-bit chunk positions, a names message with no entry
 * or more than 65,535, a name over 32 UTF-8 bytes.
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
    case 'names': {
      const names = message.names;
      if (!Array.isArray(names)) throw new TypeError('names must be an array of PlayerName');
      if (!names.length || names.length > MAX_NAMES)
        throw new RangeError(`names has ${names.length} entries; send 1..${MAX_NAMES} per message`);
      w.u8(NAMES);
      w.varint(names.length);
      for (const entry of names) {
        w.varint(integer('names id', entry?.id, 0, 2 ** 32 - 1));
        if (typeof entry.name !== 'string') throw new TypeError('names name must be a string');
        const name = encoder.encode(entry.name);
        if (name.length > MAX_NAME_BYTES)
          throw new RangeError(`Player name is ${name.length} bytes; use at most ${MAX_NAME_BYTES}`);
        w.varint(name.length);
        w.raw(name);
      }
      break;
    }
    default:
      throw new TypeError(
        `Unknown server message type ${String((message as { type?: unknown })?.type)}; use one of the ServerMessage types`,
      );
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
  else if (type === NAMES) {
    const n = r.varint();
    if (!n || n > MAX_NAMES) throw r.fail(`has ${n} names`);
    const names: PlayerName[] = [];
    for (let i = 0; i < n; i++) {
      const id = r.varint();
      names.push({ id, name: r.name() });
    }
    message = { type: 'names', names };
  } else throw r.fail(`has unknown type ${type}`);
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
