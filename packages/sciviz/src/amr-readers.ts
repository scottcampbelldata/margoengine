// Layout sources: AMReX IO manual; Enzo 2.6 Output Formats; FLASH 4 User Guide section 9.9.
import { createAMR, amrError, type AMRBlock, type AMRData, type AMROptions } from './amr-data.js';
import { openHDF5, type HDF5Values, type HDF5File } from './hdf5.js';
import { decodeText, numbers, resource, whole, type EngineeringOptions } from './engineering-common.js';
import { byteLimit, fileSource, readBytes, type FileInput } from './file-source.js';
import type { Bounds } from './layer.js';

/** Companion paths use files, resolve or baseURL; scalar defaults to the first stored field. */
export interface AMRReadOptions extends EngineeringOptions, AMROptions {
  /** Enzo refinement factor used to infer integer levels. Default 2. */
  readonly refinement?: number;
}
const tuple = (a: readonly number[], fill: number): [number, number, number] => [
  a[0] ?? fill,
  a[1] ?? fill,
  a[2] ?? fill,
];
const numeric = (a: HDF5Values): Float64Array => {
  if (!(a instanceof Float64Array)) amrError('expected numeric HDF5 samples');
  return a as Float64Array;
};
const hvalues = async (f: HDF5File, path: string, o: AMRReadOptions) =>
  numeric(await (await f.get(path, o.signal)).read({ signal: o.signal }));

/** Read a native AMReX/BoxLib cell-centred plotfile Header and its MultiFab companions, lazily per scalar. */
export async function readAMReX(input: FileInput, options: AMRReadOptions = {}): Promise<AMRData> {
  const lines = decodeText(await whole(input, options))
    .trim()
    .split(/\r?\n/);
  let at = 0;
  const line = () => lines[at++]?.trim() ?? amrError('truncated AMReX Header');
  const ns = () => numbers(line());
  line();
  const count = Number(line());
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) amrError('invalid AMReX component count');
  const fields = Array.from({ length: count }, line),
    component = options.scalar === undefined ? 0 : fields.indexOf(options.scalar);
  if (component < 0) amrError(`AMReX field ${options.scalar} does not exist`);
  const rank = Number(line());
  line();
  const finest = Number(line());
  if (![1, 2, 3].includes(rank) || !Number.isSafeInteger(finest) || finest < 0 || finest > 64)
    amrError('invalid plotfile rank or level count');
  ns();
  ns();
  line();
  line();
  line();
  for (let level = 0; level <= finest; level++) ns();
  if (Number(line()) !== 0) amrError('AMReX non-Cartesian coordinates require a coordinate transform');
  line();
  const blocks: AMRBlock[] = [];
  for (let level = 0; level <= finest; level++) {
    const header = ns(),
      n = header[1];
    line();
    if (header[0] !== level || !Number.isSafeInteger(n) || n < 0) amrError('invalid AMReX level header');
    const bounds = Array.from({ length: n }, () => {
      const b = [0, 1, 0, 1, 0, 1];
      for (let k = 0; k < rank; k++) {
        const q = ns();
        b[2 * k] = q[0];
        b[2 * k + 1] = q[1];
      }
      return b as unknown as Bounds;
    });
    const prefix = line(),
      cellInput = await resource(prefix + '_H', input, options),
      cellHeader = decodeText(await whole(cellInput, options)),
      entries = [...cellHeader.matchAll(/FabOnDisk:\s+(\S+)\s+(\d+)/g)],
      activeBoxes = [...cellHeader.matchAll(/^\s*\(\(([^)]+)\)\s*\(([^)]+)\)\s*\(([^)]+)\)\)\s*$/gm)];
    if (entries.length !== n || activeBoxes.length !== n) amrError('AMReX FAB table differs from level block count');
    for (let i = 0; i < n; i++) {
      options.signal?.throwIfAborted();
      const name = prefix.slice(0, prefix.lastIndexOf('/') + 1) + entries[i][1],
        dataInput = await resource(name, input, options),
        max = byteLimit(options.maxBytes),
        source = fileSource(dataInput, max),
        offset = Number(entries[i][2]),
        prefixBytes = await readBytes(source, offset, 1024, max, options.signal),
        end = prefixBytes.indexOf(10);
      if (end < 0) amrError('FAB descriptor exceeds 1024 bytes');
      const h = decodeText(prefixBytes.subarray(0, end)),
        descriptor =
          /^FAB\s+\(\((4|8),\s*\(([^)]+)\)\),\s*\((4|8),\s*\(([^)]+)\)\)\)\s*\(\(([^)]+)\)\s*\(([^)]+)\)\s*\(([^)]+)\)\)\s+(\d+)\s*$/.exec(
            h,
          );
      if (!descriptor) amrError('expected a native IEEE FAB descriptor');
      const width = Number(descriptor[1]),
        order = numbers(descriptor[4]),
        little = order[0] === width,
        format = numbers(descriptor[2]),
        lo = descriptor[5].split(',').map(Number),
        hi = descriptor[6].split(',').map(Number),
        centering = descriptor[7].split(',').map(Number),
        dims = tuple(
          lo.map((v, k) => hi[k] - v + 1),
          1,
        );
      if (
        Number(descriptor[8]) !== count ||
        Number(descriptor[3]) !== width ||
        order.length !== width ||
        !order.every((v, k) => v === (little ? width - k : k + 1)) ||
        format[0] !== width * 8 ||
        format[1] !== (width === 8 ? 11 : 8) ||
        format[2] !== (width === 8 ? 52 : 23) ||
        centering.some((v) => v !== 0) ||
        dims.some((v) => !Number.isSafeInteger(v) || v < 1)
      )
        amrError('FAB must contain cell-centred IEEE32/64 with a consistent component count');
      const activeLow = tuple(activeBoxes[i][1].split(',').map(Number), 0),
        activeHigh = tuple(activeBoxes[i][2].split(',').map(Number), 0),
        activeDims = activeLow.map((v, k) => activeHigh[k] - v + 1) as [number, number, number],
        fabLow = tuple(lo, 0);
      if (activeDims.some((v, k) => v < 1 || activeLow[k] < fabLow[k] || activeHigh[k] >= fabLow[k] + dims[k]))
        amrError('active FAB box lies outside its stored ghost box');
      const size = dims.reduce((a, v) => a * v, 1),
        bytes = await readBytes(source, offset + end + 1 + component * size * width, size * width, max, options.signal);
      if (bytes.length !== size * width) amrError('truncated FAB scalar');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        values = Float64Array.from({ length: activeDims.reduce((a, v) => a * v, 1) }, (_, j) => {
          const c = [
              j % activeDims[0],
              Math.floor(j / activeDims[0]) % activeDims[1],
              Math.floor(j / activeDims[0] / activeDims[1]),
            ].map((v, k) => v + activeLow[k] - fabLow[k]),
            offset = ((c[2] * dims[1] + c[1]) * dims[0] + c[0]) * width;
          return width === 8 ? view.getFloat64(offset, little) : view.getFloat32(offset, little);
        });
      blocks.push({ id: `${level}:${i}:${fields[component]}`, level, dims: activeDims, bounds: bounds[i], values });
    }
  }
  return createAMR(blocks, options);
}

