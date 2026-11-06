// KMZ archives: the KML document's models, with their COLLADA files and where they sit on the Earth.
import { flattenDAE, parseDAE, type DAEParseOptions } from './dae.js';
import { LoaderError, type LoadedGeometry } from './types.js';
import { resolvePath, throwIfAborted, toBytes, type BinaryInput } from './util.js';
import { decodeXML, readXMLTree, type XMLElement } from './xml.js';
import { readZipDirectory, readZipEntry, type ZipEntry, type ZipOptions } from './zip.js';

const F = 'KMZ';

/** Options of {@link parseKMZ}: zip limits, the COLLADA parser's options and an AbortSignal. */
export interface KMZOptions extends Pick<ZipOptions, 'maxEntries' | 'maxEntryBytes' | 'maxRatio'>, DAEParseOptions {
  signal?: AbortSignal;
  /**
   * Where the scene's (0, 0, 0) sits on the Earth, in degrees and metres above the WGS84 ellipsoid: each model then gets a
   * `matrix`. `'first'` uses the first model's location. Default: no `matrix`, because a map's projection may be the app's.
   */
  origin?: { longitude: number; latitude: number; altitude?: number } | 'first';
}

/** One `<Model>` of a KML document, or a bare `.dae` of an archive with no document. */
export interface KMZModel {
  /** The name of the placemark, when it has one. */
  name?: string;
  /** The model's path inside the archive. */
  path: string;
  geometry: LoadedGeometry;
  /** `<Location>`: degrees and metres. */
  location?: { longitude: number; latitude: number; altitude: number };
  /** `<Orientation>`, in degrees. */
  orientation?: { heading: number; tilt: number; roll: number };
  /** `<Scale>`. */
  scale?: [number, number, number];
  /** `<altitudeMode>`, `clampToGround` when the file has none. */
  altitudeMode?: string;
  /**
   * With `origin` and a `<Location>`: the column-major 4x4 that puts `geometry` in the scene, which is Y up, in metres,
   * with x east and z south at the origin. Holds the orientation, the scale, and the Earth's curve between the two places.
   */
  matrix?: number[];
}

/** What {@link parseKMZ} returns. */
export interface KMZResult {
  models: KMZModel[];
  /** Every path in the archive, such as the textures the models name. */
  files: string[];
  /** Reads a file of the archive, by a path from `files`. */
  read(path: string): Promise<Uint8Array>;
}

const find = (element: XMLElement, name: string): XMLElement | undefined => {
  for (const child of element.children) {
    if (child.name === name) return child;
    const nested = find(child, name);
    if (nested) return nested;
  }
  return undefined;
};
const all = (element: XMLElement, name: string, out: [XMLElement, XMLElement | undefined][], owner?: XMLElement): void => {
  for (const child of element.children) {
    if (child.name === name) out.push([child, owner]);
    all(child, name, out, child.name === 'Placemark' ? child : owner);
  }
};
function field(element: XMLElement, name: string, fallback: number): number {
  const text = element.children.find((child) => child.name === name)?.text.trim();
  if (text === undefined || text === '') return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new LoaderError(F, 'syntax', `<${name}> holds "${text.slice(0, 32)}"`);
  return value;
}

type Vector = [number, number, number];
const RADIANS = Math.PI / 180,
  // WGS84 (NIMA TR8350.2): semi-major axis in metres and first eccentricity squared.
  A = 6378137,
  E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563),
  dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A place's Earth-centred position, and its east, up and south axes, the scene's x, y and z there. */
function frame(longitude: number, latitude: number, height: number): { at: Vector; axes: [Vector, Vector, Vector] } {
  const lon = longitude * RADIANS,
    lat = latitude * RADIANS,
    [sinLon, cosLon, sinLat, cosLat] = [Math.sin(lon), Math.cos(lon), Math.sin(lat), Math.cos(lat)],
    n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return {
    at: [(n + height) * cosLat * cosLon, (n + height) * cosLat * sinLon, (n * (1 - E2) + height) * sinLat],
    axes: [
      [-sinLon, cosLon, 0],
      [cosLat * cosLon, cosLat * sinLon, sinLat],
      [sinLat * cosLon, sinLat * sinLon, -cosLat],
    ],
  };
}

