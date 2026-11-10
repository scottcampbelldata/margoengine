import type { GeoFeature, GeoGeometry, GeoOptions, GeoResult, MVTOptions } from '@margoengine/loaders/geo';
import { rangeError, typeError } from '../../shared/errors.js';
import { project, type Projection } from './geo.js';
import type { Bounds } from './layer.js';
import { parseTopoJSON, type TopologyOptions } from './geo-topology.js';

type Position = [number, number, number];
/** Geographic parser options. MVT needs its XYZ tile address to produce longitude/latitude. */
export interface GeoVectorParseOptions extends TopologyOptions {
  readonly format?: 'geojson' | 'topojson' | 'mvt';
  readonly tile?: MVTOptions['tile'];
  readonly layers?: readonly string[];
}
/** Reads geographic vectors with lazy owning-package readers. Coordinates remain WGS84 degrees/metres. */
export async function parseGeoVectors(
  input: string | object | Uint8Array,
  options: GeoVectorParseOptions = {},
): Promise<GeoResult> {
  options.signal?.throwIfAborted();
  if (typeof input === 'string' && !options.format) {
    if (new TextEncoder().encode(input).length > (options.maxBytes ?? 256 << 20))
      throw rangeError('Vector JSON exceeds maxBytes; raise the input budget', 'sciviz');
    try {
      input = JSON.parse(input) as object;
    } catch {
      throw typeError('Vector JSON is invalid; supply complete JSON text', 'sciviz');
    }
  }
  const format =
    options.format ??
    (input instanceof Uint8Array
      ? 'mvt'
      : typeof input === 'object' && input !== null && 'type' in input && input.type === 'Topology'
        ? 'topojson'
        : 'geojson');
  if (format === 'topojson') {
    if (input instanceof Uint8Array) throw rangeError('TopoJSON needs JSON text or an object', 'sciviz');
    return parseTopoJSON(input, options);
  }
  const readers = await import('@margoengine/loaders/geo');
  options.signal?.throwIfAborted();
  if (format === 'mvt') {
    if (!(input instanceof Uint8Array) || !options.tile)
      throw rangeError('Geographic MVT needs bytes and an XYZ tile address', 'sciviz');
    return readers.parseMVT(input, { ...options, layers: options.layers ? [...options.layers] : undefined });
  }
  if (format !== 'geojson') throw rangeError('Unknown vector format; choose geojson, topojson or mvt', 'sciviz');
  return readers.parseGeoJSON(input, options);
}

/** Exact keyed choropleth join. Missing/nonfinite observations become NaN; duplicate keys reject. */
export function joinGeoData<T>(
  features: readonly GeoFeature[],
  rows: readonly T[],
  options: {
    readonly featureKey: string | ((feature: GeoFeature, index: number) => string | number | undefined);
    readonly rowKey: (row: T) => string | number;
    readonly value: (row: T) => number;
  },
): Float64Array {
  const table = new Map<string | number, number>();
  for (const row of rows) {
    const key = options.rowKey(row);
    if (typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key)))
      throw rangeError('Join keys must be strings or finite numbers', 'sciviz');
    if (table.has(key)) throw rangeError(`Duplicate choropleth key ${key}; aggregate rows first`, 'sciviz');
    table.set(key, options.value(row));
  }
  return Float64Array.from(features, (feature, index) => {
    const key =
      typeof options.featureKey === 'function'
        ? options.featureKey(feature, index)
        : feature.properties?.[options.featureKey];
    const value = typeof key === 'string' || typeof key === 'number' ? table.get(key) : undefined;
    return value !== undefined && Number.isFinite(value) ? value : NaN;
  });
}

