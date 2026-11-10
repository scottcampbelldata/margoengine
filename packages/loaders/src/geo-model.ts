import { triangulate } from '@margoengine/geometry/triangulate';
import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { limits, throwIfAborted } from './util.js';

/** A source coordinate; z is optional and extra ordinates remain in source geometry. */
export type GeoPosition = number[];
/** GeoJSON-compatible geometry shared by every vector reader. */
export type GeoGeometry =
  | { type: 'Point'; coordinates: GeoPosition }
  | { type: 'MultiPoint' | 'LineString'; coordinates: GeoPosition[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: GeoPosition[][] }
  | { type: 'MultiPolygon'; coordinates: GeoPosition[][][] }
  | { type: 'GeometryCollection'; geometries: GeoGeometry[] };
/** One source feature and its attributes. */
export interface GeoFeature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown> | null;
  geometry: GeoGeometry | null;
  /** MVT source layer name, if present. */
  layer?: string;
  /** MVT layer extent, if present. */
  extent?: number;
}
/** Parse and tessellation bounds for vector data. */
export interface GeoOptions extends ParseLimits {
  /** Maximum source features. Default 100,000. */
  maxFeatures?: number;
  /** Maximum input bytes. Default 256 MiB. */
  maxBytes?: number;
  /** Geometry collection nesting limit. Default 64. */
  maxDepth?: number;
  /** Cancellation checked at feature and primitive boundaries. */
  signal?: AbortSignal;
}
/** One polygon: index rings, with outer ring first and holes following. */
export interface GeoPolygon {
  feature: number;
  rings: Uint32Array[];
}
/** Mixed vector primitives with source precision and renderable triangles. */
export interface GeoResult {
  features: GeoFeature[];
  /** Owned xyz coordinates in source units, retaining double precision. */
  positions: Float64Array;
  /** Explicit point indices. */
  points: Uint32Array;
  /** Source feature per point. */
  pointFeatures: Uint32Array;
  /** Two indices per line segment, including polygon boundaries. */
  lines: Uint32Array;
  /** Source feature per segment. */
  lineFeatures: Uint32Array;
  /** Source feature per triangle in mesh.indices. */
  triangleFeatures: Uint32Array;
  /** Source polygon boundaries, without the repeated closing vertex. */
  polygons: GeoPolygon[];
  /** Triangles and float32 coordinates for createMeshes/toGeometry; groups address source features. */
  mesh: LoadedGeometry;
  /** Coordinate reference system label. No implicit projection is applied. */
  crs: string;
}

