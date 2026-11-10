import { LoaderError } from './types.js';
import { toBytes, type BinaryInput } from './util.js';
import {
  buildGeo,
  geoLimit,
  geoText,
  GEO,
  type GeoFeature,
  type GeoGeometry,
  type GeoOptions,
  type GeoResult,
} from './geo-model.js';
export type { GeoFeature, GeoGeometry, GeoOptions, GeoPolygon, GeoPosition, GeoResult } from './geo-model.js';
export { parseGPX, parseKML } from './geo-xml.js';
export { parseShapefile, type ShapefileOptions } from './geo-shp.js';
export { parseMVT, type MVTOptions } from './geo-mvt.js';

/** Reads GeoJSON geometry, Feature or FeatureCollection into mixed vector primitives. No projection is applied. */
export function parseGeoJSON(input: BinaryInput | string | object, options: GeoOptions = {}): GeoResult {
  let source: unknown;
  try {
    const value =
      typeof input === 'string'
        ? input
        : input instanceof ArrayBuffer || ArrayBuffer.isView(input)
          ? toBytes(input as BinaryInput, GEO)
          : JSON.stringify(input);
    source = JSON.parse(geoText(value, options).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error instanceof LoaderError) throw error;
    throw new LoaderError(GEO, 'syntax', `invalid GeoJSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!source || typeof source !== 'object') throw new LoaderError(GEO, 'syntax', 'GeoJSON needs an object');
  const object = source as Record<string, unknown>;
  const rows: unknown[] =
    object.type === 'FeatureCollection'
      ? (object.features as unknown[])
      : object.type === 'Feature'
        ? [object]
        : [{ type: 'Feature', geometry: object, properties: null }];
  if (!Array.isArray(rows)) throw new LoaderError(GEO, 'syntax', 'FeatureCollection needs a features array');
  if (rows.length > geoLimit(options, 'maxFeatures', 100000))
    throw new LoaderError(GEO, 'limit', 'too many GeoJSON features');
  const features = rows.map((row): GeoFeature => {
    if (!row || typeof row !== 'object') throw new LoaderError(GEO, 'syntax', 'expected a GeoJSON Feature');
    const f = row as Record<string, unknown>;
    if (f.geometry !== null && (typeof f.geometry !== 'object' || Array.isArray(f.geometry)))
      throw new LoaderError(GEO, 'syntax', 'Feature geometry must be an object or null');
    if (
      f.type !== 'Feature' ||
      !Object.hasOwn(f, 'geometry') ||
      !Object.hasOwn(f, 'properties') ||
      (f.properties !== null && (typeof f.properties !== 'object' || Array.isArray(f.properties)))
    )
      throw new LoaderError(GEO, 'syntax', 'Feature requires geometry and object/null properties');
    if (f.id !== undefined && typeof f.id !== 'string' && typeof f.id !== 'number')
      throw new LoaderError(GEO, 'syntax', 'Feature id must be a string or number');
    const feature: GeoFeature = {
      type: 'Feature',
      properties: f.properties === null ? null : Object.assign(Object.create(null), f.properties),
      geometry: f.geometry as GeoGeometry | null,
    };
    if (f.id !== undefined) feature.id = f.id as string | number;
    return feature;
  });
  return buildGeo(features, options);
}
