// Byte codecs for disk and the network (design: packages/voxel/DESIGN.md, "Data formats"): chunks, block-change lists
// and schema-driven entity deltas. Decoders check every count and length against the bytes they hold before reading
// or allocating, so hostile input throws a RangeError instead of reading past its end or inflating without bound.
import type { MutableVec3, Quat, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { type PackedChunk, stateError, VoxelChunk } from './chunk.js';
import { VoxelWorld } from './world.js';
import { ByteReader, ByteWriter, unzigzag, zigzag } from '../../shared/bytes.js';

const CELLS = 32768,
  VERSION = 1,
  LIGHT = 1, // flags: light follows the indices
  DENSE = 2, //        ... as 32,768 bytes rather than one byte for every cell
  DEFLATE = 4, //      everything after the flags byte is deflate-raw
  // Largest chunk body (all after version and flags): 32,768 five-byte states, 16-bit indices, dense light.
  MAX_BODY = 3 + CELLS * 5 + 1 + 4096 * 16 + CELLS,
  // deflate-raw output for MAX_BODY input stays below this (zlib's deflateBound plus slack).
  MAX_DEFLATED = MAX_BODY + 1024;

const isChunk = (c: number): boolean => (c << 5) >> 5 === c;

// `data` through a compression stream, at most `limit` bytes out; RangeError for data the stream rejects.
async function pipe(stream: CompressionStream | DecompressionStream, data: Uint8Array, limit: number) {
  const writer = stream.writable.getWriter(),
    reader = stream.readable.getReader(),
    parts: Uint8Array[] = [];
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  let size = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch {
      throw new RangeError('Chunk data holds a damaged deflate-raw stream; pass the bytes encodeChunk returned');
    }
    if (next.done) break;
    size += next.value.length;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw new RangeError(
        `Chunk data inflates past ${limit} bytes, more than any chunk; pass what encodeChunk returned`,
      );
    }
    parts.push(next.value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const streams = (kind: string): void => {
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function')
    throw new MargoError(
      'unsupported',
      `${kind} needs CompressionStream, which this runtime lacks; use a current browser or Node 18+`,
    );
};

/**
 * Encodes `chunk` (block states and, unless `options.light` is false, light bytes) for a save or the network. The
 * chunk is read before this returns, so it may change while compression runs. Bytes: u8 version (1), u8 flags (1
 * light, 2 dense light, 4 deflated), then (deflate-raw when flagged) a varint palette length, that many varint
 * states, u8 index bits (0, 1, 2, 4, 8, 16), 1,024 x bits little-endian u32 index words (the layout of
 * {@link PackedChunk}) and the light: one byte for every cell, or 32,768 bytes.
 * @param options `light` (default true) keeps light bytes (without them every cell decodes with light 0);
 * `compress` (default true) deflates with the browser's `CompressionStream('deflate-raw')`.
 * @throws TypeError (rejects) when `chunk` is not a VoxelChunk.
 * @throws MargoError `'unsupported'` (rejects) when compressing without CompressionStream.
 */
export async function encodeChunk(
  chunk: VoxelChunk,
  options: { light?: boolean; compress?: boolean } = {},
): Promise<Uint8Array> {
  if (!(chunk instanceof VoxelChunk)) throw new TypeError('encodeChunk expects a VoxelChunk');
  const { light = true, compress = true } = options,
    { palette, bits, words, light: cells } = chunk.pack();
  let byte = typeof cells === 'number' ? cells : cells[0];
  if (light && typeof cells !== 'number') for (let i = 1; i < CELLS && byte >= 0; i++) if (cells[i] !== byte) byte = -1;
  const out = new ByteWriter(7 + palette.length * 5 + words.length * 4 + (byte < 0 ? CELLS : 1));
  out.u8(VERSION);
  out.u8(light ? (byte < 0 ? LIGHT | DENSE : LIGHT) : 0);
  out.varint(palette.length);
  for (const state of palette) out.varint(state);
  out.u8(bits);
  for (const word of words) out.u32(word);
  if (light && byte < 0) out.raw(cells as Uint8Array);
  else if (light) out.u8(byte);
  const raw = out.done();
  if (!compress) return raw;
  streams('encodeChunk with compress');
  const body = await pipe(new CompressionStream('deflate-raw'), raw.subarray(2), Infinity),
    result = new Uint8Array(2 + body.length);
  result.set([VERSION, raw[1] | DEFLATE]);
  result.set(body, 2);
  return result;
}

/**
 * The chunk that {@link encodeChunk} wrote into `bytes` (deflated or not, with or without light).
 * @throws TypeError (rejects) when `bytes` is not a Uint8Array.
 * @throws RangeError (rejects) for anything but a complete chunk: truncated, longer than its contents, another
 * version, unknown flags, a palette or index width out of range, a cell index past the palette, a deflate stream
 * that is damaged or inflates past the largest possible chunk (262,148 bytes).
 * @throws MargoError `'unsupported'` (rejects) for deflated bytes without DecompressionStream.
 */
export async function decodeChunk(bytes: Uint8Array): Promise<VoxelChunk> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodeChunk expects the Uint8Array encodeChunk returned');
  let r = new ByteReader(bytes, 'Chunk data', 'pass the bytes encodeChunk returned');
  const version = r.u8(),
    flags = r.u8();
  if (version !== VERSION) throw r.fail(`has version ${version}, not ${VERSION}`, 'decode it with a matching release');
  if (flags > 7 || (flags & (LIGHT | DENSE)) === DENSE) throw r.fail(`has unknown flags ${flags}`);
  let body = bytes.subarray(2);
  if (body.length > (flags & DEFLATE ? MAX_DEFLATED : MAX_BODY))
    throw r.fail(`has ${bytes.length} bytes, more than any chunk needs`);
  if (flags & DEFLATE) {
    streams('decodeChunk of deflated bytes');
    body = await pipe(new DecompressionStream('deflate-raw'), body, MAX_BODY);
  }
  r = new ByteReader(body, 'Chunk data', 'pass the bytes encodeChunk returned');
  const n = r.varint();
  if (n < 1 || n > CELLS) throw r.fail(`has a palette of ${n} states, not 1..32768`);
  const palette = new Uint32Array(n);
  for (let i = 0; i < n; i++) palette[i] = r.varint();
  const bits = r.u8() as PackedChunk['bits'];
  if (![0, 1, 2, 4, 8, 16].includes(bits)) throw r.fail(`has ${bits}-bit cell indices, not 0, 1, 2, 4, 8 or 16`);
  if (n > (bits ? Math.min(1 << bits, CELLS) : 1)) throw r.fail(`has ${n} palette states for ${bits}-bit indices`);
  r.need(4096 * bits);
  const words = new Uint32Array(1024 * bits);
  for (let i = 0; i < words.length; i++) words[i] = r.u32();
  let light: number | Uint8Array = 0;
  if (flags & DENSE) {
    r.need(CELLS);
    light = body.slice(r.at, (r.at += CELLS));
  } else if (flags & LIGHT) light = r.u8();
  r.end();
  try {
    return VoxelChunk.unpack({ palette, bits, words, light });
  } catch {
    throw r.fail('has a cell index past its palette'); // the one check unpack makes that the reads above do not
  }
}

/**
 * Encodes block changes, a flat `[x, y, z, state, ...]` list as {@link VoxelWorld.setBlocks} takes (an Int32Array
 * works: negative states are their u32 bit pattern), for the network or a save. A cell listed twice keeps its last
 * state. Bytes: varint count, then per change, sorted by chunk (cx, cy, cz) and cell index: varint `step`, then for
 * the first change in a chunk (`step` odd, `step >> 1` its cell index) three zigzag varints from the previous chunk
 * (the first from 0, 0, 0), otherwise (`step` even) `step >> 1` is the offset from the previous cell index; then the
 * varint state. Changes within one chunk typically cost 2-4 bytes each.
 * @throws TypeError when `changes` is not an array-like of quadruples or holds a non-number.
 * @throws RangeError for a cell coordinate that is not a 32-bit integer or a state that is not a u32.
 */
export function encodeBlockChanges(changes: ArrayLike<number>): Uint8Array {
  if (!changes || typeof changes !== 'object' || !Number.isInteger(changes.length) || changes.length % 4)
    throw new TypeError('encodeBlockChanges expects a flat [x, y, z, state, ...] array of quadruples');
  const n = changes.length / 4,
    cx = new Int32Array(n),
    cy = new Int32Array(n),
    cz = new Int32Array(n),
    cell = new Uint16Array(n),
    states = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = changes[4 * i],
      y = changes[4 * i + 1],
      z = changes[4 * i + 2],
      s = changes[4 * i + 3],
      state = (s | 0) === s ? s >>> 0 : s;
    if ((x | 0) !== x || (y | 0) !== y || (z | 0) !== z)
      throw [x, y, z].every((v) => typeof v === 'number')
        ? new RangeError(`Block change ${i} cell (${x}, ${y}, ${z}) is not three 32-bit integers; floor positions`)
        : new TypeError(`Block change ${i} cell coordinates must be numbers`);
    if (state >>> 0 !== state) throw stateError(s);
    cx[i] = x >> 5;
    cy[i] = y >> 5;
    cz[i] = z >> 5;
    cell[i] = (x & 31) | ((z & 31) << 5) | ((y & 31) << 10);
    states[i] = state;
  }
  const same = (a: number, b: number): boolean =>
      cx[a] === cx[b] && cy[a] === cy[b] && cz[a] === cz[b] && cell[a] === cell[b],
    // A stable sort keeps a repeated cell's changes in input order, so the last of each run is the one that stays.
    order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => cx[a] - cx[b] || cy[a] - cy[b] || cz[a] - cz[b] || cell[a] - cell[b])
      .filter((a, k, all) => k + 1 === all.length || !same(a, all[k + 1])),
    out = new ByteWriter(5 + order.length * 4);
  out.varint(order.length);
  let previous = -1;
  for (const i of order) {
    if (previous >= 0 && cx[i] === cx[previous] && cy[i] === cy[previous] && cz[i] === cz[previous])
      out.varint((cell[i] - cell[previous]) * 2);
    else {
      out.varint(cell[i] * 2 + 1);
      out.varint(zigzag(cx[i] - (previous < 0 ? 0 : cx[previous])));
      out.varint(zigzag(cy[i] - (previous < 0 ? 0 : cy[previous])));
      out.varint(zigzag(cz[i] - (previous < 0 ? 0 : cz[previous])));
    }
    out.varint(states[i]);
    previous = i;
  }
  return out.done();
}

