// Baked navmeshes as bytes. Little-endian, with a CRC-32 (ISO 3309, the polynomial of PNG and zip) over the payload, so
// a truncated or damaged file is refused and not walked on. The layout is our own and is written out in the README.
import { MargoError } from '@margoengine/math/errors';
import { crc32 } from '../../shared/crc32.js';
import { NavMesh, type Vec3 } from './index.js';
import { TiledNavMesh, type TiledState } from './tiles.js';

const MAGIC = 0x56414e4d; // "MNAV"
const VERSION = 1;
const MESH = 0;
const TILED = 1;
const HEADER = 16;

/** Options of {@link encodeTiledNavMesh}. */
export interface TiledEncodeOptions {
  /**
   * Keep the level's triangles and obstacles, so the loaded mesh can still rebuild tiles. Without them the file is
   * smaller and the loaded mesh is fixed: changing it throws. Default false.
   */
  geometry?: boolean;
}

class Writer {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  at = HEADER;
  private room(size: number): void {
    if (this.at + size <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.at + size));
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
  u8(value: number): void {
    this.room(1);
    this.bytes[this.at++] = value;
  }
  /** A whole number of 0 or more, seven bits a byte. */
  count(value: number): void {
    while (value >= 128) {
      this.u8((value % 128) | 128);
      value = Math.floor(value / 128);
    }
    this.u8(value);
  }
  /** A whole number of either sign. */
  int(value: number): void {
    this.count(value < 0 ? -2 * value - 1 : 2 * value);
  }
  f64(value: number): void {
    this.room(8);
    this.view.setFloat64(this.at, value, true);
    this.at += 8;
  }
  point(value: readonly number[]): void {
    this.f64(value[0]);
    this.f64(value[1]);
    this.f64(value[2]);
  }
  raw(value: Uint8Array): void {
    this.count(value.length);
    this.room(value.length);
    this.bytes.set(value, this.at);
    this.at += value.length;
  }
  finish(kind: number): Uint8Array {
    const payload = this.bytes.subarray(HEADER, this.at);
    this.view.setUint32(0, MAGIC, true);
    this.view.setUint16(4, VERSION, true);
    this.view.setUint16(6, kind, true);
    this.view.setUint32(8, payload.length, true);
    this.view.setUint32(12, crc32(payload), true);
    return this.bytes.slice(0, this.at);
  }
}

const refuse = (why: string): never => {
  throw new MargoError(
    'failed',
    `This is not a navmesh file Margo can read: ${why}; bake it again with encodeNavMesh.`,
  );
};

class Reader {
  private at = HEADER;
  private readonly view: DataView;
  constructor(
    private readonly bytes: Uint8Array,
    kind: number,
  ) {
    if (!(bytes instanceof Uint8Array))
      throw new TypeError('Navmesh data must be a Uint8Array; pass the bytes encodeNavMesh gave.');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < HEADER || this.view.getUint32(0, true) !== MAGIC) refuse('the file does not start with MNAV');
    if (this.view.getUint16(4, true) !== VERSION) refuse(`format version ${this.view.getUint16(4, true)}`);
    if (this.view.getUint16(6, true) !== kind)
      refuse(kind === MESH ? 'it holds a tiled mesh' : 'it holds a single mesh');
    const size = this.view.getUint32(8, true);
    if (bytes.length !== HEADER + size) refuse(`${HEADER + size} bytes were expected, ${bytes.length} came`);
    if (crc32(bytes.subarray(HEADER)) !== this.view.getUint32(12, true)) refuse('the checksum does not match');
  }
  private need(size: number): void {
    if (this.at + size > this.bytes.length) refuse('it ends early');
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.at++];
  }
  count(): number {
    let value = 0,
      scale = 1;
    for (;;) {
      const byte = this.u8();
      value += (byte & 127) * scale;
      if (byte < 128) return value;
      scale *= 128;
      if (scale > 2 ** 53) refuse('a number is too long');
    }
  }
  int(): number {
    const value = this.count();
    return value % 2 ? -(value + 1) / 2 : value / 2;
  }
  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.at, true);
    this.at += 8;
    return value;
  }
  point(): [number, number, number] {
    return [this.f64(), this.f64(), this.f64()];
  }
  raw(): Uint8Array {
    const size = this.count();
    this.need(size);
    const value = this.bytes.subarray(this.at, this.at + size);
    this.at += size;
    return value;
  }
}