/** Enzo ASCII or HDF5 hierarchy, with HDF5 baryon groups and optional stored ghost zones. */
export async function readEnzo(input: FileInput, options: AMRReadOptions = {}): Promise<AMRData> {
  const bytes = await whole(input, options),
    rows: { id: string; fields: Record<string, string | readonly number[]>; level?: number }[] = [];
  if (bytes[0] === 137 && bytes[1] === 72) {
    using hierarchy = await openHDF5(bytes, options);
    for (const key of await (await hierarchy.get('/')).keys(options.signal)) {
      const level = /^Level(\d+)$/.exec(key);
      if (!level) continue;
      for (const name of await (await hierarchy.get(key)).keys(options.signal)) {
        if (!/^Grid\d+$/.test(name)) continue;
        const path = key + '/' + name,
          node = await hierarchy.get(path),
          attrs = await node.attributes(options.signal, ['BaryonFileName']);
        const fields: Record<string, string | readonly number[]> = {
          BaryonFileName: String(attrs.BaryonFileName?.[0] ?? ''),
        };
        for (const k of ['GridDimension', 'GridStartIndex', 'GridEndIndex', 'GridLeftEdge', 'GridRightEdge'])
          fields[k] = Array.from(await hvalues(hierarchy, path + '/' + k, options));
        rows.push({ id: name.replace('Grid', ''), fields, level: Number(level[1]) });
      }
    }
  } else {
    for (const match of decodeText(bytes).matchAll(/(?:^|\n)Grid\s*=\s*(\d+)\s*\r?\n([\s\S]*?)(?=(?:\nGrid\s*=)|$)/g)) {
      const fields: Record<string, string | readonly number[]> = {};
      for (const field of match[2].matchAll(/^\s*(\w+)\s*=\s*(.*?)\s*$/gm)) fields[field[1]] = field[2];
      rows.push({ id: match[1], fields });
    }
  }
  if (!rows.length) amrError('no grids in the Enzo hierarchy');
  const metadata = rows.map((row) => {
    const ns = (key: string) =>
      typeof row.fields[key] === 'string' ? numbers(row.fields[key] as string) : (row.fields[key] as readonly number[]);
    const start = tuple(ns('GridStartIndex') ?? [], 0),
      end = tuple(ns('GridEndIndex') ?? [], 0),
      dims = tuple(
        end.map((v, k) => v - start[k] + 1),
        1,
      ),
      lo = tuple(ns('GridLeftEdge') ?? [], 0),
      hi = tuple(ns('GridRightEdge') ?? [], 1),
      full = tuple(ns('GridDimension') ?? [], 1);
    return { ...row, start, dims, full, bounds: lo.flatMap((v, k) => [v, hi[k]]) as unknown as Bounds };
  });
  const base = Math.max(...metadata.map((b) => (b.bounds[1] - b.bounds[0]) / b.dims[0])),
    factor = options.refinement ?? 2;
  if (!(factor > 1) || !Number.isFinite(factor)) amrError('Enzo refinement must exceed one');
  const cache = new Map<string, HDF5File>(),
    blocks: AMRBlock[] = [];
  try {
    for (const b of metadata) {
      const name = String(b.fields.BaryonFileName ?? '').replace(/^['"]|['"]$/g, '');
      if (!name) amrError('Enzo grid has no BaryonFileName');
      let f = cache.get(name);
      if (!f) {
        f = await openHDF5(await resource(name, input, options), options);
        cache.set(name, f);
      }
      const group = '/Grid' + b.id.padStart(8, '0'),
        keys = await (await f.get(group, options.signal)).keys(options.signal),
        field = options.scalar ?? keys[0];
      if (!keys.includes(field)) amrError(`Enzo field ${field} does not exist`);
      const node = await f.get(group + '/' + field, options.signal),
        active = b.dims.slice(0, node.shape.length).reverse(),
        full = b.full.slice(0, node.shape.length).reverse();
      let values: Float64Array;
      if (node.shape.every((n, k) => n === active[k])) values = numeric(await node.read({ signal: options.signal }));
      else if (node.shape.every((n, k) => n === full[k]))
        values = numeric(
          await node.read({
            start: b.start.slice(0, node.shape.length).reverse(),
            count: active,
            signal: options.signal,
          }),
        );
      else amrError('Enzo dataset shape differs from active or ghost-inclusive dimensions');
      const rawLevel = Math.log(base / ((b.bounds[1] - b.bounds[0]) / b.dims[0])) / Math.log(factor),
        level = b.level ?? Math.round(rawLevel);
      if (b.level === undefined && Math.abs(rawLevel - level) > 1e-7)
        amrError('Enzo spacing is not an integer refinement level');
      blocks.push({ id: b.id, level, dims: b.dims, bounds: b.bounds, values: values! });
    }
    return createAMR(blocks, options);
  } finally {
    for (const f of cache.values()) f.dispose();
  }
}

/** FLASH HDF5 plotfile/checkpoint: refine level, node type, bounding box and per-variable block arrays. */
export async function readFLASH(input: FileInput, options: AMRReadOptions = {}): Promise<AMRData> {
  using f = await openHDF5(input, options);
  const levels = await hvalues(f, '/refine level', options),
    types = await hvalues(f, '/node type', options),
    box = await f.get('/bounding box', options.signal),
    bounds = await hvalues(f, '/bounding box', options),
    root = await f.get('/'),
    keys = await root.keys(options.signal);
  let field = options.scalar;
  if (field === undefined) {
    const names = await (await f.get('/unknown names', options.signal)).read({ signal: options.signal });
    if (names instanceof Float64Array) amrError('FLASH unknown names must contain strings');
    field = String(names[0]).trim();
  }
  const stored = keys.find((k) => k.trim() === field);
  if (!stored) amrError(`FLASH variable ${field} does not exist`);
  const node = await f.get('/' + stored, options.signal),
    shape = node.shape;
  if (
    shape.length !== 4 ||
    shape[0] !== levels.length ||
    types.length !== levels.length ||
    box.shape[0] !== levels.length ||
    box.shape[2] !== 2 ||
    box.shape[1] < 1 ||
    box.shape[1] > 3
  )
    amrError('FLASH metadata and block array shapes differ');
  const blocks: AMRBlock[] = [],
    rank = box.shape[1];
  for (let i = 0; i < levels.length; i++) {
    if (types[i] !== 1) continue;
    const b = [0, 1, 0, 1, 0, 1];
    for (let k = 0; k < rank; k++) {
      b[2 * k] = bounds[(i * rank + k) * 2];
      b[2 * k + 1] = bounds[(i * rank + k) * 2 + 1];
    }
    blocks.push({
      id: String(i),
      level: levels[i],
      dims: [shape[3], shape[2], shape[1]],
      bounds: b as unknown as Bounds,
      values: numeric(await node.read({ start: [i, 0, 0, 0], count: [1, ...shape.slice(1)], signal: options.signal })),
    });
  }
  return createAMR(blocks, options);
}
