import type { VTKXMLArray, VTKXMLDataset } from '@margoengine/loaders/vtk-xml';
import { readXMLTree, type XMLElement } from '@margoengine/loaders/xml';
import { rangeError } from '../../shared/errors.js';
import { byteLimit, fileSource, readBytes, type FileInput, type FileOptions } from './file-source.js';
import { openVTK } from './vtk.js';
import {
  createDataSet,
  type DataSet,
  type DataSetCell,
  type DataSetFields,
  type DataSetInput,
  type DataSetOptions,
} from './datasets.js';
import { elementNodes, type ElementShape } from './datasets-elements.js';

/** VTK XML leaves and composite references. `files` resolves exact relative paths for in-memory collections.
 * scalar defaults to the first one-component point array. Every named numeric tuple array is retained.
 */
export interface DataSetReadOptions extends Omit<FileOptions, 'signal'>, DataSetOptions {
  readonly files?: Readonly<Record<string, FileInput>>;
  readonly baseURL?: string | URL;
  readonly scalar?: string;
  readonly format?: 'vtk' | 'plot3d';
  readonly plot3d?: PLOT3DOptions;
}
/** Whole-grid NASA PLOT3D variants. Defaults: formatted, 3 dimensions, multiblock, no iblank.
 * Binary: byte order defaults little endian, precision 8 bytes, 4-byte Fortran record markers enabled.
 */
export interface PLOT3DOptions extends DataSetOptions {
  readonly dimensions?: 2 | 3;
  readonly multiblock?: boolean;
  readonly binary?: boolean;
  readonly littleEndian?: boolean;
  readonly precision?: 4 | 8;
  readonly recordMarkers?: boolean;
  readonly iblank?: boolean;
}
const bad = (message: string): never => {
  throw rangeError(`Dataset reader: ${message}; check the format and read options`, 'sciviz');
};
const product = (a: readonly number[]) => a.reduce((x, y) => x * y, 1);

/** Parse a formatted, stream-binary or Fortran-unformatted PLOT3D grid into a multiblock dataset.
 * Explicit options avoid guessing ambiguously encoded precision, dimensionality or blanking.
 */
export async function parsePLOT3D(
  input: string | ArrayBuffer | ArrayBufferView,
  options: PLOT3DOptions = {},
): Promise<DataSet> {
  options.signal?.throwIfAborted();
  const dim = options.dimensions ?? 3,
    multi = options.multiblock ?? true,
    max = options.maxPoints ?? 1_000_000;
  if (dim !== 2 && dim !== 3) bad('PLOT3D dimensions must be 2 or 3');
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let integer: () => number, real: () => number, begin: (count: number) => void, end: () => void, finish: () => void;
  if (options.binary) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      little = options.littleEndian ?? true,
      precision = options.precision ?? 8,
      markers = options.recordMarkers ?? true;
    if (precision !== 4 && precision !== 8) bad('binary precision must be 4 or 8');
    let at = 0,
      stop = 0,
      record = 0;
    const take = (n: number) => {
      if (at + n > bytes.length) bad('truncated PLOT3D record');
      const start = at;
      at += n;
      return start;
    };
    integer = () => view.getInt32(take(4), little);
    real = () => (precision === 4 ? view.getFloat32(take(4), little) : view.getFloat64(take(8), little));
    begin = (count) => {
      record = count;
      if (markers) {
        if (integer() !== count) bad('Fortran record length differs from expected payload');
        stop = at + count;
      }
    };
    end = () => {
      if (markers && (at !== stop || integer() !== record)) bad('Fortran trailing record marker differs');
    };
    finish = () => {
      if (at !== bytes.length) bad('PLOT3D has trailing bytes');
    };
  } else {
    const tokens = new TextDecoder().decode(bytes).trim().split(/\s+/);
    let at = 0;
    const number = () => {
      if (at >= tokens.length) bad('truncated formatted PLOT3D');
      const value = Number(tokens[at++].replace(/[dD]/, 'E'));
      if (!Number.isFinite(value)) bad('invalid formatted number');
      return value;
    };
    integer = () => {
      const n = number();
      if (!Number.isSafeInteger(n)) bad('expected an integer');
      return n;
    };
    real = number;
    begin = () => {};
    end = () => {};
    finish = () => {
      if (at !== tokens.length) bad('PLOT3D has trailing tokens');
    };
  }
  let count = 1;
  if (multi) {
    begin(4);
    count = integer();
    end();
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000) bad('invalid PLOT3D block count');
  begin(count * dim * 4);
  const shapes: [number, number, number][] = [];
  let total = 0;
  for (let b = 0; b < count; b++) {
    const d = [integer(), integer(), dim === 3 ? integer() : 1] as [number, number, number];
    if (
      d.some((n) => !Number.isSafeInteger(n) || n < 1) ||
      !Number.isSafeInteger(product(d)) ||
      (total += product(d)) > max
    )
      bad('invalid PLOT3D dimensions or point limit');
    shapes.push(d);
  }
  end();
  const blocks: DataSetInput[] = [];
  for (const shape of shapes) {
    options.signal?.throwIfAborted();
    const n = product(shape),
      points = new Float64Array(n * 3),
      mask = options.iblank ? new Float64Array(n) : undefined;
    begin(n * dim * (options.precision ?? 8) + (mask ? n * 4 : 0));
    for (let a = 0; a < dim; a++)
      for (let i = 0; i < n; i++) {
        const value = real();
        if (!Number.isFinite(value)) bad('PLOT3D coordinates must be finite');
        points[3 * i + a] = value;
      }
    if (mask) for (let i = 0; i < n; i++) mask[i] = integer();
    end();
    blocks.push({ kind: 'structured', dimensions: shape, points, pointArrays: mask ? { iblank: mask } : undefined });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  finish();
  return createDataSet({ kind: 'multiblock', blocks }, options);
}

