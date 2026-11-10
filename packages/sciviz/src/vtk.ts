// The only XML decoder is @margoengine/loaders/vtk-xml. This entry adapts its lazy arrays to sciviz.
import type { VTKXMLDataset, VTKXMLArray } from '@margoengine/loaders/vtk-xml';
import { rangeError } from '../../shared/errors.js';
import { byteLimit, fileSource, readBytes, type FileInput, type FileOptions } from './file-source.js';
import type { VolumeGrid } from './formats.js';
import type { UnstructuredGrid } from './grids.js';
export { parseVtk } from './grids.js';
export type { VtkGrid } from './grids.js';
export type { FileInput, FileOptions, FileSource } from './file-source.js';

/** Lazy VTK dataset with explicit piece and field selection. */
export interface VTKFile {
  readonly dataset: VTKXMLDataset;
  /** ImageData scalar samples; point or cell centred, with extent-aware physical bounds. */
  volume(
    name: string,
    options?: { piece?: number; association?: 'point' | 'cell'; component?: number; signal?: AbortSignal },
  ): Promise<VolumeGrid>;
  /** UnstructuredGrid topology, or StructuredGrid converted to implicit hexahedra. No surface extraction. */
  grid(
    name?: string,
    options?: { piece?: number; association?: 'point' | 'cell'; component?: number; signal?: AbortSignal },
  ): Promise<UnstructuredGrid>;
  dispose(): void;
  [Symbol.dispose](): void;
}

const bad = (message: string) => rangeError(`VTK: ${message}`, 'sciviz');
function numbers(text: string | undefined, count: number, fallback?: number[]): number[] {
  const values = text === undefined ? fallback : text.trim().split(/\s+/).map(Number);
  if (!values || values.length !== count || !values.every(Number.isFinite))
    throw bad('invalid extent, origin or spacing');
  return values;
}
function extent(text: string | undefined): { extent: number[]; dims: [number, number, number] } {
  const e = numbers(text, 6),
    dims = [e[1] - e[0] + 1, e[3] - e[2] + 1, e[5] - e[4] + 1] as [number, number, number];
  if (!e.every(Number.isSafeInteger) || dims.some((n) => n < 1) || !Number.isSafeInteger(dims[0] * dims[1] * dims[2]))
    throw bad('invalid structured extent');
  return { extent: e, dims };
}

/**
 * Opens .vtu/.vti/.vts metadata lazily. Raw appended arrays use byte Range requests; inline and base64 files
 * load within maxBytes. Arrays use the existing loader's ASCII, binary, appended and compressed decoders.
 */
