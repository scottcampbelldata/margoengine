// Additive Manufacturing Format .amf files, plain or zipped: objects, volumes, materials and constellations.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { floats, limits, throwIfAborted, toBytes, uints, type BinaryInput } from './util.js';
import { decodeXML, readXMLTree, type XMLElement } from './xml.js';
import { readZipDirectory, readZipEntry, type ZipOptions } from './zip.js';

const F = 'AMF';
const UNITS: Record<string, number> = Object.assign(Object.create(null), {
  millimeter: 1e-3,
  inch: 0.0254,
  feet: 0.3048,
  foot: 0.3048,
  meter: 1,
  micron: 1e-6,
});
const MAX_INSTANCES = 100_000;
const MAX_DEPTH = 32;

/** Options of {@link parseAMF}: size limits, zip limits, units and an AbortSignal. */
export interface AMFOptions extends ParseLimits, Pick<ZipOptions, 'maxEntries' | 'maxEntryBytes' | 'maxRatio'> {
  /** `'meters'` (default) scales by the file's unit; `'file'` keeps its own units. */
  units?: 'meters' | 'file';
  signal?: AbortSignal;
}

/** What {@link parseAMF} returns: one mesh with a group per object and volume. */
export interface AMFModel extends LoadedGeometry {
  kind: 'mesh';
  groups: LoadedGroup[];
  /** The file's unit, `millimeter` when it names none. */
  unit: string;
  /** `<metadata>` of the file by `type`. Null prototype. */
  metadata: Record<string, string>;
  /** Things the parser moved past, each listed once. */
  warnings: string[];
}

type Color = [number, number, number, number];
const kids = (element: XMLElement, name: string): XMLElement[] => element.children.filter((c) => c.name === name);
const kid = (element: XMLElement, name: string): XMLElement | undefined => element.children.find((c) => c.name === name);

function number(element: XMLElement | undefined, fallback: number | undefined, what: string): number {
  if (!element) {
    if (fallback === undefined) throw new LoaderError(F, 'syntax', `<${what}> is missing`);
    return fallback;
  }
  const value = Number(element.text.trim());
  if (!element.text.trim() || !Number.isFinite(value))
    throw new LoaderError(F, 'syntax', `<${what}> holds "${element.text.trim().slice(0, 32)}"`);
  return value;
}

/** A constant `<color>`; the format also allows formulas of x, y and z, which come back undefined. */
function readColor(element: XMLElement | undefined, warn: (message: string) => void): Color | undefined {
  if (!element) return undefined;
  const channel = (name: string, fallback?: number): number | undefined => {
    const text = kid(element, name)?.text.trim();
    if (text === undefined || text === '') return fallback;
    const value = Number(text);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const rgba = [channel('r'), channel('g'), channel('b'), channel('a', 1)];
  if (rgba.some((value) => value === undefined || Number.isNaN(value))) {
    warn('colour formulas are not read');
    return undefined;
  }
  return rgba as Color;
}

/** Row-major 3x4 of a translation, then rotations about x, y and z in degrees. */
function placement(instance: XMLElement): number[] {
  const value = (name: string): number => number(kid(instance, name), 0, name),
    radians = Math.PI / 180,
    [cx, sx] = [Math.cos(value('rx') * radians), Math.sin(value('rx') * radians)],
    [cy, sy] = [Math.cos(value('ry') * radians), Math.sin(value('ry') * radians)],
    [cz, sz] = [Math.cos(value('rz') * radians), Math.sin(value('rz') * radians)];
  // Rz * Ry * Rx, so x turns first.
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    value('deltax'),
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    value('deltay'),
    -sy,
    cy * sx,
    cy * cx,
    value('deltaz'),
  ];
}