/** KML's altitude taken as metres above the ellipsoid; `clampToGround` ignores it, and there is no terrain to clamp to. */
const heightOf = ({ location, altitudeMode }: KMZModel): number =>
  altitudeMode === 'clampToGround' ? 0 : (location?.altitude ?? 0);

/** `a * b` of 3x3 matrices, each three columns. */
const times = (a: Vector[], b: Vector[]): Vector[] =>
  b.map((column) => [0, 1, 2].map((r) => a[0][r] * column[0] + a[1][r] * column[1] + a[2][r] * column[2]) as Vector);

/**
 * The matrix of one model. KML's model axes are x east, y north, z up, and COLLADA's flatten turned them to x east, y up,
 * z south. KML rolls about y, tilts about x, then turns by heading clockwise from north seen from above; roll and tilt
 * are positive clockwise looking along their axes, which is the right-hand rule.
 */
function placed(model: KMZModel, origin: { longitude: number; latitude: number; altitude?: number }): number[] {
  const { longitude, latitude, altitude } = model.location!,
    here = frame(longitude, latitude, heightOf(model)),
    base = frame(origin.longitude, origin.latitude, origin.altitude ?? 0),
    offset: Vector = [here.at[0] - base.at[0], here.at[1] - base.at[1], here.at[2] - base.at[2]],
    // Columns: this place's east, up and south seen in the origin's axes.
    curve = here.axes.map((axis) => base.axes.map((ref) => dot(axis, ref)) as Vector),
    { heading = 0, tilt = 0, roll = 0 } = model.orientation ?? {},
    [sx, sy, sz] = model.scale ?? [1, 1, 1],
    [h, t, r] = [heading * RADIANS, tilt * RADIANS, roll * RADIANS],
    // Turning clockwise about up is -h about the scene's y; about KML's y, which is north, -r about the scene's z.
    turn: Vector[] = [
      [Math.cos(h), 0, Math.sin(h)],
      [0, 1, 0],
      [-Math.sin(h), 0, Math.cos(h)],
    ],
    pitch: Vector[] = [
      [1, 0, 0],
      [0, Math.cos(t), Math.sin(t)],
      [0, -Math.sin(t), Math.cos(t)],
    ],
    lean: Vector[] = [
      [Math.cos(r), -Math.sin(r), 0],
      [Math.sin(r), Math.cos(r), 0],
      [0, 0, 1],
    ],
    rotation = times(curve, times(turn, times(pitch, lean))),
    // KML's y scale is the scene's z, and its z the scene's y.
    scaled = [sx, sz, sy].map((size, i) => rotation[i].map((value) => value * size));
  return [
    ...scaled[0],
    0,
    ...scaled[1],
    0,
    ...scaled[2],
    0,
    ...base.axes.map((axis) => dot(axis, offset)),
    1,
  ];
}

/**
 * Reads a `.kmz` archive: the KML document's `<Model>` elements with their COLLADA files, flattened to one mesh each, and
 * where each sits on the Earth. An archive with no KML document gives every `.dae` it holds. Geometry stays in each
 * model's own space. With `origin`, each located model gets a `matrix` that puts it in a Y-up scene around that point, so
 * models of one archive land in the right places; without it `location` and `orientation` are only returned, for an app
 * with a map projection of its own. Altitudes are taken as metres above the ellipsoid, and `clampToGround` models sit at
 * height 0: no terrain or geoid is known here.
 * Placemark points, lines and polygons are not read.
 *
 * @param input The archive's bytes.
 * @param options Zip limits, the COLLADA options, `origin` and an AbortSignal.
 * @returns The models, the archive's paths and a reader for its files.
 * @throws LoaderError with code `header`, `syntax`, `zip`, `limit` or `aborted`, or what `parseDAE` throws.
 *
 * @example
 * ```ts
 * import { parseKMZ } from '@margoengine/loaders/kmz';
 *
 * const bytes = await (await fetch('/maps/tower.kmz')).arrayBuffer();
 * const { models, read } = await parseKMZ(bytes, { origin: 'first' });
 * console.log(models[0].location, models[0].matrix, (await read(models[0].path)).length);
 * ```
 */