/**
 * The changes {@link encodeBlockChanges} wrote, as a flat `[x, y, z, state, ...]` Int32Array sorted by chunk and
 * cell index (states of 2^31 and up read negative: their u32 bit pattern, as {@link VoxelWorld.setBlocks} takes).
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws RangeError for truncated bytes, trailing bytes, a count the bytes cannot hold, cells out of order or
 * repeated, a cell index past 32,767, or a chunk outside the 32-bit cell range.
 */
export function decodeBlockChanges(bytes: Uint8Array): Int32Array {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError('decodeBlockChanges expects the Uint8Array encodeBlockChanges returned');
  const r = new ByteReader(bytes, 'Block changes', 'pass the bytes encodeBlockChanges returned'),
    n = r.varint();
  if (n > (bytes.length - r.at) / 2) throw r.fail(`list ${n} changes in ${bytes.length} bytes`);
  const out = new Int32Array(4 * n);
  let cx = 0,
    cy = 0,
    cz = 0,
    cell = -1;
  for (let i = 0; i < n; i++) {
    const step = r.varint();
    if (step % 2) {
      const dx = unzigzag(r.varint()),
        dy = unzigzag(r.varint()),
        dz = unzigzag(r.varint());
      if (cell >= 0 && !(dx > 0 || (dx === 0 && (dy > 0 || (dy === 0 && dz > 0)))))
        throw r.fail(`list chunks out of order at change ${i}`);
      cx += dx;
      cy += dy;
      cz += dz;
      if (!isChunk(cx) || !isChunk(cy) || !isChunk(cz))
        throw r.fail(`reach chunk (${cx}, ${cy}, ${cz}) outside the 32-bit cell range at change ${i}`);
      cell = (step - 1) / 2;
    } else {
      if (cell < 0) throw r.fail('start without a chunk');
      if (!step) throw r.fail(`repeat a cell at change ${i}`);
      cell += step / 2;
    }
    if (cell > 32767) throw r.fail(`reach cell index ${cell}, past 32767, at change ${i}`);
    out[4 * i] = cx * 32 + (cell & 31);
    out[4 * i + 1] = cy * 32 + (cell >> 10);
    out[4 * i + 2] = cz * 32 + ((cell >> 5) & 31);
    out[4 * i + 3] = r.varint() | 0;
  }
  r.end();
  return out;
}

