// CGNS SIDS and SIDS-to-HDF5 mapping. One HDF5 group per CGNS node; ' data' stores node values.
import { openHDF5, type HDF5File, type HDF5Node } from './hdf5.js';
import { createDataSet, type DataSet, type DataSetInput, type DataSetCell } from './datasets.js';
import { element, engineeringError as bad, scalar, type EngineeringOptions } from './engineering-common.js';
import type { FileInput } from './file-source.js';
import type { ElementShape } from './datasets-elements.js';
export type { EngineeringOptions } from './engineering-common.js';
/** Selection defaults to every base and zone and the first solution in each zone. */
export interface CGNSOptions extends EngineeringOptions {
  readonly base?: string;
  readonly zone?: string;
  readonly solution?: string;
}
const TYPES: Record<number, [ElementShape | 'point', number]> = {
  2: ['point', 1],
  3: ['curve', 2],
  4: ['curve', 3],
  5: ['triangle', 3],
  6: ['triangle', 6],
  7: ['quad', 4],
  8: ['quad', 8],
  9: ['quad', 9],
  10: ['tetra', 4],
  11: ['tetra', 10],
  12: ['pyramid', 5],
  13: ['pyramid', 14],
  14: ['wedge', 6],
  15: ['wedge', 15],
  16: ['wedge', 18],
  17: ['hex', 8],
  18: ['hex', 20],
  19: ['hex', 27],
  21: ['pyramid', 13],
};
/** Reads structured and mixed/unstructured CGNS/HDF5 zones, including NGON/NFACE polyhedra and field arrays. */
export async function readCGNS(input: FileInput, options: CGNSOptions = {}): Promise<DataSet> {
  using file = await openHDF5(input, options);
  const children = async (path: string): Promise<HDF5Node[]> => {
    const node = await file.get(path, options.signal),
      out: HDF5Node[] = [];
    for (const key of await node.keys(options.signal))
      if (!key.startsWith(' ')) out.push(await file.get(`${path}/${key}`, options.signal));
    return out;
  };
  const label = async (n: HDF5Node) => (await n.attributes(options.signal)).label?.[0];
  const data = async (path: string) => {
    const v = await (await file.get(path + '/ data', options.signal)).read({ signal: options.signal });
    if (!(v instanceof Float64Array)) bad('CGNS node data needs numeric storage');
    return v;
  };
  const string = async (path: string) => String.fromCharCode(...(await data(path))).replace(/\0.*$/s, '');
  const blocks: DataSetInput[] = [],
    names: string[] = [];
  for (const base of await children('/')) {
    if ((await label(base)) !== 'CGNSBase_t' || (options.base && base.path.split('/').at(-1) !== options.base))
      continue;
    for (const zone of await children(base.path)) {
      if ((await label(zone)) !== 'Zone_t' || (options.zone && zone.path.split('/').at(-1) !== options.zone)) continue;
      const nodes = await children(zone.path),
        ofLabel = async (s: string) => {
          const a: HDF5Node[] = [];
          for (const n of nodes) if ((await label(n)) === s) a.push(n);
          return a;
        },
        coords = (await ofLabel('GridCoordinates_t'))[0];
      if (!coords) bad('CGNS zone has no GridCoordinates');
      const arrays: Record<string, Float64Array> = Object.create(null);
      for (const n of await children(coords.path))
        if ((await label(n)) === 'DataArray_t') arrays[n.path.split('/').at(-1)!] = await data(n.path);
      const x = arrays.CoordinateX ?? arrays.CoordinateR,
        y = arrays.CoordinateY ?? arrays.CoordinateTheta,
        z = arrays.CoordinateZ;
      if (!x) bad('CGNS coordinates need Cartesian X/Y/Z or cylindrical R/Theta/Z');
      const points = new Float64Array(x.length * 3);
      for (let i = 0; i < x.length; i++) {
        points[i * 3] = arrays.CoordinateR ? x[i] * Math.cos(y[i]) : x[i];
        points[i * 3 + 1] = arrays.CoordinateR ? x[i] * Math.sin(y[i]) : (y?.[i] ?? 0);
        points[i * 3 + 2] = z?.[i] ?? 0;
      }
      const zoneType = (await ofLabel('ZoneType_t'))[0],
        structured = zoneType && (await string(zoneType.path)) === 'Structured',
        sizes = await data(zone.path);
      const pointArrays: Record<string, Float64Array> = Object.create(null),
        cellArrays: Record<string, Float64Array> = Object.create(null);
      const solutions = await ofLabel('FlowSolution_t'),
        solution = options.solution
          ? solutions.find((s) => s.path.split('/').at(-1) === options.solution)
          : solutions[0];
      if (options.solution && !solution) bad('requested CGNS solution is missing');
      if (solution) {
        const fields = await children(solution.path),
          location = fields.find((s) => s.path.endsWith('/GridLocation')),
          center = location ? await string(location.path) : 'Vertex';
        if (center !== 'Vertex' && center !== 'CellCenter') bad(`CGNS ${center} fields need an explicit projection`);
        for (const n of fields)
          if ((await label(n)) === 'DataArray_t')
            (center === 'Vertex' ? pointArrays : cellArrays)[n.path.split('/').at(-1)!] = await data(n.path);
      }
      let topology: DataSetInput;
      let cellCount: number;
      if (structured) {
        const rank = (await file.get(zone.path + '/ data')).shape.at(-1)!,
          dimensions = [1, 1, 1] as [number, number, number];
        for (let d = 0; d < rank; d++) dimensions[d] = sizes[d];
        cellCount = dimensions.reduce((a, n) => a * Math.max(1, n - 1), 1);
        topology = { kind: 'structured', dimensions, points };
      } else {
        const dimension = (await data(base.path))[0];
        const cells = await cgnsCells(file, await ofLabel('Elements_t'), data, dimension, options.signal);
        cellCount = cells.length;
        topology = { kind: 'unstructured', points, cells };
      }
      blocks.push({
        ...topology,
        pointArrays,
        cellArrays,
        pointData: scalar(pointArrays, x.length, options.scalar),
        cellData: scalar(cellArrays, cellCount, options.scalar),
      });
      names.push(zone.path);
    }
  }
  if (!blocks.length) bad('no matching CGNS zones');
  return createDataSet({ kind: 'multiblock', blocks, names }, options);
}
async function cgnsCells(
  file: HDF5File,
  sections: readonly HDF5Node[],
  data: (path: string) => Promise<Float64Array>,
  dimension: number,
  signal?: AbortSignal,
): Promise<DataSetCell[]> {
  const cells = new Map<number, DataSetCell>(),
    faces = new Map<number, number[]>(),
    poly: { id: number; faces: number[] }[] = [];
  for (const s of sections) {
    const [type] = await data(s.path),
      [start, end] = await data(s.path + '/ElementRange'),
      conn = await data(s.path + '/ElementConnectivity'),
      keys = await s.keys(signal),
      offsets = keys.includes('ElementStartOffset') ? await data(s.path + '/ElementStartOffset') : undefined;
    let at = 0;
    for (let id = start; id <= end; id++) {
      const t = type === 20 ? conn[at++] : type;
      if (t === 22 || t === 23) {
        const n = offsets ? offsets[id - start + 1] - offsets[id - start] : conn[at++],
          ids = Array.from(conn.subarray(at, (at += n)));
        if (t === 22)
          faces.set(
            id,
            ids.map((x) => x - 1),
          );
        else poly.push({ id, faces: ids });
      } else {
        const spec = TYPES[t];
        if (!spec) bad(`unsupported CGNS element type ${t}`);
        const ids = Array.from(conn.subarray(at, (at += spec[1])), (x) => x - 1),
          dim =
            spec[0] === 'point' ? 0 : spec[0] === 'curve' ? 1 : spec[0] === 'triangle' || spec[0] === 'quad' ? 2 : 3;
        if (dim === dimension) cells.set(id, element(spec[0], ids));
      }
    }
    if (at !== conn.length) bad('CGNS connectivity length differs from element range');
  }
  for (const p of poly) {
    const stream = [p.faces.length];
    for (const id of p.faces) {
      const f = faces.get(Math.abs(id));
      if (!f) bad('NFACE refers to missing NGON');
      const ids = id > 0 ? f : [...f].reverse();
      stream.push(ids.length, ...ids);
    }
    cells.set(p.id, { type: 'polyhedron', faces: stream });
  }
  if (!poly.length) for (const [id, ids] of faces) cells.set(id, { type: 7, ids });
  return [...cells].sort(([a], [b]) => a - b).map(([, c]) => c);
}