export async function openVTK(input: FileInput, options: FileOptions = {}): Promise<VTKFile> {
  const max = byteLimit(options.maxBytes),
    source = fileSource(input, max),
    lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  let bytes = new Uint8Array(),
    appendedAt = -1,
    chunk = 4096;
  for (;;) {
    const part = await readBytes(source, bytes.length, Math.min(chunk, max - bytes.length), max, signal);
    chunk = Math.min(max, chunk * 2);
    const joined = new Uint8Array(bytes.length + part.length);
    joined.set(bytes);
    joined.set(part, bytes.length);
    bytes = joined;
    const text = new TextDecoder('latin1').decode(bytes),
      tag = text.indexOf('<AppendedData');
    if (tag >= 0) {
      const end = text.indexOf('>', tag),
        mark = end < 0 ? -1 : text.indexOf('_', end);
      if (mark >= 0 && /encoding\s*=\s*["']raw["']/.test(text.slice(tag, end))) {
        appendedAt = mark + 1;
        break;
      }
    }
    if (text.includes('</VTKFile>')) break;
    if (!part.length || bytes.length === max) throw bad('XML header/file is truncated or exceeds maxBytes');
  }
  const { openVTKXMLDataset } = await import('@margoengine/loaders/vtk-xml');
  const dataset = openVTKXMLDataset(appendedAt < 0 ? bytes : bytes.subarray(0, appendedAt), {
    signal,
    maxBytes: max,
    ...(appendedAt < 0
      ? {}
      : {
          readAppended: (offset: number, length: number, current?: AbortSignal) =>
            readBytes(source, appendedAt + offset, length, max, current ?? signal),
        }),
  });
  const get = (index = 0) => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(index) || !dataset.pieces[index]) throw bad('piece index is out of range');
    return dataset.pieces[index];
  };
  const selected = async (
    array: VTKXMLArray | undefined,
    tuples: number,
    component = 0,
    current?: AbortSignal,
  ): Promise<Float64Array> => {
    if (!array) throw bad('named field is absent');
    if (!Number.isSafeInteger(component) || component < 0 || component >= array.components)
      throw bad('component index is out of range');
    const all = await array.read(current);
    if (all.length !== tuples * array.components) throw bad('field tuple count differs from geometry');
    return Float64Array.from({ length: tuples }, (_, i) => all[i * array.components + component]);
  };
  const dispose = () => lifetime.abort();
  return {
    dataset,
    dispose,
    [Symbol.dispose]: dispose,
    async volume(name, opts = {}) {
      if (dataset.type !== 'ImageData')
        throw bad('volume requires ImageData; use grid for a curvilinear or unstructured file');
      const p = get(opts.piece),
        { dims: pointDims, extent: e } = extent(p.attributes.Extent ?? dataset.attributes.WholeExtent);
      const cell = (opts.association ?? 'point') === 'cell',
        dims = pointDims.map((n) => (cell ? Math.max(1, n - 1) : n)) as [number, number, number];
      const origin = numbers(dataset.attributes.Origin, 3, [0, 0, 0]),
        spacing = numbers(dataset.attributes.Spacing, 3, [1, 1, 1]);
      const direction = numbers(dataset.attributes.Direction, 9, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      if (direction.some((n, i) => n !== (i % 4 === 0 ? 1 : 0)))
        throw bad('oriented ImageData needs resampling before axis-aligned volume rendering');
      if (spacing.some((n) => n === 0)) throw bad('spacing must be nonzero');
      const data = await selected(
        (cell ? p.cellData : p.pointData)[name],
        dims[0] * dims[1] * dims[2],
        opts.component,
        opts.signal,
      );
      // Volume samples are x-fastest. Reverse descending axes so the renderer's ascending box retains orientation.
      const ordered = new Float64Array(data.length);
      for (let z = 0; z < dims[2]; z++)
        for (let y = 0; y < dims[1]; y++)
          for (let x = 0; x < dims[0]; x++) {
            const sx = spacing[0] < 0 ? dims[0] - 1 - x : x,
              sy = spacing[1] < 0 ? dims[1] - 1 - y : y,
              sz = spacing[2] < 0 ? dims[2] - 1 - z : z;
            ordered[(z * dims[1] + y) * dims[0] + x] = data[(sz * dims[1] + sy) * dims[0] + sx];
          }
      const bounds: VolumeGrid['bounds'] = [0, 0, 0, 0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const first = origin[a] + (e[a * 2] + (cell && pointDims[a] > 1 ? 0.5 : 0)) * spacing[a],
          last = first + (dims[a] - 1) * spacing[a];
        bounds[a * 2] = Math.min(first, last);
        bounds[a * 2 + 1] = Math.max(first, last);
        if (first === last) {
          bounds[a * 2] -= Math.abs(spacing[a]) / 2;
          bounds[a * 2 + 1] += Math.abs(spacing[a]) / 2;
        }
      }
      let lo = Infinity,
        hi = -Infinity;
      for (const value of ordered)
        if (Number.isFinite(value)) {
          lo = Math.min(lo, value);
          hi = Math.max(hi, value);
        }
      signal.throwIfAborted();
      opts.signal?.throwIfAborted();
      return { data: ordered, dims, bounds, range: lo === Infinity ? [0, 0] : [lo, hi] };
    },
    async grid(name, opts = {}) {
      const p = get(opts.piece);
      if (dataset.type !== 'UnstructuredGrid' && dataset.type !== 'StructuredGrid')
        throw bad('grid requires UnstructuredGrid or StructuredGrid');
      if (!p.points) throw bad('piece has no points');
      const points = await p.points.read(opts.signal);
      if (points.length % 3 || p.points.components !== 3) throw bad('points need three components');
      let connectivity: Float64Array, offsets: Float64Array, types: Float64Array;
      if (dataset.type === 'UnstructuredGrid') {
        for (const key of ['connectivity', 'offsets', 'types']) if (!p.cells[key]) throw bad(`missing ${key} array`);
        // Sequential reads let one caller cancel without leaving unobserved sibling failures.
        connectivity = await p.cells.connectivity.read(opts.signal);
        offsets = await p.cells.offsets.read(opts.signal);
        types = await p.cells.types.read(opts.signal);
      } else {
        const { dims } = extent(p.attributes.Extent ?? dataset.attributes.WholeExtent),
          [nx, ny, nz] = dims;
        if (points.length !== nx * ny * nz * 3) throw bad('point count differs from structured extent');
        if (dims.some((n) => n < 2)) throw bad('grid rendering requires three non-singleton structured axes');
        const n = (nx - 1) * (ny - 1) * (nz - 1);
        if (n * 8 * 8 > max) throw bad('structured connectivity exceeds maxBytes');
        connectivity = new Float64Array(n * 8);
        offsets = new Float64Array(n);
        types = new Float64Array(n).fill(12);
        let c = 0;
        for (let z = 0; z + 1 < nz; z++)
          for (let y = 0; y + 1 < ny; y++)
            for (let x = 0; x + 1 < nx; x++, c++) {
              const i = (z * ny + y) * nx + x;
              connectivity.set(
                [i, i + 1, i + nx + 1, i + nx, i + nx * ny, i + nx * ny + 1, i + nx * ny + nx + 1, i + nx * ny + nx],
                c * 8,
              );
              offsets[c] = (c + 1) * 8;
            }
      }
      let start = 0;
      if (types.length !== offsets.length) throw bad('cell types and offsets differ');
      for (const end of offsets) {
        if (!Number.isSafeInteger(end) || end < start || end > connectivity.length) throw bad('invalid cell offset');
        start = end;
      }
      if (
        start !== connectivity.length ||
        connectivity.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= points.length / 3)
      )
        throw bad('invalid cell connectivity');
      if (
        dataset.type === 'UnstructuredGrid' &&
        (Number(p.attributes.NumberOfPoints) !== points.length / 3 ||
          Number(p.attributes.NumberOfCells) !== types.length)
      )
        throw bad('piece counts differ from topology');
      const cell = (opts.association ?? 'point') === 'cell';
      const values =
        name === undefined
          ? undefined
          : await selected(
              (cell ? p.cellData : p.pointData)[name],
              cell ? types.length : points.length / 3,
              opts.component,
              opts.signal,
            );
      signal.throwIfAborted();
      opts.signal?.throwIfAborted();
      return {
        points,
        connectivity,
        offsets,
        types,
        ...(values ? (cell ? { cellData: values } : { pointData: values }) : {}),
      };
    },
  };
}