/**
 * Decodes `bytes` ({@link encodeBlockChanges}) and applies them with `world.setBlocks`: all or none, with its dirty
 * marking and change events. Returns how many cells changed.
 * @throws TypeError when `world` is not a VoxelWorld; otherwise as {@link decodeBlockChanges} and
 * {@link VoxelWorld.setBlocks} (a y outside the world, an undefined block id), before any cell changes.
 */
export function applyBlockChanges(world: VoxelWorld, bytes: Uint8Array): number {
  if (!(world instanceof VoxelWorld)) throw new TypeError('applyBlockChanges expects a VoxelWorld');
  return world.setBlocks(decodeBlockChanges(bytes));
}

/**
 * Type of one {@link EntityCodec} field: `'position'` (a Vec3 in blocks, sent as the change from the baseline in
 * 1/512-block steps; |coordinate| < 2,097,152), `'rotation'` (a unit quaternion, 32 bits smallest-three: about 0.1
 * degree), `'u8'`, `'u16'` (integers) or `'f32'` (a finite float32).
 */
export type EntityField = 'position' | 'rotation' | 'u8' | 'u16' | 'f32';

/** One entity's values under {@link EntityCodec} schema `S`: a Vec3 per position, a Quat per rotation, numbers. */
export type EntityState<S extends Readonly<Record<string, EntityField>>> = {
  [K in keyof S]: S[K] extends 'position' ? Vec3 : S[K] extends 'rotation' ? Quat : number;
};