const higher: Record<number, { type: 'lagrange' | 'quadratic'; shape: ElementShape }> = {
  21: { type: 'quadratic', shape: 'curve' },
  22: { type: 'quadratic', shape: 'triangle' },
  23: { type: 'quadratic', shape: 'quad' },
  24: { type: 'quadratic', shape: 'tetra' },
  25: { type: 'quadratic', shape: 'hex' },
  26: { type: 'quadratic', shape: 'wedge' },
  27: { type: 'quadratic', shape: 'pyramid' },
  28: { type: 'lagrange', shape: 'quad' },
  29: { type: 'lagrange', shape: 'hex' },
  68: { type: 'lagrange', shape: 'curve' },
  69: { type: 'lagrange', shape: 'triangle' },
  70: { type: 'lagrange', shape: 'quad' },
  71: { type: 'lagrange', shape: 'tetra' },
  72: { type: 'lagrange', shape: 'hex' },
  73: { type: 'lagrange', shape: 'wedge' },
};
function extent(text: string | undefined): [number, number, number] {
  const e = text?.trim().split(/\s+/).map(Number);
  if (!e || e.length !== 6 || e.some((n) => !Number.isSafeInteger(n))) bad('structured extent needs six integers');
  const d = [e![1] - e![0] + 1, e![3] - e![2] + 1, e![5] - e![4] + 1] as [number, number, number];
  if (d.some((n) => n < 1)) bad('structured extent is reversed');
  return d;
}
async function values(array: VTKXMLArray | undefined, signal?: AbortSignal): Promise<Float64Array> {
  if (!array) bad('required topology array is missing');
  return array!.read(signal);
}
async function leaf(dataset: VTKXMLDataset, options: DataSetReadOptions): Promise<DataSet> {
  const blocks: DataSetInput[] = [];
  for (const piece of dataset.pieces) {
    const named = async (a: Readonly<Record<string, VTKXMLArray>>) =>
      Object.fromEntries(
        await Promise.all(Object.entries(a).map(async ([name, entry]) => [name, await entry.read(options.signal)])),
      );
    const pointArrays = await named(piece.pointData),
      cellArrays = await named(piece.cellData),
      scalar = options.scalar ?? Object.keys(piece.pointData).find((k) => piece.pointData[k].components === 1);
    if (scalar !== undefined && (!piece.pointData[scalar] || piece.pointData[scalar].components !== 1))
      bad('selected scalar is absent or is not scalar');
    const fields: DataSetFields = {
      pointArrays,
      cellArrays,
      pointData: scalar === undefined ? undefined : pointArrays[scalar],
    };
    if (dataset.type === 'RectilinearGrid') {
      const dimensions = extent(piece.attributes.Extent ?? dataset.attributes.WholeExtent),
        axes = await Promise.all(piece.coordinates.map((a) => a.read(options.signal)));
      if (axes.length !== 3 || axes.some((a, i) => a.length !== dimensions[i]))
        bad('rectilinear coordinate lengths differ from extent');
      blocks.push({ kind: 'rectilinear', axes: axes as [Float64Array, Float64Array, Float64Array], ...fields });
      continue;
    }
    const points = await values(piece.points, options.signal);
    if (dataset.type === 'StructuredGrid') {
      blocks.push({
        kind: 'structured',
        dimensions: extent(piece.attributes.Extent ?? dataset.attributes.WholeExtent),
        points,
        ...fields,
      });
      continue;
    }
    if (dataset.type === 'PolyData') {
      const groups: Record<string, number[][]> = {};
      for (const [name, key] of [
        ['Verts', 'vertices'],
        ['Lines', 'lines'],
        ['Polys', 'polygons'],
        ['Strips', 'strips'],
      ]) {
        const group = piece.topology[name];
        if (!Object.keys(group).length) {
          groups[key] = [];
          continue;
        }
        const connectivity = await values(group.connectivity, options.signal),
          offsets = await values(group.offsets, options.signal);
        let start = 0;
        groups[key] = Array.from(offsets, (end) => {
          if (!Number.isSafeInteger(end) || end < start || end > connectivity.length) bad('invalid PolyData offset');
          const ids = Array.from(connectivity.subarray(start, end));
          start = end;
          return ids;
        });
        if (start !== connectivity.length) bad('PolyData connectivity has trailing indices');
      }
      blocks.push({ kind: 'polydata', points, ...groups, ...fields });
      continue;
    }
    if (dataset.type !== 'UnstructuredGrid') bad(`unsupported dataset ${dataset.type}`);
    const connectivity = await values(piece.cells.connectivity, options.signal),
      offsets = await values(piece.cells.offsets, options.signal),
      types = await values(piece.cells.types, options.signal),
      cells: DataSetCell[] = [];
    const faces = piece.cells.faces && (await piece.cells.faces.read(options.signal)),
      faceOffsets = piece.cells.faceoffsets && (await piece.cells.faceoffsets.read(options.signal));
    let start = 0,
      faceStart = 0;
    if (types.length !== offsets.length) bad('cell types and offsets differ');
    for (let c = 0; c < types.length; c++) {
      const end = offsets[c];
      if (!Number.isSafeInteger(end) || end < start || end > connectivity.length) bad('invalid cell offset');
      let ids = Array.from(connectivity.subarray(start, end));
      start = end;
      const type = types[c],
        element = higher[type];
      if (element) {
        let order = 2;
        if (element.type === 'lagrange') {
          order = 1;
          while (order <= 10 && elementNodes(element.shape, order).length !== ids.length) order++;
          if (order > 10) bad('Lagrange count does not match order 1..10');
        }
        cells.push({ ...element, ids, order });
      } else if (type === 42) {
        const stop = faceOffsets?.[c];
        if (!faces || stop === undefined || !Number.isSafeInteger(stop) || stop <= faceStart || stop > faces.length)
          bad('polyhedron face offsets are invalid');
        cells.push({ type: 'polyhedron', faces: faces.subarray(faceStart, stop) });
        faceStart = stop;
      } else {
        if (type === 11) ids = [ids[0], ids[1], ids[3], ids[2], ids[4], ids[5], ids[7], ids[6]];
        if (type === 8) ids = [ids[0], ids[1], ids[3], ids[2]];
        cells.push({ type: type === 11 ? 12 : type === 8 ? 9 : type, ids });
      }
    }
    if (start !== connectivity.length) bad('connectivity has trailing indices');
    blocks.push({ kind: 'unstructured', points, cells, ...fields });
  }
  return createDataSet(blocks.length === 1 ? blocks[0] : { kind: 'partitioned', blocks }, options);
}

