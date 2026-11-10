import type { ComponentStore, Entity, NumericArray, World } from './index.js';
import { byteLimit, decodeGraph, encodeGraph, transform, type SnapshotOptions } from './serialize-codec.js';
export type { SnapshotOptions, SnapshotValueCodec } from './serialize-codec.js';

/** Restore options. Entity mappings translate remote ids without resurrecting stale local handles. */
export interface SnapshotRestoreOptions extends SnapshotOptions {
  /** Mapping returned by the previous restore. Default identity for the world's current ids. */
  entities?: ReadonlyMap<Entity, Entity>;
}
type Columns = Record<string, NumericArray | unknown[]>;
type ComponentImage = { name: string; entities: number[]; fields: Columns };
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
type Image = { littleEndian: boolean; version: number; entities: number[]; components: ComponentImage[] };
const numeric = [Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array];
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
function bad(): never {
  throw new TypeError('Invalid ECS snapshot or schema; use a complete version-1 packet with matching named components');
}
function ids(world: World): number[] {
  const out = new Uint32Array(world.capacity);
  return [...out.subarray(0, world.entities(out))].sort((a, b) => a - b);
}
function columns(c: ComponentStore): Columns {
  return c.fields as Columns;
}
function validId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}
function uniqueIds(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(validId) && new Set(v).size === v.length;
}
async function pack(text: string, kind: number, options: SnapshotOptions): Promise<Uint8Array> {
  const raw = encoder.encode(text),
    limit = byteLimit(options);
  if (raw.length > limit) throw new RangeError('Snapshot text exceeds byte limit; raise maxBytes deliberately');
  const zipped = await transform(raw, false, options),
    out = new Uint8Array(zipped.length + 4);
  if (out.length > limit) throw new RangeError('Snapshot packet exceeds byte limit; raise maxBytes deliberately');
  out.set([69, 67, kind, 49]);
  out.set(zipped, 4);
  return out;
}
async function unpack(packet: Uint8Array, kind: number, options: SnapshotOptions): Promise<string> {
  options.signal?.throwIfAborted();
  if (
    !(packet instanceof Uint8Array) ||
    packet.length > byteLimit(options) ||
    packet.length < 5 ||
    packet[0] !== 69 ||
    packet[1] !== 67 ||
    packet[2] !== kind ||
    packet[3] !== 49
  )
    return bad();
  return decoder.decode(await transform(packet.subarray(4), true, options));
}
/** Binary snapshots of named components and entity lifetime, independent of save or rendering packages. */
export class WorldSerializer {
  private readonly stores: [string, ComponentStore][];
  /** @throws TypeError for empty selection, foreign stores, unsupported fields or duplicate codec names. */
  constructor(
    readonly world: World,
    components: Readonly<Record<string, ComponentStore>>,
  ) {
    this.stores = Object.entries(components).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (
      !this.stores.length ||
      this.stores.some(
        ([, c]) =>
          c.world !== world ||
          Object.values(columns(c)).some((f) => !Array.isArray(f) && !numeric.some((T) => f instanceof T)),
      )
    )
      return bad();
  }
  /** Capture chosen fields, shared reference graphs, all live entity ids and component membership. */
  async snapshot(options: SnapshotOptions = {}): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const live = ids(this.world),
      alive = new Set(live);
    const components = this.stores.map(([name, c]) => {
      const entities = [...c.entities.subarray(0, c.size)].filter((e) => alive.has(e)).sort((a, b) => a - b);
      const fields: Columns = {};
      for (const key of Object.keys(columns(c)).sort()) {
        const column = columns(c)[key];
        let data: NumericArray | unknown[];
        if (Array.isArray(column)) data = entities.map((e) => column[c.index(e)]);
        else {
          if ((column instanceof Float32Array || column instanceof Float64Array) && !column.every(Number.isFinite))
            throw new RangeError(
              'Nonfinite numeric component data; keep numeric fields finite as required by Component.add',
            );
          const T = column.constructor as new (length: number) => NumericArray;
          data = new T(entities.length);
          const width = column.BYTES_PER_ELEMENT,
            bytes = new Uint8Array(data.buffer);
          entities.forEach((e, i) =>
            bytes.set(new Uint8Array(column.buffer, column.byteOffset + c.index(e) * width, width), i * width),
          );
        }
        Object.defineProperty(fields, key, { value: data, enumerable: true });
      }
      return { name, entities, fields };
    });
    return pack(encodeGraph({ version: 1, littleEndian, entities: live, components }, options.codecs), 83, options);
  }
  /**
   * Validate the complete packet before changing membership, then restore selected fields and entity lifetime.
   * Surviving entities retain unselected components. Removed entities are destroyed. New entities get safe local ids.
   * Return a fresh remote-to-local map for later snapshots/deltas and app-owned entity-reference fields.
   * Observer exceptions propagate after their underlying mutation, as with Component.add.
   * @throws TypeError for malformed packets, incompatible schemas, invalid mappings or unsupported values.
   * @throws RangeError for byte limits, graph limits or insufficient entity capacity, before entity mutation.
   */
  async restore(packet: Uint8Array, options: SnapshotRestoreOptions = {}): Promise<Map<Entity, Entity>> {
    const value = decodeGraph(await unpack(packet, 83, options), options.codecs);
    if (!value || typeof value !== 'object') return bad();
    const image = value as Image;
    if (
      image.version !== 1 ||
      image.littleEndian !== littleEndian ||
      !uniqueIds(image.entities) ||
      !Array.isArray(image.components) ||
      image.components.length !== this.stores.length
    )
      return bad();
    const remote = new Set(image.entities),
      names = new Set<string>();
    for (const entry of image.components) {
      if (
        !entry ||
        typeof entry.name !== 'string' ||
        names.has(entry.name) ||
        !uniqueIds(entry.entities) ||
        entry.entities.some((e) => !remote.has(e)) ||
        !entry.fields ||
        typeof entry.fields !== 'object'
      )
        return bad();
      names.add(entry.name);
      const store = this.stores.find(([name]) => name === entry.name)?.[1];
      if (!store) return bad();
      const fields = columns(store),
        keys = Object.keys(fields).sort();
      if (JSON.stringify(Object.keys(entry.fields).sort()) !== JSON.stringify(keys)) return bad();
      for (const key of keys) {
        const actual = entry.fields[key],
          expected = fields[key];
        if (Array.isArray(expected) ? !Array.isArray(actual) : !actual || actual.constructor !== expected.constructor)
          return bad();
        if (actual.length !== entry.entities.length) return bad();
        if ((actual instanceof Float32Array || actual instanceof Float64Array) && !actual.every(Number.isFinite))
          return bad();
      }
    }
    if (image.entities.length > this.world.stride)
      throw new RangeError('Snapshot entity count exceeds world capacity limit; restore into a larger world');
    const prior = new Map(options.entities ?? ids(this.world).map((e) => [e, e] as const));
    if (
      [...prior].some(([remote, local]) => !validId(remote) || !validId(local)) ||
      new Set(prior.values()).size !== prior.size
    )
      return bad();
    const removed = [...prior]
      .filter(([e, local]) => !remote.has(e) && this.world.alive(local))
      .map(([, local]) => local);
    const mapped = new Set(prior.values());
    for (const local of ids(this.world)) if (!mapped.has(local)) removed.push(local);
    const births = image.entities.filter((e) => !prior.has(e) || !this.world.alive(prior.get(e)!));
    const reusable = removed.filter(
      (e) => (Math.floor(e / this.world.stride) + 1) * this.world.stride + (e % this.world.stride) <= 0xffffffff,
    ).length;
    this.world.reserve(Math.max(0, births.length - reusable));
    options.signal?.throwIfAborted();
    for (const local of removed) this.world.destroy(local);
    const result = new Map<Entity, Entity>();
    for (const e of image.entities) {
      const local = prior.get(e);
      result.set(e, local !== undefined && this.world.alive(local) ? local : this.world.create());
    }
    for (const entry of image.components) {
      const store = this.stores.find(([name]) => name === entry.name)![1],
        keep = new Set(entry.entities.map((e) => result.get(e)!));
      for (const e of [...store.entities.subarray(0, store.size)]) if (!keep.has(e)) store.remove(e);
      entry.entities.forEach((e, i) => {
        const values: Record<string, unknown> = {};
        for (const [key, column] of Object.entries(entry.fields))
          Object.defineProperty(values, key, { value: column[i], enumerable: true });
        store.add(result.get(e)!, values);
      });
    }
    return result;
  }
}
async function fingerprint(text: string, options: SnapshotOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  options.signal?.throwIfAborted();
  return hash.toHex();
}
/** Create a baseline-checked binary delta, comparing fixed 256-character blocks using native string comparisons. */
export async function createDelta(
  before: Uint8Array,
  after: Uint8Array,
  options: SnapshotOptions = {},
): Promise<Uint8Array> {
  const a = await unpack(before, 83, options),
    b = await unpack(after, 83, options);
  const patches: [number, string][] = [];
  for (let at = 0; at < b.length; at += 256) {
    const part = b.slice(at, at + 256);
    if (part !== a.slice(at, at + 256)) patches.push([at, part]);
  }
  const base = await fingerprint(a, options),
    target = await fingerprint(b, options);
  const delta = { base, target, length: b.length, patches },
    full = { base, target, length: b.length, full: b };
  const incremental = JSON.stringify(delta),
    replacement = JSON.stringify(full);
  return pack(incremental.length <= replacement.length ? incremental : replacement, 68, options);
}
/**
 * Apply a delta to its exact baseline and return a complete snapshot. Both fingerprints are checked.
 * For undo, createDelta(after,before) creates the inverse. No world mutation occurs here.
 * @throws TypeError for corrupt, out-of-order or wrong-baseline deltas.
 */