const FIELDS: readonly EntityField[] = ['position', 'rotation', 'u8', 'u16', 'f32'],
  STEPS = 512, // position steps per block
  LIMIT = 2 ** 30; // |position steps| stays below this, so a change from the baseline is a 32-bit zigzag varint
type Entity = Record<string, unknown>;
type Quantized = (number | number[])[];

declare const preparedBrand: unique symbol;
/**
 * An entity state quantized once by {@link EntityCodec.prepare}: pass it to {@link EntityCodec.encode} in place of the
 * state for any number of receivers. Opaque; it holds the values as they were when prepared.
 */
export interface PreparedEntity {
  readonly [preparedBrand]: true;
}
// Each prepared entity's codec and quantized fields.
const prepared = new WeakMap<object, { codec: object; fields: Quantized }>();

// A unit quaternion as 2 bits (its largest component) and the other three in [-1/sqrt 2, 1/sqrt 2], 10 bits each
// (511 + round(c * sqrt 2 * 511): 0..1022, so 0 is exact), negated so the largest is positive (q and -q are one
// rotation).
function packRotation(c: ArrayLike<number>): number {
  let big = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(c[i]) > Math.abs(c[big])) big = i;
  const scale = (c[big] < 0 ? -1 : 1) / Math.hypot(c[0], c[1], c[2], c[3]);
  let word = big * 2 ** 30,
    shift = 20;
  for (let i = 0; i < 4; i++)
    if (i !== big) {
      word += (511 + Math.min(511, Math.max(-511, Math.round(c[i] * scale * Math.SQRT2 * 511)))) * 2 ** shift;
      shift -= 10;
    }
  return word;
}
function unpackRotation(word: number): Quat {
  const big = word >>> 30,
    c = [0, 0, 0, 0];
  let shift = 20,
    sum = 0;
  for (let i = 0; i < 4; i++)
    if (i !== big) {
      c[i] = ((((word >>> shift) & 1023) - 511) / 511) * Math.SQRT1_2;
      sum += c[i] * c[i];
      shift -= 10;
    }
  c[big] = Math.sqrt(Math.max(0, 1 - sum));
  const length = Math.hypot(c[0], c[1], c[2], c[3]); // above 1 only for words no encoder writes
  return [c[0] / length, c[1] / length, c[2] / length, c[3] / length];
}