function compose(a: number[], b: number[]): number[] {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      out[r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  return out;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/**
 * Reads an `.amf` file, plain XML or zipped: each object's vertices and volumes, material and object colours with
 * per-vertex colours, and constellations, which place objects by translation and rotation. With no constellation every
 * object appears once. Positions are in metres by default. Curved edges and colour formulas are skipped with a warning.
 *
 * @param input The file's bytes.
 * @param options Size and zip limits, units and an AbortSignal.
 * @returns The merged mesh with a group per object and volume.
 * @throws LoaderError with code `header`, `syntax`, `range`, `limit`, `zip`, `aborted` or `unsupported` (an unknown unit).
 *
 * @example
 * ```ts
 * import { parseAMF } from '@margoengine/loaders/amf';
 *
 * const file = `<amf unit="millimeter"><object id="1"><mesh><vertices>
 *   <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>
 *   <vertex><coordinates><x>10</x><y>0</y><z>0</z></coordinates></vertex>
 *   <vertex><coordinates><x>0</x><y>10</y><z>0</z></coordinates></vertex>
 * </vertices><volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume></mesh></object></amf>`;
 * const { positions, unit } = await parseAMF(new TextEncoder().encode(file));
 * console.log(positions.length, unit);
 * ```
 */
export async function parseAMF(input: BinaryInput, options: AMFOptions = {}): Promise<AMFModel> {
  const source = toBytes(input, F),
    { maxVertices, maxTriangles } = limits(options, F);
  throwIfAborted(options.signal, F);
  if (options.units !== undefined && options.units !== 'meters' && options.units !== 'file')
    throw new LoaderError(F, 'range', 'units must be "meters" or "file"');
  let bytes = source;
  if (source[0] === 0x50 && source[1] === 0x4b) {
    const entries = readZipDirectory(source, options),
      entry = entries.find((candidate) => /\.amf$/i.test(candidate.name)) ?? entries[0];
    if (!entry) throw new LoaderError(F, 'zip', 'the archive is empty');
    bytes = await readZipEntry(source, entry, options);
  }
  const root = kid(readXMLTree(decodeXML(bytes), F), 'amf');
  if (!root) throw new LoaderError(F, 'header', 'no <amf> element');
  const unit = root.attributes.unit ?? 'millimeter';
  if (!(unit in UNITS)) throw new LoaderError(F, 'unsupported', `unknown unit "${unit.slice(0, 32)}"`);
  const scale = options.units === 'file' ? 1 : UNITS[unit],
    warnings = new Set<string>(),
    warn = (message: string): void => void warnings.add(message),
    metadata: Record<string, string> = Object.create(null),
    materials = new Map<string, Color>(),
    objects = new Map<string, XMLElement>(),
    constellations = new Map<string, XMLElement>();
  for (const entry of kids(root, 'metadata')) metadata[entry.attributes.type ?? ''] = entry.text.trim();
  for (const material of kids(root, 'material')) {
    const color = readColor(kid(material, 'color'), warn);
    if (color) materials.set(material.attributes.id ?? '', color);
  }
  for (const object of kids(root, 'object')) objects.set(object.attributes.id ?? '', object);
  for (const entry of kids(root, 'constellation')) constellations.set(entry.attributes.id ?? '', entry);

  const positions = floats(),
    colors = floats(),
    indices = uints(),
    groups: LoadedGroup[] = [],
    placing = new Set<string>();
  let vertexColors = false,
    instances = 0;

  const emit = (object: XMLElement, m: number[]): void => {
    const mesh = kid(object, 'mesh');
    if (!mesh) return;
    const vertices = kid(mesh, 'vertices');
    if (!vertices) throw new LoaderError(F, 'syntax', '<mesh> has no <vertices>');
    const list = kids(vertices, 'vertex'),
      base = positions.length / 3;
    if (kid(vertices, 'edge')) warn('curved edges are drawn straight');
    if (base + list.length > maxVertices)
      throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
    for (const vertex of list) {
      const at = kid(vertex, 'coordinates');
      if (!at) throw new LoaderError(F, 'syntax', '<vertex> has no <coordinates>');
      const x = number(kid(at, 'x'), undefined, 'x'),
        y = number(kid(at, 'y'), undefined, 'y'),
        z = number(kid(at, 'z'), undefined, 'z');
      positions.push3(
        (m[0] * x + m[1] * y + m[2] * z + m[3]) * scale,
        (m[4] * x + m[5] * y + m[6] * z + m[7]) * scale,
        (m[8] * x + m[9] * y + m[10] * z + m[11]) * scale,
      );
      const color = readColor(kid(vertex, 'color'), warn);
      if (color) vertexColors = true;
      const [r, g, b] = color ?? [1, 1, 1];
      colors.push3(r, g, b);
    }
    const objectColor = readColor(kid(object, 'color'), warn);
    for (const volume of kids(mesh, 'volume')) {
      const start = indices.length;
      for (const triangle of kids(volume, 'triangle')) {
        if (indices.length / 3 >= maxTriangles)
          throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${maxTriangles}`);
        const corner = (name: string): number => {
          const value = number(kid(triangle, name), undefined, name);
          if (!Number.isInteger(value) || value < 0 || value >= list.length)
            throw new LoaderError(F, 'range', `${name} ${value} is outside 0..${list.length - 1}`);
          return base + value;
        };
        indices.push3(corner('v1'), corner('v2'), corner('v3'));
      }
      if (indices.length === start) continue;
      const group: LoadedGroup = { start, count: indices.length - start, objectId: object.attributes.id },
        name = kids(object, 'metadata').find((entry) => entry.attributes.type === 'name')?.text.trim(),
        color =
          readColor(kid(volume, 'color'), warn) ?? materials.get(volume.attributes.materialid ?? '') ?? objectColor;
      if (name) group.name = name;
      if (color) group.color = [...color];
      groups.push(group);
    }
  };
  const place = (id: string, m: number[], depth: number): void => {
    if (depth > MAX_DEPTH) throw new LoaderError(F, 'limit', `constellations nest deeper than ${MAX_DEPTH}`);
    if (++instances > MAX_INSTANCES)
      throw new LoaderError(F, 'limit', `the file expands to more than ${MAX_INSTANCES} instances`);
    const object = objects.get(id);
    if (object) {
      emit(object, m);
      return;
    }
    const constellation = constellations.get(id);
    if (!constellation) throw new LoaderError(F, 'syntax', `instance of ${id.slice(0, 32)}, which is not defined`);
    if (placing.has(id)) throw new LoaderError(F, 'syntax', `constellation ${id.slice(0, 32)} contains itself`);
    placing.add(id);
    for (const instance of kids(constellation, 'instance'))
      place(instance.attributes.objectid ?? '', compose(m, placement(instance)), depth + 1);
    placing.delete(id);
  };
  if (constellations.size) {
    // Only a constellation no other one uses is a root of the build.
    const used = new Set<string>();
    for (const entry of constellations.values())
      for (const instance of kids(entry, 'instance')) used.add(instance.attributes.objectid ?? '');
    const roots = [...constellations.keys()].filter((id) => !used.has(id));
    if (!roots.length) throw new LoaderError(F, 'syntax', 'every constellation contains another');
    for (const id of roots) place(id, IDENTITY, 0);
  } else for (const id of objects.keys()) place(id, IDENTITY, 0);
  if (!indices.length) throw new LoaderError(F, 'syntax', 'the file holds no triangles');
  const model: AMFModel = {
    kind: 'mesh',
    positions: positions.result(),
    indices: indices.result(),
    groups,
    unit,
    metadata,
    warnings: [...warnings],
  };
  if (vertexColors) model.colors = colors.result();
  return model;
}
