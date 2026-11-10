// TopoJSON specification, Bostock et al. (2013): transforms, delta arcs, complemented indices and shared endpoints.
import type { GeoFeature, GeoGeometry, GeoOptions, GeoResult } from '@margoengine/loaders/geo';
import { rangeError, typeError } from '../../shared/errors.js';

/** TopoJSON object selection and the same parse limits as GeoJSON. */
export interface TopologyOptions extends GeoOptions {
  readonly objects?: readonly string[];
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw typeError('Topology needs an object; supply valid TopoJSON', 'sciviz');
  return v as Record<string, unknown>;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw typeError('Topology coordinates/arcs need arrays; supply valid TopoJSON', 'sciviz');
  return v;
};
/** Decodes shared arcs to an owned GeoJSON-compatible vector result, using the owning geometry triangulator. */
export async function parseTopoJSON(input: string | object, options: TopologyOptions = {}): Promise<GeoResult> {
  options.signal?.throwIfAborted();
  for (const [key, fallback] of Object.entries({
    maxBytes: 256 << 20,
    maxVertices: 10_000_000,
    maxFeatures: 100000,
    maxDepth: 64,
  })) {
    const value = options[key as keyof typeof options] ?? fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw rangeError(`Topology ${key} must be a positive safe integer`, 'sciviz');
  }
  if (typeof input === 'string' && new TextEncoder().encode(input).length > (options.maxBytes ?? 256 << 20))
    throw rangeError('Topology exceeds maxBytes; raise the input budget', 'sciviz');
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw typeError('Topology JSON is invalid; supply a complete JSON object', 'sciviz');
    }
  }
  const top = object(parsed);
  if (top.type !== 'Topology') throw typeError('Expected type Topology; use parseGeoJSON for GeoJSON', 'sciviz');
  const objects = object(top.objects),
    arcs = list(top.arcs),
    transform = top.transform === undefined ? undefined : object(top.transform);
  const pair = (value: unknown): number[] => {
    const a = list(value);
    if (a.length !== 2 || !a.every((v) => typeof v === 'number' && Number.isFinite(v)))
      throw rangeError('Topology scale/translate need two finite numbers', 'sciviz');
    return a as number[];
  };
  const scale = transform ? pair(transform.scale) : [1, 1],
    translate = transform ? pair(transform.translate) : [0, 0];
  let coordinates = 0,
    expanded = 0;
  const point = (value: unknown, delta?: number[]): number[] => {
    const a = list(value);
    if (a.length < 2 || !a.every((v) => typeof v === 'number' && Number.isFinite(v)))
      throw rangeError('Topology positions need at least two finite coordinates', 'sciviz');
    if (++coordinates > (options.maxVertices ?? 10_000_000))
      throw rangeError('Topology exceeds maxVertices; raise the geometry budget', 'sciviz');
    const out = [...a] as number[];
    if (transform) {
      if (!Number.isSafeInteger(out[0]) || !Number.isSafeInteger(out[1]))
        throw rangeError('Quantized topology coordinates must be safe integers', 'sciviz');
      if (delta) {
        delta[0] += out[0];
        delta[1] += out[1];
        if (!delta.every(Number.isSafeInteger))
          throw rangeError(
            'Topology delta accumulation exceeds safe integers; use a smaller quantization grid',
            'sciviz',
          );
        out[0] = delta[0];
        out[1] = delta[1];
      }
      out[0] = out[0] * scale[0] + translate[0];
      out[1] = out[1] * scale[1] + translate[1];
    }
    if (!out.every(Number.isFinite))
      throw rangeError('Topology transform overflows; supply finite transformed coordinates', 'sciviz');
    return out;
  };
  const decoded = new Map<number, number[][]>();
  const arc = (ref: unknown): number[][] => {
    if (!Number.isSafeInteger(ref)) throw rangeError('Topology arc index must be a safe integer', 'sciviz');
    const index = (ref as number) < 0 ? -(ref as number) - 1 : (ref as number);
    if (index < 0 || index >= arcs.length)
      throw rangeError('Topology arc index is outside arcs; supply a complete topology', 'sciviz');
    let points = decoded.get(index);
    if (!points) {
      options.signal?.throwIfAborted();
      const source = list(arcs[index]);
      if (source.length < 2) throw rangeError('Topology arcs need two positions', 'sciviz');
      const delta = [0, 0];
      points = source.map((p) => point(p, delta));
      decoded.set(index, points);
    }
    return (ref as number) < 0 ? [...points].reverse() : points;
  };
  const stitch = (refs: unknown): number[][] => {
    const out: number[][] = [];
    for (const ref of list(refs)) {
      const points = arc(ref);
      if (out.length && out[out.length - 1].some((v, i) => v !== points[0][i]))
        throw rangeError('Topology arc endpoints do not match; repair the shared boundary', 'sciviz');
      for (let i = out.length ? 1 : 0; i < points.length; i++) {
        if (++expanded > (options.maxVertices ?? 10_000_000))
          throw rangeError('Topology stitched path exceeds maxVertices', 'sciviz');
        out.push(points[i].slice());
      }
    }
    return out;
  };
  const geometry = (value: unknown, depth: number): GeoGeometry | null => {
    if (value === null) return null;
    if (depth > (options.maxDepth ?? 64))
      throw rangeError('Topology nesting exceeds maxDepth; flatten the geometry collection', 'sciviz');
    const g = object(value);
    switch (g.type) {
      case null:
        return null;
      case 'Point':
        return { type: 'Point', coordinates: point(g.coordinates) };
      case 'MultiPoint':
        return { type: 'MultiPoint', coordinates: list(g.coordinates).map((p) => point(p)) };
      case 'LineString':
        return { type: 'LineString', coordinates: stitch(g.arcs) };
      case 'MultiLineString':
        return { type: 'MultiLineString', coordinates: list(g.arcs).map(stitch) };
      case 'Polygon':
        return { type: 'Polygon', coordinates: list(g.arcs).map(stitch) };
      case 'MultiPolygon':
        return { type: 'MultiPolygon', coordinates: list(g.arcs).map((p) => list(p).map(stitch)) };
      case 'GeometryCollection':
        return {
          type: 'GeometryCollection',
          geometries: list(g.geometries)
            .map((p) => geometry(p, depth + 1))
            .filter((p): p is GeoGeometry => p !== null),
        };
      default:
        throw typeError('Unknown topology geometry type; supply a specified geometry', 'sciviz');
    }
  };
  const features: GeoFeature[] = [];
  const collect = (value: unknown, depth = 0): void => {
    options.signal?.throwIfAborted();
    if (depth > (options.maxDepth ?? 64))
      throw rangeError('Topology nesting exceeds maxDepth; flatten collections', 'sciviz');
    const g = object(value);
    if (g.type === 'GeometryCollection') {
      for (const child of list(g.geometries)) collect(child, depth + 1);
      return;
    }
    if (features.length >= (options.maxFeatures ?? 100000))
      throw rangeError('Topology exceeds maxFeatures; select fewer objects', 'sciviz');
    const f: GeoFeature = {
      type: 'Feature',
      properties: g.properties === undefined || g.properties === null ? null : object(g.properties),
      geometry: geometry(g, depth),
    };
    if (typeof g.id === 'number' || typeof g.id === 'string') f.id = g.id;
    features.push(f);
  };
  for (const name of options.objects ?? Object.keys(objects)) {
    if (!Object.hasOwn(objects, name))
      throw rangeError(`Topology object ${name} is missing; select an existing object`, 'sciviz');
    collect(objects[name]);
  }
  const { parseGeoJSON } = await import('@margoengine/loaders/geo');
  options.signal?.throwIfAborted();
  return parseGeoJSON({ type: 'FeatureCollection', features }, options);
}