/**
 * Schema-driven entity snapshots for the network: {@link EntityCodec.encode} writes only the entities and fields that
 * differ from a baseline (the last state the receiver acknowledged), {@link EntityCodec.decode} rebuilds the full state
 * from those bytes and the same baseline. Both ends build the codec from the same schema (field order is the key
 * order of the schema object). Positions round to 1/512 block (error <= 1/1024), rotations to smallest-three 32 bits.
 * Bytes: varint count, then per entity in id order: varint id offset (`id - previous id - 1`, the first from -1), a
 * varint field mask (bit i: schema field i follows; 0: the entity was removed), the set fields in schema order:
 * position three zigzag varints (steps from the baseline's, from 0 for a new entity), rotation u32, u8, u16, f32 (LE).
 *
 * ```ts
 * const codec = new EntityCodec({ position: 'position', rotation: 'rotation', health: 'u8' });
 * const bytes = codec.encode(players, acked); // Maps of entity id (u32) -> {position, rotation, health}
 * const state = codec.decode(bytes, received); // the receiver's copy of `acked`
 * ```
 */
export class EntityCodec<const S extends Readonly<Record<string, EntityField>>> {
  private readonly names: string[];
  private readonly types: EntityField[];
  /**
   * @throws TypeError when `schema` is not an object of field name -> {@link EntityField}.
   * @throws RangeError for a schema with no fields or more than 32.
   */
  constructor(schema: S) {
    if (!schema || typeof schema !== 'object')
      throw new TypeError("EntityCodec expects a schema object such as {position: 'position', health: 'u8'}");
    this.names = Object.keys(schema);
    this.types = this.names.map((name) => schema[name]);
    if (!this.names.length || this.names.length > 32)
      throw new RangeError(`EntityCodec schema has ${this.names.length} fields; use 1..32`);
    this.types.forEach((type, f) => {
      if (!FIELDS.includes(type))
        throw new TypeError(
          `EntityCodec field ${this.names[f]} must be ${FIELDS.map((t) => `'${t}'`).join(', ')}, not ${type}`,
        );
    });
  }
  /**
   * `entity` checked and quantized once, for a server that sends the same entity to many receivers: each
   * {@link EntityCodec.encode} that is given the result skips that work and writes the same bytes as for `entity`.
   * Later changes to `entity` do not reach the result; prepare again for a new state.
   * @throws as {@link EntityCodec.encode} for a malformed entity (`id` only names it in the message).
   */
  prepare(entity: EntityState<S>, id = 0): PreparedEntity {
    const token = Object.freeze({}) as PreparedEntity;
    prepared.set(token, { codec: this, fields: this.quantize(id, entity) });
    return token;
  }
  /**
   * The entities of `entities` that are new or differ from `baseline` (same id) in any field after quantizing,
   * with only their changed fields, plus the removal of each `baseline` entity `entities` lacks. Without a
   * baseline every entity is sent in full. Either Map may hold {@link EntityCodec.prepare} results instead of states.
   * @throws TypeError when `entities` or `baseline` is not a Map, an entity is not an object, a field has the
   * wrong type, or a prepared entity comes from another codec.
   * @throws RangeError for an id that is not a u32, a non-finite value, a position coordinate of 2,097,152 or more
   * in size, a zero-length rotation, or an integer out of its range.
   */
  encode(
    entities: ReadonlyMap<number, EntityState<S> | PreparedEntity>,
    baseline?: ReadonlyMap<number, EntityState<S> | PreparedEntity>,
  ): Uint8Array {
    if (!(entities instanceof Map) || (baseline !== undefined && !(baseline instanceof Map)))
      throw new TypeError('EntityCodec.encode expects Maps of entity id -> entity');
    const ids = new Set(entities.keys());
    if (baseline) for (const id of baseline.keys()) ids.add(id);
    for (const id of ids)
      if (id >>> 0 !== id)
        throw typeof id === 'number'
          ? new RangeError(`Entity id ${id} is not an integer in 0..4294967295; key entities by u32 ids`)
          : new TypeError('Entity ids must be numbers; key entities by u32 ids');
    const body = new ByteWriter();
    let previous = -1,
      count = 0;
    // Ids are u32s here, so a Uint32Array sorts them numerically.
    for (const id of new Uint32Array(ids).sort()) {
      const now = entities.has(id) ? this.fields(id, entities.get(id)) : undefined,
        then = baseline?.has(id) ? this.fields(id, baseline.get(id)) : undefined;
      let mask = 0;
      if (now)
        for (let f = 0; f < now.length; f++) {
          const a = now[f],
            b = then?.[f];
          let differs: boolean;
          if (Array.isArray(a)) {
            const c = b as number[] | undefined;
            differs = !c || a[0] !== c[0] || a[1] !== c[1] || a[2] !== c[2];
          } else differs = a !== b;
          if (differs) mask += 2 ** f;
        }
      if (now && !mask) continue;
      body.varint(id - previous - 1);
      body.varint(mask); // every field for a new entity, 0 for a removed one
      previous = id;
      count++;
      if (!now) continue;
      this.types.forEach((type, f) => {
        if (!((mask >>> f) & 1)) return;
        const v = now[f];
        if (type === 'position')
          for (let i = 0; i < 3; i++) body.varint(zigzag((v as number[])[i] - (then ? (then[f] as number[])[i] : 0)));
        else if (type === 'rotation') body.u32(v as number);
        else if (type === 'u8') body.u8(v as number);
        else if (type === 'u16') body.u16(v as number);
        else body.f32(v as number);
      });
    }
    const out = new ByteWriter(5 + body.at);
    out.varint(count);
    out.raw(body.bytes.subarray(0, body.at));
    return out.done();
  }
  /**
   * The full state: `baseline` (the receiver's copy of the baseline `bytes` were encoded against) with the entities
   * in `bytes` added, updated or removed. Unchanged entities and fields are `baseline`'s own values.
   * @throws TypeError when `bytes` is not a Uint8Array or `baseline` is not a Map.
   * @throws RangeError for truncated or trailing bytes, a count the bytes cannot hold, an id past 2^32 - 1, mask
   * bits past the schema, a non-finite f32, a position out of range, or an entity the baseline lacks that is
   * removed or not sent in full (decoded against the wrong baseline).
   */
  decode(bytes: Uint8Array, baseline?: ReadonlyMap<number, EntityState<S>>): Map<number, EntityState<S>> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('EntityCodec.decode expects a Uint8Array from encode');
    if (baseline !== undefined && !(baseline instanceof Map))
      throw new TypeError('EntityCodec.decode baseline must be a Map of entity id -> entity');
    const r = new ByteReader(bytes, 'Entity data', 'pass the bytes EntityCodec.encode returned'),
      n = r.varint(),
      out = new Map(baseline),
      full = 2 ** this.types.length - 1,
      wrong = 'decode against the baseline the bytes were encoded from';
    if (n > (bytes.length - r.at) / 2) throw r.fail(`lists ${n} entities in ${bytes.length} bytes`);
    let id = -1;
    for (let i = 0; i < n; i++) {
      id += r.varint() + 1;
      if (id > 0xffffffff) throw r.fail(`has entity id ${id}, past 4294967295`);
      const mask = r.varint(),
        base = baseline?.get(id) as Entity | undefined;
      if (mask > full) throw r.fail(`sets fields past the schema's ${this.types.length} for entity ${id}`);
      if (!base && mask !== full)
        throw r.fail(`${mask ? 'updates' : 'removes'} entity ${id}, which the baseline lacks`, wrong);
      if (!mask) {
        out.delete(id);
        continue;
      }
      const entity: Entity = { ...base };
      this.types.forEach((type, f) => {
        if (!((mask >>> f) & 1)) return;
        const name = this.names[f];
        if (type === 'position') {
          const from = base ? (this.value(id, name, type, base[name]) as number[]) : [0, 0, 0],
            p: MutableVec3 = [0, 0, 0];
          for (let k = 0; k < 3; k++) {
            const q = from[k] + unzigzag(r.varint());
            if (Math.abs(q) >= LIMIT) throw r.fail(`moves entity ${id} to ${q / STEPS}, out of range`);
            p[k] = q / STEPS;
          }
          entity[name] = p;
        } else if (type === 'rotation') entity[name] = unpackRotation(r.u32());
        else if (type === 'u8') entity[name] = r.u8();
        else if (type === 'u16') entity[name] = r.u16();
        else {
          const v = r.f32();
          if (!Number.isFinite(v)) throw r.fail(`has a non-finite ${name} for entity ${id}`);
          entity[name] = v;
        }
      });
      out.set(id, entity as EntityState<S>);
    }
    r.end();
    return out;
  }
  // Each field as it travels: position steps [x, y, z], the rotation word, or the number.
  // A prepared entity's fields, or the state quantized now.
  private fields(id: number, entity: unknown): Quantized {
    const ready = prepared.get(entity as object);
    if (!ready) return this.quantize(id, entity);
    if (ready.codec !== this)
      throw new TypeError(`Entity ${id} was prepared by another EntityCodec; prepare it with the one that encodes`);
    return ready.fields;
  }
  private quantize(id: number, entity: unknown): Quantized {
    if (!entity || typeof entity !== 'object') throw new TypeError(`Entity ${id} must be an object of its fields`);
    return this.names.map((name, f) => this.value(id, name, this.types[f], (entity as Entity)[name]));
  }
  private value(id: number, name: string, type: EntityField, v: unknown): number | number[] {
    const subject = `Entity ${id} ${name}`;
    if (type === 'position' || type === 'rotation') {
      const n = type === 'position' ? 3 : 4,
        list = v as ArrayLike<unknown>;
      if (
        !list ||
        typeof list !== 'object' ||
        list.length !== n ||
        !Array.from(list).every((c) => typeof c === 'number')
      )
        throw new TypeError(`${subject} must be ${n} numbers`);
      const c = list as ArrayLike<number>;
      if (type === 'rotation') {
        const length = Math.hypot(c[0], c[1], c[2], c[3]);
        if (!(length > 0 && length < Infinity)) throw new RangeError(`${subject} is not a rotation; pass a unit Quat`);
        return packRotation(c);
      }
      const q = [Math.round(c[0] * STEPS), Math.round(c[1] * STEPS), Math.round(c[2] * STEPS)];
      if (!q.every((s) => Math.abs(s) < LIMIT))
        throw new RangeError(`${subject} (${c[0]}, ${c[1]}, ${c[2]}) is out of range; keep |coordinates| < 2097152`);
      return q;
    }
    if (typeof v !== 'number') throw new TypeError(`${subject} must be a number`);
    if (type === 'f32') {
      const f = Math.fround(v);
      if (!Number.isFinite(f)) throw new RangeError(`${subject} ${v} is not a finite float32`);
      return f;
    }
    const max = type === 'u8' ? 255 : 65535;
    if (!Number.isInteger(v) || v < 0 || v > max)
      throw new RangeError(`${subject} ${v} is not an integer in 0..${max}`);
    return v;
  }
}
