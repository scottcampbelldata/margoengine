// Schoof and Yarberry, EXODUS II (SAND92-2137), and the SEACAS database naming specification.
import { openNetCDF, type NetCDFAttribute } from './netcdf.js';
import { openHDF5 } from './hdf5.js';
import { createDataSet, type DataSet, type DataSetCell } from './datasets.js';
import { element, engineeringError as bad, scalar, type EngineeringOptions } from './engineering-common.js';
import { byteLimit, fileSource, readBytes, type FileInput } from './file-source.js';
import type { ElementShape } from './datasets-elements.js';
export type { EngineeringOptions } from './engineering-common.js';
/** Exodus result selection; timeIndex defaults to the first stored step. */
export interface ExodusOptions extends EngineeringOptions {
  readonly timeIndex?: number;
}
/** Original entity IDs and result metadata accompany the normalized mesh. Sets retain one-based Exodus IDs. */
export interface ExodusDataSet extends DataSet {
  readonly times: Float64Array;
  readonly nodeIds: Float64Array;
  readonly elementIds: Float64Array;
  readonly globalVariables: Readonly<Record<string, number>>;
  readonly nodeSets: Readonly<Record<string, Float64Array>>;
  readonly sideSets: Readonly<Record<string, { readonly elements: Float64Array; readonly sides: Float64Array }>>;
  /** Source blocks and their defined results. A partially defined result stays here, not in flattened arrays. */
  readonly elementBlocks: readonly {
    readonly id: number;
    readonly start: number;
    readonly count: number;
    readonly arrays: Readonly<Record<string, Float64Array>>;
  }[];
}
interface Variable {
  shape: readonly number[];
  attributes: Readonly<Record<string, NetCDFAttribute>>;
  read(time?: number): Promise<Float64Array>;
}
/** Reads classic/64-bit-offset Exodus through NetCDF and NetCDF-4 Exodus through the HDF5 owner reader. */
export async function readExodus(input: FileInput, options: ExodusOptions = {}): Promise<ExodusDataSet> {
  const max = byteLimit(options.maxBytes),
    source = fileSource(input, max),
    magic = await readBytes(source, 0, 8, max, options.signal),
    vars: Record<string, Variable> = Object.create(null);
  let dispose: () => void;
  if (magic[0] === 67 && magic[1] === 68) {
    const f = await openNetCDF(source, options);
    dispose = () => f.dispose();
    for (const [name, v] of Object.entries(f.variables))
      vars[name] = {
        shape: v.shape,
        attributes: v.attributes,
        read: (time) =>
          v.read({
            unpack: false,
            signal: options.signal,
            ...(time === undefined
              ? {}
              : { start: v.shape.map((_, d) => (d ? 0 : time)), count: v.shape.map((n, d) => (d ? n : 1)) }),
          }),
      };
  } else {
    const f = await openHDF5(source, options);
    dispose = () => f.dispose();
    for (const name of await (await f.get('/')).keys(options.signal)) {
      const v = await f.get('/' + name, options.signal);
      if (v.kind !== 'dataset') continue;
      const attrs = await v.attributes(options.signal, ['elem_type']),
        attributes: Record<string, NetCDFAttribute> = Object.create(null);
      for (const [key, value] of Object.entries(attrs))
        if (value instanceof Float64Array) attributes[key] = value;
        else attributes[key] = value.join('');
      vars[name] = {
        shape: v.shape,
        attributes,
        async read(time) {
          const a = await v.read({
            signal: options.signal,
            ...(time === undefined
              ? {}
              : { start: v.shape.map((_, d) => (d ? 0 : time)), count: v.shape.map((n, d) => (d ? n : 1)) }),
          });
          if (!(a instanceof Float64Array))
            return Float64Array.from(
              { length: a.length * v.elementBytes },
              (_, i) => a[Math.floor(i / v.elementBytes)].charCodeAt(i % v.elementBytes) || 0,
            );
          return a;
        },
      };
    }
  }
  const read = (name: string, time?: number) => (vars[name] ?? bad(`missing Exodus variable ${name}`)).read(time);
  const strings = async (name: string) => {
    if (!vars[name]) return [];
    const data = await read(name),
      width = vars[name].shape.at(-1)!;
    return Array.from({ length: data.length / width }, (_, i) =>
      String.fromCharCode(...data.subarray(i * width, (i + 1) * width))
        .replace(/\0.*$/s, '')
        .trim(),
    );
  };
  try {
    const coords: Float64Array[] = [];
    if (vars.coord) {
      const all = await read('coord'),
        n = vars.coord.shape[1];
      for (let d = 0; d < vars.coord.shape[0]; d++) coords.push(all.slice(d * n, (d + 1) * n));
    } else for (const axis of ['x', 'y', 'z']) if (vars['coord' + axis]) coords.push(await read('coord' + axis));
    if (!coords.length || coords.some((c) => c.length !== coords[0].length)) bad('Exodus coordinate axes differ');
    const np = coords[0].length,
      points = Float64Array.from({ length: np * 3 }, (_, i) => coords[i % 3]?.[Math.floor(i / 3)] ?? 0),
      cells: DataSetCell[] = [],
      blocks: { id: number; start: number; count: number }[] = [];
    const names = Object.keys(vars)
      .filter((n) => /^connect\d+$/.test(n))
      .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
    for (const name of names) {
      const v = vars[name],
        conn = await read(name),
        raw = v.attributes.elem_type,
        type = typeof raw === 'string' ? raw.toUpperCase() : '',
        count = v.shape[0],
        width = v.shape[1];
      const shape: ElementShape | 'point' = /^HEX/.test(type)
        ? 'hex'
        : /^TET/.test(type)
          ? 'tetra'
          : /^WEDGE|^PRISM/.test(type)
            ? 'wedge'
            : /^PYRAMID/.test(type)
              ? 'pyramid'
              : /^TRI|^SHELL3|^SHELL6/.test(type)
                ? 'triangle'
                : /^QUAD|^SHELL/.test(type)
                  ? 'quad'
                  : /^BAR|^BEAM|^TRUSS|^EDGE/.test(type)
                    ? 'curve'
                    : /^SPHERE|^CIRCLE/.test(type)
                      ? 'point'
                      : bad(`unsupported Exodus element ${type}`);
      blocks.push({ id: Number(name.slice(7)), start: cells.length, count });
      for (let i = 0; i < count; i++)
        cells.push(
          element(
            shape,
            Array.from(conn.subarray(i * width, (i + 1) * width), (x) => x - 1),
          ),
        );
    }
    if (!cells.length) bad('Exodus has no element blocks');
    const times = vars.time_whole ? await read('time_whole') : new Float64Array(),
      time = options.timeIndex ?? 0;
    if (!Number.isInteger(time) || time < 0 || (times.length && time >= times.length)) bad('invalid Exodus time index');
    const pointArrays: Record<string, Float64Array> = Object.create(null),
      cellArrays: Record<string, Float64Array> = Object.create(null),
      globals: Record<string, number> = Object.create(null);
    for (const [i, name] of (await strings('name_nod_var')).entries()) {
      if (vars[`vals_nod_var${i + 1}`]) pointArrays[name] = await read(`vals_nod_var${i + 1}`, time);
      else if (vars.vals_nod_var) {
        const all = await read('vals_nod_var', time);
        pointArrays[name] = all.slice(i * np, (i + 1) * np);
      }
    }
    const blockIds = vars.eb_prop1 ? await read('eb_prop1') : Float64Array.from(blocks, (b) => b.id),
      elementBlocks = blocks.map((b, i) => ({
        id: blockIds[i],
        start: b.start,
        count: b.count,
        arrays: Object.create(null) as Record<string, Float64Array>,
      }));
    for (const [i, name] of (await strings('name_elem_var')).entries()) {
      const values = new Float64Array(cells.length);
      values.fill(NaN);
      for (const [j, b] of blocks.entries()) {
        const key = `vals_elem_var${i + 1}eb${b.id}`;
        if (vars[key]) {
          const a = await read(key, time);
          if (a.length !== b.count) bad('Exodus element result count differs from block');
          values.set(a, b.start);
          elementBlocks[j].arrays[name] = a;
        }
      }
      if (values.every(Number.isFinite)) cellArrays[name] = values;
    }
    if (vars.vals_glo_var) {
      const values = await read('vals_glo_var', time);
      (await strings('name_glo_var')).forEach((n, i) => {
        globals[n] = values[i];
      });
    }
    const nodeSets: Record<string, Float64Array> = Object.create(null),
      sideSets: Record<string, { elements: Float64Array; sides: Float64Array }> = Object.create(null),
      nodeNames = await strings('ns_names'),
      sideNames = await strings('ss_names');
    for (const key of Object.keys(vars)) {
      let m = /^node_ns(\d+)$/.exec(key);
      if (m) nodeSets[nodeNames[Number(m[1]) - 1] || m[1]] = await read(key);
      m = /^elem_ss(\d+)$/.exec(key);
      if (m)
        sideSets[sideNames[Number(m[1]) - 1] || m[1]] = {
          elements: await read(key),
          sides: await read('side_ss' + m[1]),
        };
    }
    const dataset = await createDataSet(
      {
        kind: 'unstructured',
        points,
        cells,
        pointArrays,
        cellArrays,
        pointData: scalar(pointArrays, np, options.scalar),
        cellData: scalar(cellArrays, cells.length, options.scalar),
      },
      options,
    );
    return {
      ...dataset,
      times,
      elementBlocks,
      nodeIds: vars.node_num_map ? await read('node_num_map') : Float64Array.from({ length: np }, (_, i) => i + 1),
      elementIds: vars.elem_num_map
        ? await read('elem_num_map')
        : Float64Array.from({ length: cells.length }, (_, i) => i + 1),
      globalVariables: globals,
      nodeSets,
      sideSets,
    };
  } finally {
    dispose();
  }
}