export const GEO = 'Geo';
export function geoLimit(options: GeoOptions, key: 'maxFeatures' | 'maxBytes' | 'maxDepth', fallback: number): number {
  const value = options[key] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new LoaderError(GEO, 'limit', `${key} must be a positive safe integer`);
  return value;
}
export function geoText(input: string | Uint8Array, options: GeoOptions): string {
  throwIfAborted(options.signal, GEO);
  const max = geoLimit(options, 'maxBytes', 256 << 20);
  if ((typeof input === 'string' ? new TextEncoder().encode(input).length : input.length) > max)
    throw new LoaderError(GEO, 'limit', `input exceeds ${max} bytes`);
  return typeof input === 'string' ? input : new TextDecoder().decode(input);
}
export function area(ring: GeoPosition[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum / 2;
}
export function inside(p: GeoPosition, ring: GeoPosition[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
/** Internal containment grouping, independent of source ring winding or part ordering. */
export function ringPolygons(rings: GeoPosition[][]): GeoPosition[][][] {
  const ordered = rings
    .map((ring, i) => ({ ring, i, area: Math.abs(area(ring)), parent: -1, depth: 0 }))
    .sort((a, b) => b.area - a.area);
  const polygons: GeoPosition[][][] = [],
    owner = new Map<number, GeoPosition[][]>();
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    for (let j = i - 1; j >= 0; j--)
      if (inside(entry.ring[0], ordered[j].ring)) {
        entry.parent = j;
        entry.depth = ordered[j].depth + 1;
        break;
      }
    if (!(entry.depth % 2)) {
      const polygon = [entry.ring];
      polygons.push(polygon);
      owner.set(i, polygon);
    } else {
      let parent = entry.parent;
      while (parent >= 0 && !owner.has(parent)) parent = ordered[parent].parent;
      owner.get(parent)!.push(entry.ring);
    }
  }
  return polygons;
}
/** Internal normalization and tessellation shared by all vector formats. */
export function buildGeo(features: GeoFeature[], options: GeoOptions = {}, crs = 'OGC:CRS84'): GeoResult {
  throwIfAborted(options.signal, GEO);
  const limit = limits(options, GEO),
    maxFeatures = geoLimit(options, 'maxFeatures', 100000),
    maxDepth = geoLimit(options, 'maxDepth', 64);
  if (features.length > maxFeatures) throw new LoaderError(GEO, 'limit', `features exceed ${maxFeatures}`);
  const positions: number[] = [],
    points: number[] = [],
    pointFeatures: number[] = [],
    lines: number[] = [],
    lineFeatures: number[] = [],
    indices: number[] = [],
    triangleFeatures: number[] = [],
    polygons: GeoPolygon[] = [];
  const groups: NonNullable<LoadedGeometry['groups']> = [];
  const vertex = (p: GeoPosition): number => {
    if (!Array.isArray(p) || p.length < 2 || p.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
      throw new LoaderError(GEO, 'syntax', 'positions need finite x/y and optional z');
    if (positions.length / 3 >= limit.maxVertices)
      throw new LoaderError(GEO, 'limit', `vertices exceed ${limit.maxVertices}`);
    const index = positions.length / 3;
    positions.push(p[0], p[1], p[2] ?? 0);
    return index;
  };
  const path = (coords: GeoPosition[], feature: number, closed = false): number[] => {
    throwIfAborted(options.signal, GEO);
    if (Array.isArray(coords) && coords.length === 0 && !closed) return [];
    if (!Array.isArray(coords) || coords.length < (closed ? 4 : 2))
      throw new LoaderError(
        GEO,
        'syntax',
        closed ? 'polygon rings need four closed coordinates' : 'lines need two positions',
      );
    let source = coords;
    if (closed) {
      const a = coords[0],
        b = coords.at(-1)!;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.some((v, i) => v !== b[i]))
        throw new LoaderError(GEO, 'syntax', 'polygon rings must be closed');
      source = coords.slice(0, -1);
    }
    const result = source.map(vertex);
    for (let i = 0; i + 1 < result.length; i++) {
      lines.push(result[i], result[i + 1]);
      lineFeatures.push(feature);
    }
    if (closed) {
      lines.push(result.at(-1)!, result[0]);
      lineFeatures.push(feature);
    }
    return result;
  };
  const geometry = (g: GeoGeometry, feature: number, depth = 0): void => {
    if (depth > maxDepth) throw new LoaderError(GEO, 'limit', `geometry collections exceed ${maxDepth}`);
    if (!g || typeof g !== 'object') throw new LoaderError(GEO, 'syntax', 'expected a geometry object');
    switch (g.type) {
      case 'Point':
        points.push(vertex(g.coordinates));
        pointFeatures.push(feature);
        break;
      case 'MultiPoint':
        if (!Array.isArray(g.coordinates)) throw new LoaderError(GEO, 'syntax', 'MultiPoint needs coordinates');
        for (const p of g.coordinates) {
          points.push(vertex(p));
          pointFeatures.push(feature);
        }
        break;
      case 'LineString':
        path(g.coordinates, feature);
        break;
      case 'MultiLineString':
        if (!Array.isArray(g.coordinates)) throw new LoaderError(GEO, 'syntax', 'MultiLineString needs coordinates');
        for (const line of g.coordinates) path(line, feature);
        break;
      case 'Polygon': {
        if (!Array.isArray(g.coordinates)) throw new LoaderError(GEO, 'syntax', 'Polygon needs coordinate rings');
        if (!g.coordinates.length) break;
        const rings = g.coordinates.map((r) => path(r, feature, true)),
          flat: number[] = [],
          mapping: number[] = [],
          holes: number[] = [];
        for (let r = 0; r < rings.length; r++) {
          if (r) holes.push(mapping.length);
          for (const v of rings[r]) {
            mapping.push(v);
            flat.push(positions[v * 3], positions[v * 3 + 1]);
          }
        }
        const triangles = triangulate(flat, holes, 2);
        if (indices.length / 3 + triangles.length / 3 > limit.maxTriangles)
          throw new LoaderError(GEO, 'limit', `triangles exceed ${limit.maxTriangles}`);
        for (const index of triangles) indices.push(mapping[index]);
        for (let t = 0; t < triangles.length; t += 3) triangleFeatures.push(feature);
        polygons.push({ feature, rings: rings.map((r) => Uint32Array.from(r)) });
        break;
      }
      case 'MultiPolygon':
        if (!Array.isArray(g.coordinates)) throw new LoaderError(GEO, 'syntax', 'MultiPolygon needs coordinates');
        for (const polygon of g.coordinates) geometry({ type: 'Polygon', coordinates: polygon }, feature, depth);
        break;
      case 'GeometryCollection':
        if (!Array.isArray(g.geometries)) throw new LoaderError(GEO, 'syntax', 'GeometryCollection needs geometries');
        for (const child of g.geometries) geometry(child, feature, depth + 1);
        break;
      default:
        throw new LoaderError(GEO, 'unsupported', `unknown geometry type ${(g as { type?: string }).type}`);
    }
  };
  for (let f = 0; f < features.length; f++) {
    throwIfAborted(options.signal, GEO);
    const feature = features[f];
    const start = indices.length;
    if (feature.geometry) geometry(feature.geometry, f);
    if (indices.length > start)
      groups.push({
        start,
        count: indices.length - start,
        objectId: String(feature.id ?? f),
        name: typeof feature.properties?.name === 'string' ? feature.properties.name : undefined,
      });
  }
  const mesh: LoadedGeometry = { kind: indices.length ? 'mesh' : 'points', positions: Float32Array.from(positions) };
  if (mesh.positions.some((v) => !Number.isFinite(v)))
    throw new LoaderError(GEO, 'range', 'render coordinates exceed float32 range');
  if (indices.length) {
    mesh.indices = Uint32Array.from(indices);
    mesh.groups = groups;
  }
  return {
    features,
    positions: Float64Array.from(positions),
    points: Uint32Array.from(points),
    pointFeatures: Uint32Array.from(pointFeatures),
    lines: Uint32Array.from(lines),
    lineFeatures: Uint32Array.from(lineFeatures),
    triangleFeatures: Uint32Array.from(triangleFeatures),
    polygons,
    mesh,
    crs,
  };
}