export async function applyDelta(
  before: Uint8Array,
  delta: Uint8Array,
  options: SnapshotOptions = {},
): Promise<Uint8Array> {
  const a = await unpack(before, 83, options),
    d = JSON.parse(await unpack(delta, 68, options)) as {
      base?: unknown;
      target?: unknown;
      length?: unknown;
      full?: unknown;
      patches?: unknown;
    };
  if (
    !d ||
    typeof d !== 'object' ||
    d.base !== (await fingerprint(a, options)) ||
    typeof d.target !== 'string' ||
    typeof d.length !== 'number' ||
    !Number.isInteger(d.length) ||
    d.length < 0 ||
    d.length > byteLimit(options)
  )
    return bad();
  let b: string;
  if (typeof d.full === 'string' && d.patches === undefined) b = d.full;
  else if (Array.isArray(d.patches) && d.full === undefined) {
    const parts = Array.from({ length: Math.ceil(d.length / 256) }, (_, i) =>
      a.slice(i * 256, Math.min(i * 256 + 256, d.length as number)),
    );
    let previous = -1;
    for (const patch of d.patches) {
      if (
        !Array.isArray(patch) ||
        patch.length !== 2 ||
        !Number.isInteger(patch[0]) ||
        patch[0] <= previous ||
        patch[0] < 0 ||
        patch[0] >= d.length ||
        patch[0] % 256 !== 0 ||
        typeof patch[1] !== 'string' ||
        patch[1].length !== Math.min(256, d.length - patch[0])
      )
        return bad();
      previous = patch[0];
      parts[patch[0] / 256] = patch[1];
    }
    b = parts.join('');
  } else return bad();
  if (b.length !== d.length || (await fingerprint(b, options)) !== d.target) return bad();
  return pack(b, 83, options);
}
