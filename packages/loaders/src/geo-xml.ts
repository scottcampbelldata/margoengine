import { LoaderError } from './types.js';
import { toBytes, throwIfAborted, type BinaryInput } from './util.js';
import { readXMLTree, decodeXML, type XMLElement } from './xml.js';
import {
  buildGeo,
  GEO,
  geoText,
  type GeoFeature,
  type GeoGeometry,
  type GeoOptions,
  type GeoPosition,
  type GeoResult,
} from './geo-model.js';
const child = (e: XMLElement, name: string): XMLElement | undefined => e.children.find((c) => c.name === name);
const children = (e: XMLElement, name: string): XMLElement[] => e.children.filter((c) => c.name === name);
const content = (e: XMLElement, name: string): string | undefined => child(e, name)?.text.trim();
const all = (e: XMLElement, name: string): XMLElement[] =>
  e.children.flatMap((c) => [...(c.name === name ? [c] : []), ...all(c, name)]);
function xml(input: BinaryInput | string, options: GeoOptions): XMLElement {
  throwIfAborted(options.signal, GEO);
  const source = typeof input === 'string' ? geoText(input, options) : decodeXML(toBytes(input, GEO));
  geoText(typeof input === 'string' ? input : toBytes(input, GEO), options);
  const root = readXMLTree(source, GEO);
  if (root.children.length !== 1)
    throw new LoaderError(GEO, 'syntax', 'vector XML requires exactly one document element');
  return root.children[0];
}
function properties(e: XMLElement): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const name of [
    'name',
    'desc',
    'description',
    'cmt',
    'time',
    'type',
    'sym',
    'number',
    'styleUrl',
    'altitudeMode',
  ]) {
    const value = content(e, name);
    if (value !== undefined) result[name] = value;
  }
  for (const item of all(e, 'Data'))
    if (item.attributes.name) result[item.attributes.name] = content(item, 'value') ?? '';
  for (const item of all(e, 'SimpleData')) if (item.attributes.name) result[item.attributes.name] = item.text.trim();
  return result;
}
function coordinate(e: XMLElement): GeoPosition {
  if (!e.attributes.lon?.trim() || !e.attributes.lat?.trim())
    throw new LoaderError(GEO, 'syntax', 'GPX points require lat and lon');
  const lon = Number(e.attributes.lon),
    lat = Number(e.attributes.lat),
    ele = content(e, 'ele');
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90)
    throw new LoaderError(GEO, 'range', 'GPX lat/lon is out of range');
  return ele === undefined ? [lon, lat] : [lon, lat, Number(ele)];
}
function routeGeometry(coords: GeoPosition[]): GeoGeometry | null {
  return coords.length === 0
    ? null
    : coords.length === 1
      ? { type: 'Point', coordinates: coords[0] }
      : { type: 'LineString', coordinates: coords };
}
/** Reads GPX 1.0/1.1 waypoints, routes and separate track segments, keeping elevations and timestamps. */
export function parseGPX(input: BinaryInput | string, options: GeoOptions = {}): GeoResult {
  const root = xml(input, options);
  if (root.name !== 'gpx') throw new LoaderError(GEO, 'header', 'expected a gpx document');
  const features: GeoFeature[] = [];
  for (const e of root.children) {
    if (e.name === 'wpt')
      features.push({
        type: 'Feature',
        properties: properties(e),
        geometry: { type: 'Point', coordinates: coordinate(e) },
      });
    else if (e.name === 'rte') {
      const rows = children(e, 'rtept'),
        props = properties(e);
      props.times = rows.map((p) => content(p, 'time') ?? null);
      features.push({
        type: 'Feature',
        properties: props,
        geometry: routeGeometry(rows.map(coordinate)),
      });
    } else if (e.name === 'trk') {
      const segments = children(e, 'trkseg').map((s) => children(s, 'trkpt')),
        props = properties(e);
      props.times = segments.map((s) => s.map((p) => content(p, 'time') ?? null));
      features.push({
        type: 'Feature',
        properties: props,
        geometry: {
          type: 'GeometryCollection',
          geometries: segments.map((s) => routeGeometry(s.map(coordinate))).filter((g): g is GeoGeometry => g !== null),
        },
      });
    }
  }
  return buildGeo(features, options);
}
function kmlCoordinates(e: XMLElement): GeoPosition[] {
  const text = content(e, 'coordinates');
  if (!text) throw new LoaderError(GEO, 'syntax', `KML ${e.name} needs coordinates`);
  return text.split(/\s+/).map((tuple) => {
    const values = tuple.split(',');
    if (values.length < 2 || values.length > 3 || values.some((v) => !v.trim()))
      throw new LoaderError(GEO, 'syntax', 'KML coordinate needs longitude, latitude and optional altitude');
    return values.map(Number);
  });
}
function kmlGeometry(e: XMLElement): GeoGeometry | null {
  if (e.name === 'Point') {
    const points = kmlCoordinates(e);
    if (points.length !== 1) throw new LoaderError(GEO, 'syntax', 'KML Point needs one coordinate');
    return { type: 'Point', coordinates: points[0] };
  }
  if (e.name === 'LineString' || e.name === 'LinearRing') return { type: 'LineString', coordinates: kmlCoordinates(e) };
  if (e.name === 'Polygon') {
    const outer = child(e, 'outerBoundaryIs'),
      ring = outer && child(outer, 'LinearRing');
    if (!ring) throw new LoaderError(GEO, 'syntax', 'KML Polygon needs outerBoundaryIs/LinearRing');
    const rings = [kmlCoordinates(ring)];
    for (const hole of children(e, 'innerBoundaryIs')) {
      const inner = child(hole, 'LinearRing');
      if (!inner) throw new LoaderError(GEO, 'syntax', 'KML inner boundary needs LinearRing');
      rings.push(kmlCoordinates(inner));
    }
    return { type: 'Polygon', coordinates: rings };
  }
  if (e.name === 'MultiGeometry')
    return {
      type: 'GeometryCollection',
      geometries: e.children.map(kmlGeometry).filter((g): g is GeoGeometry => g !== null),
    };
  if (e.name === 'Track') return routeGeometry(children(e, 'coord').map((c) => c.text.trim().split(/\s+/).map(Number)));
  if (e.name === 'MultiTrack')
    return {
      type: 'GeometryCollection',
      geometries: children(e, 'Track')
        .map(kmlGeometry)
        .filter((g): g is GeoGeometry => g !== null),
    };
  return null;
}
/** Reads KML placemarks, holes and MultiGeometry/gx tracks without fetching external links or models. */
export function parseKML(input: BinaryInput | string, options: GeoOptions = {}): GeoResult {
  const root = xml(input, options);
  if (root.name !== 'kml') throw new LoaderError(GEO, 'header', 'expected a kml document');
  const features = all(root, 'Placemark').map((e): GeoFeature => {
    const geometries = e.children.map(kmlGeometry).filter((g): g is GeoGeometry => g !== null),
      props = properties(e);
    const times = all(e, 'when').map((c) => c.text.trim());
    if (times.length) props.times = times;
    const f: GeoFeature = {
      type: 'Feature',
      properties: props,
      geometry:
        geometries.length === 1 ? geometries[0] : geometries.length ? { type: 'GeometryCollection', geometries } : null,
    };
    if (e.attributes.id) f.id = e.attributes.id;
    return f;
  });
  return buildGeo(features, options);
}
