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

/**
 * Reads a `.kmz` archive: the KML document's `<Model>` elements with their COLLADA files, flattened to one mesh each, and
 * where each sits on the Earth. An archive with no KML document gives every `.dae` it holds. Geometry stays in each
 * model's own space: `location` and `orientation` are returned, not applied, because a map's projection is the app's
 * choice. Placemark points, lines and polygons are not read.
 *
 * @param input The archive's bytes.
 * @param options Zip limits, the COLLADA options and an AbortSignal.
 * @returns The models, the archive's paths and a reader for its files.
 * @throws LoaderError with code `header`, `syntax`, `zip`, `limit` or `aborted`, or what `parseDAE` throws.
 *
 * @example
 * ```ts
 * import { parseKMZ } from '@margoengine/loaders/kmz';
 *
 * const bytes = await (await fetch('/maps/tower.kmz')).arrayBuffer();
 * const { models, read } = await parseKMZ(bytes);
 * console.log(models[0].location, (await read(models[0].path)).length);
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
      models.push(entry);
    }
  } else
    for (const entry of entries)
      if (/\.dae$/i.test(entry.name)) models.push({ path: entry.name, geometry: await load(entry.name) });
  if (!models.length) throw new LoaderError(F, 'syntax', 'the archive holds no model');
  return { models, files: entries.map((entry) => entry.name), read };
}