/** Projected, tessellated primitives. Feature IDs survive subdivision and dateline clipping. */
export interface GeoVectorGeometry {
  readonly source: GeoResult;
  readonly projection: Projection;
  readonly triangles: Float64Array;
  readonly triangleFeatures: Uint32Array;
  readonly lines: Float64Array;
  readonly lineFeatures: Uint32Array;
  readonly points: Float64Array;
  readonly pointFeatures: Uint32Array;
  /** Normalised geodetic normals, matching each position in triangles/lines/points. */
  readonly triangleNormals: Float32Array;
  readonly lineNormals: Float32Array;
  readonly pointNormals: Float32Array;
  /** One interior anchor per nonempty feature, in projected units. */
  readonly labels: readonly { readonly feature: number; readonly position: Position; readonly normal: Position }[];
  readonly bounds: Bounds;
}
/** Tessellation and input budgets. */
export interface GeoVectorPrepareOptions extends GeoOptions {
  readonly projection?: Projection;
  /** Maximum longitude/latitude span of a tessellated edge, default 5 degrees. */
  readonly maxDegrees?: number;
  /** Maximum emitted vertices across every primitive, default 6,000,000. */
  readonly maxOutputVertices?: number;
  /** Added height in metres, default 0. */
  readonly height?: number;
}

// RFC 7946 uses straight segments in longitude/latitude. Unwrap each path before ear clipping;
// align holes to their exterior, then clip the triangulation into periodic map strips.
function unwrapGeometry(g: GeoGeometry, maxDepth: number, depth = 0): GeoGeometry {
  if (depth > maxDepth) throw rangeError('Vector nesting exceeds maxDepth; flatten geometry collections', 'sciviz');
  const path = (p: number[][], center?: number, closed = false): number[][] => {
    if (!p.length) return [];
    const out = p.map((v) => v.slice());
    for (let i = 1; i < out.length; i++) {
      let d = p[i][0] - p[i - 1][0];
      // Exactly +/-360 at a pole is a full-world boundary, rather than a dateline crossing.
      if (Math.abs(d) > 180 && Math.abs(d) < 360) d -= 360 * Math.round(d / 360);
      out[i][0] = out[i - 1][0] + d;
    }
    if (closed && p[0].every((v, i) => v === p.at(-1)![i])) {
      if (Math.abs(out.at(-1)![0] - out[0][0]) > 180) {
        const pole = p.reduce((s, v) => s + v[1], 0) >= 0 ? 90 : -90;
        out.push([out.at(-1)![0], pole, ...out[0].slice(2)], [out[0][0], pole, ...out[0].slice(2)], out[0].slice());
      } else out[out.length - 1] = out[0].slice();
    }
    if (center !== undefined) {
      const mean = out.reduce((s, p) => s + p[0], 0) / out.length;
      const shift = 360 * Math.round((center - mean) / 360);
      for (const p of out) p[0] += shift;
    }
    return out;
  };
  const polygon = (rings: number[][][]): number[][][] => {
    const outer = path(rings[0] ?? [], undefined, true);
    const center = outer.reduce((s, p) => s + p[0], 0) / Math.max(1, outer.length);
    return [outer, ...rings.slice(1).map((r) => path(r, center, true))];
  };
  switch (g.type) {
    case 'LineString':
      return { ...g, coordinates: path(g.coordinates) };
    case 'MultiLineString':
      return { ...g, coordinates: g.coordinates.map((p) => path(p)) };
    case 'Polygon':
      return { ...g, coordinates: g.coordinates.length ? polygon(g.coordinates) : [] };
    case 'MultiPolygon':
      return { ...g, coordinates: g.coordinates.map(polygon) };
    case 'GeometryCollection':
      return { ...g, geometries: g.geometries.map((child) => unwrapGeometry(child, maxDepth, depth + 1)) };
    default:
      return g;
  }
}
// Keep interpolation inside its closed interval even after floating-point cancellation at a map seam.
const mix = (a: Position, b: Position, t: number): Position =>
  a.map((v, i) => Math.max(Math.min(v, b[i]), Math.min(Math.max(v, b[i]), v + (b[i] - v) * t))) as Position;