/** Open .vtr, .vts, .vtu, .vtp, .vtm, .vtpd/.vtpc or explicitly selected PLOT3D.
 * Numeric leaves use the loader-owned ASCII, binary, appended and compressed array decoder.
 * Composite files preserve sparse indices, names and nesting, with cycle detection and a depth limit of 64.
 */
export function openDataSet(input: FileInput, options: DataSetReadOptions = {}): Promise<DataSet> {
  return open(input, options, new Set(), 0);
}
async function open(
  input: FileInput,
  options: DataSetReadOptions,
  ancestors: Set<unknown>,
  depth: number,
): Promise<DataSet> {
  if (typeof input === 'string') {
    const base = options.baseURL ?? (typeof document === 'undefined' ? undefined : document.baseURI);
    if (base) input = new URL(input, base);
  }
  const identity = input instanceof URL ? input.href : input;
  options.signal?.throwIfAborted();
  if (depth > 64 || ancestors.has(identity)) bad('cyclic or excessively nested collection');
  const next = new Set(ancestors).add(identity),
    max = byteLimit(options.maxBytes);
  if (options.format === 'plot3d')
    return parsePLOT3D(await readBytes(fileSource(input, max), 0, max, max, options.signal), {
      ...options,
      ...options.plot3d,
    });
  const source = fileSource(input, max);
  let header = '',
    at = 0;
  while (!/<VTKFile\s[^>]*>/.test(header)) {
    const bytes = await readBytes(source, at, Math.min(max - at, 4096), max, options.signal);
    at += bytes.length;
    header += new TextDecoder().decode(bytes);
    if (!bytes.length || at === max) break;
  }
  if (
    !/type\s*=\s*['"](?:vtkMultiBlockDataSet|vtkPartitionedDataSet|vtkPartitionedDataSetCollection)['"]/.test(header)
  ) {
    using file = await openVTK(input, options);
    return await leaf(file.dataset, options);
  }
  const all = await readBytes(fileSource(input, max), 0, max, max, options.signal);
  if (all.length === max) bad('composite XML reaches maxBytes');
  const tree = readXMLTree(new TextDecoder().decode(all), 'VTK collection'),
    file = tree.children.find((n) => n.name === 'VTKFile');
  if (!file || file.children.length !== 1) bad('collection needs one VTKFile dataset');
  const base = typeof input === 'string' || input instanceof URL ? new URL(input, options.baseURL) : options.baseURL;
  const walk = async (node: XMLElement): Promise<DataSet> => {
    const kind = node.name.includes('Partitioned') ? 'partitioned' : 'multiblock',
      blocks: (DataSet | null)[] = [],
      names: string[] = [],
      seen = new Set<number>();
    for (const child of node.children) {
      if (!['Block', 'DataSet', 'Partitions', 'PartitionedDataSet'].includes(child.name))
        bad('unknown composite child');
      const index = Number(child.attributes.index ?? blocks.length);
      if (!Number.isSafeInteger(index) || index < 0 || index > 100000 || seen.has(index))
        bad('invalid or repeated composite index');
      seen.add(index);
      while (blocks.length <= index) {
        blocks.push(null);
        names.push('');
      }
      names[index] = child.attributes.name ?? '';
      if (child.name === 'DataSet') {
        const path = child.attributes.file;
        if (!path) continue;
        const target = options.files?.[path] ?? (base ? new URL(path, base) : undefined);
        if (target === undefined) bad(`no file mapping or baseURL for ${path}`);
        blocks[index] = await open(target!, { ...options, baseURL: base }, next, depth + 1);
      } else blocks[index] = await walk(child);
    }
    return createDataSet({ kind, blocks, names }, options);
  };
  return walk(file!.children[0]);
}