function writeMesh(out: Writer, mesh: NavMesh, links: boolean): void {
  out.count(mesh.vertices.length);
  for (const v of mesh.vertices) out.point(v as unknown as number[]);
  const count = mesh.polygonCount;
  out.count(count);
  for (let p = 0; p < count; p++) {
    const vertices = mesh.polygonVertices(p);
    out.count(vertices.length);
    for (const v of vertices) out.count(v);
    out.u8(mesh.polygonArea(p));
  }
  const costs: number[] = [];
  for (let p = 0; p < count; p++) if (mesh.areaCost(p) !== 1) costs.push(p);
  out.count(costs.length);
  for (const p of costs) {
    out.count(p);
    out.f64(mesh.areaCost(p));
  }
  if (!links) return;
  // A two-way link is two entries; the first one seen carries it and the second marks it two-way.
  const seen = new Map<number, { start: Vec3; end: Vec3; cost: number; both: boolean }>();
  for (let p = 0; p < count; p++)
    for (const link of mesh.polygonLinks(p)) {
      if (link.offMesh === undefined) continue;
      const known = seen.get(link.offMesh);
      if (known) known.both = true;
      else seen.set(link.offMesh, { start: link.start!, end: link.end!, cost: link.cost!, both: false });
    }
  out.count(seen.size);
  for (const { start, end, cost, both } of seen.values()) {
    out.point(start as unknown as number[]);
    out.point(end as unknown as number[]);
    out.f64(cost);
    out.u8(both ? 1 : 0);
  }
}

/** Reads a checked file; whatever its numbers then break, the answer is that it is not a navmesh file. */
function parse<T>(input: Reader, read: (input: Reader) => T): T {
  try {
    return read(input);
  } catch (error) {
    if (error instanceof MargoError) throw error;
    return refuse((error as Error).message);
  }
}

function readMesh(input: Reader, links: boolean): NavMesh {
  const vertexCount = input.count(),
    vertices: Vec3[] = [];
  for (let i = 0; i < vertexCount; i++) vertices.push(input.point());
  const count = input.count(),
    polygons: number[][] = [],
    areas = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    const size = input.count(),
      polygon: number[] = [];
    for (let i = 0; i < size; i++) polygon.push(input.count());
    polygons.push(polygon);
    areas[p] = input.u8();
  }
  const mesh = new NavMesh(vertices, polygons);
  areas.forEach((area, p) => area && mesh.setPolygonArea(p, area));
  for (let i = input.count(); i > 0; i--) {
    const polygon = input.count();
    mesh.setAreaCost(polygon, input.f64());
  }
  if (links)
    for (let i = input.count(); i > 0; i--) {
      const start = input.point(),
        end = input.point(),
        cost = input.f64();
      mesh.addOffMeshLink(start, end, { cost, bidirectional: input.u8() === 1 });
    }
  return mesh;
}

/**
 * Bakes a `NavMesh` to bytes: vertices, polygons, area numbers, area costs and off-mesh links. Numbers keep every bit,
 * so routes on the loaded mesh are the same routes. Off-mesh link ids are given anew on load.
 */
export function encodeNavMesh(mesh: NavMesh): Uint8Array {
  const out = new Writer();
  writeMesh(out, mesh, true);
  return out.finish(MESH);
}

/**
 * Loads bytes from {@link encodeNavMesh}.
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws MargoError `failed` for a file that is damaged, cut short, of another version or another kind.
 */
export function decodeNavMesh(bytes: Uint8Array): NavMesh {
  return parse(new Reader(bytes, MESH), (input) => readMesh(input, true));
}