const span = (a: Position, b: Position) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const normal = (p: Position): Position => {
  const lon = (p[0] * Math.PI) / 180,
    lat = (p[1] * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};
function clip(poly: Position[], edge: number, keepGreater: boolean): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const ia = keepGreater ? a[0] >= edge : a[0] <= edge;
    const ib = keepGreater ? b[0] >= edge : b[0] <= edge;
    if (ia) out.push(a);
    if (ia !== ib) out.push(mix(a, b, (edge - a[0]) / (b[0] - a[0])));
  }
  return out;
}
/** Prepares WGS84 vectors for a flat map or ellipsoidal globe, preserving holes and dateline continuity. */
export async function prepareGeoVectors(
  source: GeoResult,
  options: GeoVectorPrepareOptions = {},
): Promise<GeoVectorGeometry> {
  options.signal?.throwIfAborted();
  const projection = options.projection ?? 'mercator',
    step = options.maxDegrees ?? 5,
    budget = options.maxOutputVertices ?? 6_000_000,
    height = options.height ?? 0;
  if (
    !['mercator', 'plate', 'globe'].includes(projection) ||
    !(step > 0 && step <= 180) ||
    !Number.isFinite(step) ||
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    !Number.isFinite(height)
  )
    throw rangeError(
      'Vectors need a projection, maxDegrees in (0,180], positive vertex budget and finite height',
      'sciviz',
    );
  if (source.crs !== 'OGC:CRS84')
    throw rangeError('Vectors need WGS84 degrees; supply MVT tile or reproject first', 'sciviz');
  const { parseGeoJSON } = await import('@margoengine/loaders/geo');
  options.signal?.throwIfAborted();
  const data = parseGeoJSON(
    {
      type: 'FeatureCollection',
      features: source.features.map((f) => ({
        ...f,
        geometry: f.geometry ? unwrapGeometry(f.geometry, options.maxDepth ?? 64) : null,
      })),
    },
    options,
  );
  const triangles: number[] = [],
    lines: number[] = [],
    points: number[] = [],
    tn: number[] = [],
    ln: number[] = [],
    pn: number[] = [],
    tf: number[] = [],
    lf: number[] = [],
    pf: number[] = [];
  const anchors = new Map<number, { position: Position; score: number }>();
  let emitted = 0;
  const p = (i: number): Position => [
    data.positions[i * 3],
    data.positions[i * 3 + 1],
    data.positions[i * 3 + 2] + height,
  ];
  const emit = (out: number[], normals: number[], v: Position): void => {
    if (++emitted > budget)
      throw rangeError('Vector tessellation exceeds maxOutputVertices; raise the budget or maxDegrees', 'sciviz');
    if ((emitted & 1023) === 0) options.signal?.throwIfAborted();
    out.push(...project(...v, projection));
    normals.push(...(projection === 'globe' ? normal(v) : [0, 0, 1]));
  };
  const anchor = (f: number, position: Position, score: number) => {
    if (!anchors.has(f) || score > anchors.get(f)!.score) anchors.set(f, { position, score });
  };
  const tri = (a: Position, b: Position, c: Position, f: number): void => {
    const lengths = [span(a, b), span(b, c), span(c, a)],
      longest = Math.max(...lengths);
    if (longest > step) {
      if (lengths[0] === longest) {
        const m = mix(a, b, 0.5);
        tri(a, m, c, f);
        tri(m, b, c, f);
      } else if (lengths[1] === longest) {
        const m = mix(b, c, 0.5);
        tri(a, b, m, f);
        tri(a, m, c, f);
      } else {
        const m = mix(c, a, 0.5);
        tri(a, b, m, f);
        tri(m, b, c, f);
      }
      return;
    }
    for (const v of [a, b, c]) emit(triangles, tn, v);
    tf.push(f);
  };
  const indices = data.mesh.indices ?? new Uint32Array();
  for (let i = 0; i < indices.length; i += 3) {
    options.signal?.throwIfAborted();
    const a = p(indices[i]),
      b = p(indices[i + 1]),
      c = p(indices[i + 2]),
      f = data.triangleFeatures[i / 3];
    anchor(f, mix(mix(a, b, 0.5), c, 1 / 3), Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])));
    if (projection === 'globe') tri(a, b, c, f);
    else {
      const min = Math.floor((Math.min(a[0], b[0], c[0]) + 180) / 360),
        max = Math.floor((Math.max(a[0], b[0], c[0]) + 180) / 360);
      for (let k = min; k <= max; k++) {
        const poly = clip(clip([a, b, c], -180 + 360 * k, true), 180 + 360 * k, false).map(
          (v): Position => [v[0] - 360 * k, v[1], v[2]],
        );
        for (let j = 1; j + 1 < poly.length; j++) tri(poly[0], poly[j], poly[j + 1], f);
      }
    }
  }
  for (let i = 0; i < data.lines.length; i += 2) {
    const a = p(data.lines[i]),
      b = p(data.lines[i + 1]),
      f = data.lineFeatures[i / 2],
      n = Math.max(1, Math.ceil(span(a, b) / step));
    if (n * 2 > budget - emitted) throw rangeError('Vector lines exceed maxOutputVertices', 'sciviz');
    anchor(f, mix(a, b, 0.5), -1);
    for (let j = 0; j < n; j++) {
      const u = mix(a, b, j / n),
        v = mix(a, b, (j + 1) / n);
      if (projection === 'globe') {
        emit(lines, ln, u);
        emit(lines, ln, v);
        lf.push(f);
      } else {
        const min = Math.floor((Math.min(u[0], v[0]) + 180) / 360),
          max = Math.floor((Math.max(u[0], v[0]) + 180) / 360);
        for (let k = min; k <= max; k++) {
          let t0 = 0,
            t1 = 1;
          if (u[0] !== v[0]) {
            const ts = [(-180 + 360 * k - u[0]) / (v[0] - u[0]), (180 + 360 * k - u[0]) / (v[0] - u[0])].sort(
              (a, b) => a - b,
            );
            t0 = Math.max(0, ts[0]);
            t1 = Math.min(1, ts[1]);
          }
          if (t1 <= t0) continue;
          for (const t of [t0, t1]) {
            const v = mix(u, mix(a, b, (j + 1) / n), t);
            v[0] -= 360 * k;
            emit(lines, ln, v);
          }
          lf.push(f);
        }
      }
    }
  }
  for (let i = 0; i < data.points.length; i++) {
    const v = p(data.points[i]),
      f = data.pointFeatures[i];
    emit(points, pn, v);
    pf.push(f);
    anchor(f, v, -2);
  }
  const bounds: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (const out of [triangles, lines, points])
    for (let i = 0; i < out.length; i += 3)
      for (let k = 0; k < 3; k++) {
        bounds[k * 2] = Math.min(bounds[k * 2], out[i + k]);
        bounds[k * 2 + 1] = Math.max(bounds[k * 2 + 1], out[i + k]);
      }
  if (!emitted) bounds.splice(0, 6, -1, 1, -1, 1, -1, 1);
  return {
    source,
    projection,
    triangles: new Float64Array(triangles),
    triangleFeatures: new Uint32Array(tf),
    lines: new Float64Array(lines),
    lineFeatures: new Uint32Array(lf),
    points: new Float64Array(points),
    pointFeatures: new Uint32Array(pf),
    triangleNormals: new Float32Array(tn),
    lineNormals: new Float32Array(ln),
    pointNormals: new Float32Array(pn),
    labels: [...anchors].map(([feature, { position }]) => ({
      feature,
      position: project(...position, projection),
      normal: projection === 'globe' ? normal(position) : [0, 0, 1],
    })),
    bounds,
  };
}
