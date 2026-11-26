// Tilt Brush / Open Brush .tilt sketches: the brush strokes as flat ribbons. Written from the public Open Brush file
// format notes (docs.openbrush.app/developer-notes/open-brush-file-format) and the Tilt Brush 23 release notes.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { checkCount, floats, limits, throwIfAborted, toBytes, uints, type BinaryInput } from './util.js';
import { readZipDirectory, readZipEntry, type ZipOptions } from './zip.js';

const F = 'TILT';

/** Options of {@link parseTilt}. */
export interface TiltOptions extends ParseLimits, Pick<ZipOptions, 'maxEntries' | 'maxEntryBytes' | 'maxRatio'> {
  /**
   * Metres per sketch unit. Default 0.1: Tilt Brush sketches are drawn in decimetres. The brush size scales with it.
   */
  scale?: number;
  /**
   * Convert from Tilt Brush's left-handed Y-up space to the right-handed Y-up space of glTF and the engine, by
   * mirroring Z and reversing the triangle winding to match. Default true.
   */
  rightHanded?: boolean;
  /** Ribbon width multiplier, over `brushSize * pressure`. Default 1. */
  widthScale?: number;
  /** Skip strokes with fewer control points than this. Default 2. */
  minControlPoints?: number;
  signal?: AbortSignal;
}

/** One stroke of a sketch, as stored. */
export interface TiltStroke {
  /** Index into {@link LoadedTilt.brushes}. */
  brushIndex: number;
  /** The brush GUID from `metadata.json`'s `BrushIndex`, when the file has one. */
  brush?: string;
  /** RGBA in [0,1]. */
  color: [number, number, number, number];
  /** Brush size in sketch units. */
  size: number;
  /** Control points: position xyz, orientation quaternion xyzw (the controller's), pressure (1 when absent) and timestamp in ms (0 when absent). */
  points: { position: [number, number, number]; orientation: [number, number, number, number]; pressure: number; timestamp: number }[];
}

/** The result of {@link parseTilt}. */
export interface LoadedTilt {
  /** All strokes as flat ribbons: one group per drawn stroke, with the stroke's colour and `properties.brushIndex`. Draw it double-sided. */
  geometry: LoadedGeometry;
  /** Every stroke as stored, in sketch space, before scale and handedness. */
  strokes: TiltStroke[];
  /** The `BrushIndex` GUIDs of `metadata.json`, empty when absent. */
  brushes: string[];
  /** The parsed `metadata.json`, when the archive has one. */
  metadata?: Record<string, unknown>;
  /** The `data.sketch` version. */
  version: number;
}