/**
 * Bakes a `TiledNavMesh` to bytes: each tile's polygons and the off-mesh links, and with `geometry` the level, so tiles
 * can rebuild after loading. Waiting tiles are saved as they stand, and stay waiting when the level is kept.
 */
export function encodeTiledNavMesh(world: TiledNavMesh, options: TiledEncodeOptions = {}): Uint8Array {
  const out = new Writer(),
    state = world.snapshot(options.geometry ?? false);
  out.raw(new TextEncoder().encode(JSON.stringify(state.settings)));
  out.point(state.origin as unknown as number[]);
  out.count(state.nextId);
  out.count(state.tiles.length);
  for (const { x, z, mesh, rise } of state.tiles) {
    out.int(x);
    out.int(z);
    out.f64(rise);
    writeMesh(out, mesh, false);
  }
  out.count(state.pending.length);
  for (const [x, z] of state.pending) {
    out.int(x);
    out.int(z);
  }
  out.count(state.links.length);
  for (const { id, start, end, cost, bidirectional } of state.links) {
    out.count(id);
    out.point(start as unknown as number[]);
    out.point(end as unknown as number[]);
    out.f64(cost);
    out.u8(bidirectional ? 1 : 0);
  }
  out.u8(state.level ? 1 : 0);
  if (state.level) {
    out.count(state.level.obstacles.length);
    for (const { id, box } of state.level.obstacles) {
      out.count(id);
      out.point(box.min as unknown as number[]);
      out.point(box.max as unknown as number[]);
    }
    out.count(state.level.geometry.length);
    for (const { id, points, triangles } of state.level.geometry) {
      out.count(id);
      out.raw(new Uint8Array(points.buffer, points.byteOffset, points.byteLength));
      out.raw(new Uint8Array(triangles.buffer, triangles.byteOffset, triangles.byteLength));
    }
  }
  return out.finish(TILED);
}

function readTiled(input: Reader): TiledNavMesh {
  const settings = JSON.parse(new TextDecoder().decode(input.raw())) as TiledState['settings'],
    origin = input.point(),
    world = new TiledNavMesh([], [], { ...settings, origin, deferred: true }),
    nextId = input.count(),
    tiles: TiledState['tiles'] = [],
    pending: TiledState['pending'] = [],
    links: TiledState['links'] = [];
  for (let i = input.count(); i > 0; i--) {
    const x = input.int(),
      z = input.int(),
      rise = input.f64();
    tiles.push({ x, z, rise, mesh: readMesh(input, false) });
  }
  for (let i = input.count(); i > 0; i--) pending.push([input.int(), input.int()]);
  for (let i = input.count(); i > 0; i--) {
    const id = input.count(),
      start = input.point(),
      end = input.point(),
      cost = input.f64();
    links.push({ id, start, end, cost, bidirectional: input.u8() === 1 });
  }
  let level: TiledState['level'] = null;
  if (input.u8()) {
    level = { obstacles: [], geometry: [] };
    for (let i = input.count(); i > 0; i--)
      level.obstacles.push({ id: input.count(), box: { min: input.point(), max: input.point() } });
    for (let i = input.count(); i > 0; i--) {
      const id = input.count();
      // Copied, since a typed array over the file need not be aligned.
      level.geometry.push({
        id,
        points: new Float32Array(input.raw().slice().buffer),
        triangles: new Uint32Array(input.raw().slice().buffer),
      });
    }
  }
  world.restore({ settings, origin, nextId, tiles, pending, links, level });
  return world;
}

/**
 * Loads bytes from {@link encodeTiledNavMesh}. A mesh baked without `geometry` answers every query, takes off-mesh links
 * and throws when asked to change its level.
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws MargoError `failed` for a file that is damaged, cut short, of another version or another kind.
 */
export function decodeTiledNavMesh(bytes: Uint8Array): TiledNavMesh {
  return parse(new Reader(bytes, TILED), readTiled);
}