export async function parseKMZ(input: BinaryInput, options: KMZOptions = {}): Promise<KMZResult> {
  const bytes = toBytes(input, F);
  throwIfAborted(options.signal, F);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new LoaderError(F, 'header', 'not a ZIP archive (missing PK signature)');
  const entries = readZipDirectory(bytes, options),
    byPath = new Map<string, ZipEntry>();
  for (const entry of entries) byPath.set(entry.name.replaceAll('\\', '/').toLowerCase(), entry);
  const read = async (path: string): Promise<Uint8Array> => {
    const entry = byPath.get(path.replaceAll('\\', '/').replace(/^\.?\/+/, '').toLowerCase());
    if (!entry) throw new LoaderError(F, 'syntax', `"${path.slice(0, 128)}" is not in the archive`);
    return readZipEntry(bytes, entry, options);
  };
  const load = async (path: string): Promise<LoadedGeometry> => {
    throwIfAborted(options.signal, F);
    return flattenDAE(parseDAE(await read(path), options));
  };
  const document =
    entries.find((entry) => /(^|\/)doc\.kml$/i.test(entry.name)) ?? entries.find((entry) => /\.kml$/i.test(entry.name));
  const models: KMZModel[] = [];
  if (document) {
    const tree = readXMLTree(decodeXML(await readZipEntry(bytes, document, options)), F),
      found: [XMLElement, XMLElement | undefined][] = [];
    all(tree, 'Model', found);
    for (const [model, placemark] of found) {
      const href = find(model, 'href')?.text.trim();
      if (!href) throw new LoaderError(F, 'syntax', '<Model> has no <Link> href');
      const path = resolvePath(document.name, href),
        entry: KMZModel = { path, geometry: await load(path) },
        name = placemark?.children.find((child) => child.name === 'name')?.text.trim(),
        location = model.children.find((child) => child.name === 'Location'),
        orientation = model.children.find((child) => child.name === 'Orientation'),
        scale = model.children.find((child) => child.name === 'Scale');
      if (name) entry.name = name;
      if (location)
        entry.location = {
          longitude: field(location, 'longitude', 0),
          latitude: field(location, 'latitude', 0),
          altitude: field(location, 'altitude', 0),
        };
      if (orientation)
        entry.orientation = {
          heading: field(orientation, 'heading', 0),
          tilt: field(orientation, 'tilt', 0),
          roll: field(orientation, 'roll', 0),
        };
      if (scale) entry.scale = [field(scale, 'x', 1), field(scale, 'y', 1), field(scale, 'z', 1)];
      if (location)
        entry.altitudeMode =
          model.children.find((child) => /^(gx:)?altitudeMode$/.test(child.name))?.text.trim() ||
          location.children.find((child) => /^(gx:)?altitudeMode$/.test(child.name))?.text.trim() ||
          'clampToGround';
      models.push(entry);
    }
  } else
    for (const entry of entries)
      if (/\.dae$/i.test(entry.name)) models.push({ path: entry.name, geometry: await load(entry.name) });
  if (!models.length) throw new LoaderError(F, 'syntax', 'the archive holds no model');
  const located = models.filter((model) => model.location),
    origin =
      options.origin === 'first' && located[0]
        ? { ...located[0].location!, altitude: heightOf(located[0]) }
        : options.origin;
  if (origin && origin !== 'first') for (const model of located) model.matrix = placed(model, origin);
  return { models, files: entries.map((entry) => entry.name), read };
}
