// Point caches: PC2 and MDD, the plain vertex-per-frame files that DCC tools write. Neither holds triangles, so a cache
// fits a mesh the caller already has: hand `positions` and that mesh's indices to `encodeGeometryCache`.
import { MargoError } from '@margoengine/math/errors';

const PC2_MAGIC = 'POINTCACHE2\0',
  PC2_HEADER = 32,
  MDD_HEADER = 8;

/** Options of {@link parsePointCache}. */
export interface PointCacheOptions {
  /** Frames per second for a PC2 file, which does not say. Default 24. An MDD file's own times win. */
  fps?: number;
  /** Turn a Z-up file to Y-up, as `(x, z, -y)`. Default false: the file's axes as written. */
  zUp?: boolean;
  /** Refuses a file holding more floats than this. Default 1 GiB of them. */
  maxFloats?: number;
}

/** A point cache read whole. `frameCount` and `positions` fit a chunk of `encodeGeometryCache`. */
export interface PointCache {
  format: 'pc2' | 'mdd';
  /** Frames per second. */
  rate: number;
  frameCount: number;
  vertexCount: number;
  /** Seconds of each frame: the file's for MDD, from its start frame and `fps` for PC2. */
  times: Float32Array;
  /** `frameCount` frames of `vertexCount` vertices, three floats each. */
  positions: Float32Array;
}

const bad = (what: string) => new MargoError('failed', `Point cache ${what}; export the file again`);

function floats(view: DataView, at: number, count: number, little: boolean): Float32Array {
  const out = new Float32Array(count);
  for (let n = 0; n < count; n++) out[n] = view.getFloat32(at + n * 4, little);
  return out;
}

/**
 * The float count a header claims, checked against `room`, the bytes the file holds for them, before `limit`: an MDD
 * file has no magic, so any other file reads as an MDD header, and the limit's advice fits only a real file.
 */
function sizes(frames: number, vertices: number, limit: number, room: number): number {
  if (!Number.isInteger(frames) || !Number.isInteger(vertices) || frames < 1 || vertices < 1)
    throw bad('has no frames or no vertices');
  const count = frames * vertices * 3;
  if (count * 4 > room)
    throw bad(`is cut off or is not a PC2 or MDD file: its header asks for ${frames} frames of ${vertices} vertices, more than it holds`);
  if (count > limit) throw new MargoError('failed', `Point cache holds ${count} floats, over maxFloats ${limit}; raise maxFloats or export fewer frames`);
  return count;
}

function readPC2(view: DataView, fps: number, limit: number): PointCache {
  if (view.byteLength < PC2_HEADER) throw bad('stops inside its header');
  const version = view.getInt32(12, true),
    vertexCount = view.getInt32(16, true),
    start = view.getFloat32(20, true),
    step = view.getFloat32(24, true),
    frameCount = view.getInt32(28, true);
  if (version !== 1) throw new MargoError('unsupported', `PC2 version ${version} is not read; export version 1`);
  const count = sizes(frameCount, vertexCount, limit, view.byteLength - PC2_HEADER);
  if (!(step > 0)) throw bad('has a sample rate of 0 or less');
  const times = new Float32Array(frameCount);
  for (let n = 0; n < frameCount; n++) times[n] = (start + n * step) / fps;
  return {
    format: 'pc2',
    rate: fps / step,
    frameCount,
    vertexCount,
    times,
    positions: floats(view, PC2_HEADER, count, true),
  };
}

function readMDD(view: DataView, fps: number, limit: number): PointCache {
  if (view.byteLength < MDD_HEADER) throw bad('stops inside its header');
  const frameCount = view.getInt32(0, false),
    vertexCount = view.getInt32(4, false),
    first = MDD_HEADER + frameCount * 4,
    count = sizes(frameCount, vertexCount, limit, view.byteLength - first);
  const times = floats(view, MDD_HEADER, frameCount, false),
    span = times[frameCount - 1]! - times[0]!;
  for (let n = 1; n < frameCount; n++) if (!(times[n]! > times[n - 1]!)) throw bad('has times that do not rise');
  return {
    format: 'mdd',
    rate: span > 0 ? (frameCount - 1) / span : fps,
    frameCount,
    vertexCount,
    times,
    positions: floats(view, first, count, false),
  };
}

/**
 * Reads a PC2 (Point Cache 2, little endian) or MDD (big endian) file. To play one, give it the triangles of its mesh:
 * `encodeGeometryCache(cache.rate, [{ frameCount: cache.frameCount, positions: cache.positions, indices }])`.
 *
 * @throws MargoError code `failed` for a cut or empty file or one over `maxFloats`, `unsupported` for another PC2 version.
 */
export function parsePointCache(bytes: Uint8Array, options: PointCacheOptions = {}): PointCache {
  const { fps = 24, zUp = false, maxFloats = 2 ** 28 } = options;
  if (!(fps > 0 && Number.isFinite(fps))) throw new RangeError('Invalid fps; pass a frame rate above 0');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    head = String.fromCharCode(...bytes.subarray(0, PC2_MAGIC.length)),
    cache = head === PC2_MAGIC ? readPC2(view, fps, maxFloats) : readMDD(view, fps, maxFloats);
  if (zUp) {
    const p = cache.positions;
    for (let n = 0; n < p.length; n += 3) {
      const y = p[n + 1]!;
      p[n + 1] = p[n + 2]!;
      p[n + 2] = -y;
    }
  }
  return cache;
}