const rotate = (q: number[], v: number[]): [number, number, number] => {
  // v + 2w(q x v) + 2 q x (q x v)
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

/** Reads `data.sketch` itself (the stroke stream), for callers that already unzipped the `.tilt`. */
export function parseTiltSketch(input: BinaryInput, options: TiltOptions = {}): { strokes: TiltStroke[]; version: number } {
  const bytes = toBytes(input, F),
    limit = limits(options, F),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const need = (n: number, what: string): void => {
    if (n < 0 || p + n > bytes.length) throw new LoaderError(F, 'truncated', `data.sketch ends inside ${what}`);
  };
  const u32 = (what: string): number => (need(4, what), (p += 4), view.getUint32(p - 4, true));
  const i32 = (what: string): number => (need(4, what), (p += 4), view.getInt32(p - 4, true));
  const f32 = (what: string): number => (need(4, what), (p += 4), view.getFloat32(p - 4, true));
  u32('the sentinel');
  const version = u32('the version');
  u32('the reserved word');
  const extra = u32('the additional header size');
  need(extra, 'the additional header');
  p += extra;
  const strokeCount = checkCount(i32('the stroke count'), 4_000_000, F, 'stroke');
  const strokes: TiltStroke[] = [];
  let totalPoints = 0;
  for (let s = 0; s < strokeCount; s++) {
    throwIfAborted(options.signal, F);
    const brushIndex = i32('a stroke'),
      color: [number, number, number, number] = [f32('a colour'), f32('a colour'), f32('a colour'), f32('a colour')],
      size = f32('a brush size'),
      strokeMask = u32('a stroke mask'),
      pointMask = u32('a control point mask');
    // Stroke extensions: a 4-byte value per low bit, a size-prefixed blob per high bit. None is needed for ribbons.
    for (let bit = 0; bit < 32; bit++) {
      if (!(strokeMask >>> bit & 1)) continue;
      if (bit < 16) (need(4, 'a stroke extension'), (p += 4));
      else {
        const n = u32('a stroke extension size');
        need(n, 'a stroke extension');
        p += n;
      }
    }
    const count = checkCount(i32('a control point count'), limit.maxVertices, F, 'control point');
    totalPoints += count;
    if (totalPoints > limit.maxVertices)
      throw new LoaderError(F, 'limit', `control points exceed the limit of ${limit.maxVertices}`);
    // Control point extensions: bit 0 pressure (float), bit 1 timestamp (uint32); any other low bit is one 4-byte value
    // and a high bit a size-prefixed blob, skipped.
    let stride = 28;
    for (let bit = 0; bit < 16; bit++) if (pointMask >>> bit & 1) stride += 4;
    if (pointMask >>> 16 !== 0)
      throw new LoaderError(F, 'unsupported', 'control point extensions with a size prefix are not supported');
    need(count * stride, 'control points');
    const points: TiltStroke['points'] = [];
    for (let i = 0; i < count; i++) {
      const position: [number, number, number] = [f32(''), f32(''), f32('')],
        orientation: [number, number, number, number] = [f32(''), f32(''), f32(''), f32('')];
      let pressure = 1,
        timestamp = 0;
      for (let bit = 0; bit < 16; bit++) {
        if (!(pointMask >>> bit & 1)) continue;
        if (bit === 0) pressure = f32('');
        else if (bit === 1) timestamp = u32('');
        else p += 4;
      }
      points.push({ position, orientation, pressure, timestamp });
    }
    strokes.push({ brushIndex, color, size, points });
  }
  return { strokes, version };
}

/**
 * Parses a `.tilt` file (a zip with a 16-byte header in front: `data.sketch` and `metadata.json`) into ribbons.
 * A ribbon runs along a stroke's control points; its width is `size * pressure * widthScale` along the controller's
 * local X axis, its normal is across it, and every vertex carries the stroke colour.
 */
export async function parseTilt(input: BinaryInput, options: TiltOptions = {}): Promise<LoadedTilt> {
  throwIfAborted(options.signal, F);
  const bytes = toBytes(input, F),
    scale = options.scale ?? 0.1,
    widthScale = options.widthScale ?? 1,
    minPoints = options.minControlPoints ?? 2,
    right = options.rightHanded ?? true;
  if (!(scale > 0) || !(widthScale >= 0) || !Number.isFinite(scale))
    throw new LoaderError(F, 'range', 'scale must be positive and widthScale not negative');
  const limit = limits(options, F);
  // The archive follows the 16-byte header. Zip offsets are relative to the zip's own start in most writers and to the
  // file's in some, so try the stripped bytes first and the whole file second.
  const hasHeader = bytes.length >= 16 && bytes[0] === 0x74 && bytes[1] === 0x69 && bytes[2] === 0x6c && bytes[3] === 0x54;
  const attempts = hasHeader
    ? [bytes.subarray(new DataView(bytes.buffer, bytes.byteOffset).getUint16(4, true) || 16), bytes]
    : [bytes];
  let sketch: Uint8Array | undefined, meta: Uint8Array | undefined, lastError: unknown;
  for (const archive of attempts) {
    try {
      const entries = readZipDirectory(archive, options),
        find = (name: string) => entries.find((e) => e.name === name || e.name.endsWith(`/${name}`));
      const dataEntry = find('data.sketch');
      if (!dataEntry) throw new LoaderError(F, 'zip', 'the archive has no data.sketch');
      sketch = await readZipEntry(archive, dataEntry, options);
      const metaEntry = find('metadata.json');
      meta = metaEntry ? await readZipEntry(archive, metaEntry, options) : undefined;
      break;
    } catch (error) {
      lastError = error;
      if (error instanceof LoaderError && error.code === 'aborted') throw error;
    }
  }
  if (!sketch) throw lastError;
  let metadata: Record<string, unknown> | undefined;
  if (meta) {
    try {
      metadata = JSON.parse(new TextDecoder().decode(meta));
    } catch {
      throw new LoaderError(F, 'syntax', 'metadata.json is not valid JSON');
    }
  }
  const brushes = Array.isArray(metadata?.BrushIndex) ? (metadata!.BrushIndex as unknown[]).map(String) : [];
  const { strokes, version } = parseTiltSketch(sketch, options);

  const positions = floats(),
    normals = floats(),
    colors = floats(),
    indices = uints(),
    groups: LoadedGroup[] = [];
  let vertex = 0;
  for (const stroke of strokes) {
    stroke.brush = brushes[stroke.brushIndex];
    const pts = stroke.points;
    if (pts.length < minPoints || pts.length < 2) continue;
    if (vertex + pts.length * 2 > limit.maxVertices)
      throw new LoaderError(F, 'limit', `ribbon vertices exceed the limit of ${limit.maxVertices}`);
    const start = indices.length;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(i - 1, 0)].position,
        b = pts[Math.min(i + 1, pts.length - 1)].position,
        tangent = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        side = rotate(pts[i].orientation, [1, 0, 0]),
        half = (stroke.size * pts[i].pressure * widthScale * scale) / 2;
      // Normal across the ribbon: right x tangent, or the controller's up when the stroke stands still.
      let n = [
        side[1] * tangent[2] - side[2] * tangent[1],
        side[2] * tangent[0] - side[0] * tangent[2],
        side[0] * tangent[1] - side[1] * tangent[0],
      ];
      const length = Math.hypot(n[0], n[1], n[2]);
      n = length > 1e-12 ? n.map((c) => c / length) : rotate(pts[i].orientation, [0, 1, 0]);
      const p = pts[i].position;
      for (const sign of [-1, 1]) {
        positions.push3(
          p[0] * scale + side[0] * half * sign,
          p[1] * scale + side[1] * half * sign,
          (p[2] * scale + side[2] * half * sign) * (right ? -1 : 1),
        );
        normals.push3(n[0], n[1], n[2] * (right ? -1 : 1));
        colors.push3(stroke.color[0], stroke.color[1], stroke.color[2]);
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = vertex + i * 2;
      if (right) indices.push3(a, a + 3, a + 1), indices.push3(a, a + 2, a + 3);
      else indices.push3(a, a + 1, a + 3), indices.push3(a, a + 3, a + 2);
    }
    vertex += pts.length * 2;
    groups.push({
      start,
      count: indices.length - start,
      ...(stroke.brush ? { name: stroke.brush } : {}),
      color: stroke.color,
      properties: { brushIndex: stroke.brushIndex },
    });
  }
  const geometry: LoadedGeometry = {
    kind: indices.length ? 'mesh' : 'points',
    positions: positions.result(),
    normals: normals.result(),
    colors: colors.result(),
  };
  if (indices.length) geometry.indices = indices.result();
  if (groups.length) geometry.groups = groups;
  return { geometry, strokes, brushes, ...(metadata ? { metadata } : {}), version };
}
