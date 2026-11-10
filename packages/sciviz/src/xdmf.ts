import { readXMLTree, type XMLElement } from '@margoengine/loaders/xml';
import { openHDF5, type HDF5File } from './hdf5.js';
import { createDataSet, type DataSet, type DataSetInput, type DataSetCell } from './datasets.js';
import {
  decodeText,
  element,
  engineeringError as bad,
  numbers,
  resource,
  scalar,
  whole,
  type EngineeringOptions,
} from './engineering-common.js';
import { product } from './hdf5-binary.js';
import type { ElementShape } from './datasets-elements.js';
import type { FileInput } from './file-source.js';
export type { EngineeringOptions } from './engineering-common.js';
/** Temporal collections select one index, default 0. Spatial collections preserve block boundaries. */
export interface XDMFOptions extends EngineeringOptions {
  readonly timeIndex?: number;
}
const TOPOLOGY: Record<string, [ElementShape | 'point' | 'polygon', number]> = {
  Polyvertex: ['point', 1],
  Polyline: ['curve', 2],
  Polygon: ['polygon', 0],
  Triangle: ['triangle', 3],
  Quadrilateral: ['quad', 4],
  Tetrahedron: ['tetra', 4],
  Pyramid: ['pyramid', 5],
  Wedge: ['wedge', 6],
  Hexahedron: ['hex', 8],
  Edge_3: ['curve', 3],
  Triangle_6: ['triangle', 6],
  Tri_6: ['triangle', 6],
  Quadrilateral_8: ['quad', 8],
  Quad_8: ['quad', 8],
  Quadrilateral_9: ['quad', 9],
  Tetrahedron_10: ['tetra', 10],
  Tet_10: ['tetra', 10],
  Pyramid_13: ['pyramid', 13],
  Wedge_15: ['wedge', 15],
  Wedge_18: ['wedge', 18],
  Hexahedron_20: ['hex', 20],
  Hexahedron_27: ['hex', 27],
};
const MIXED: Record<number, string> = {
  1: 'Polyvertex',
  2: 'Polyline',
  3: 'Polygon',
  4: 'Triangle',
  5: 'Quadrilateral',
  6: 'Tetrahedron',
  7: 'Pyramid',
  8: 'Wedge',
  9: 'Hexahedron',
  34: 'Edge_3',
  35: 'Quadrilateral_9',
  36: 'Triangle_6',
  37: 'Quadrilateral_8',
  38: 'Tetrahedron_10',
  39: 'Pyramid_13',
  40: 'Wedge_15',
  41: 'Wedge_18',
  48: 'Hexahedron_20',
  50: 'Hexahedron_27',
};
/** Xdmf 2/3 XML/HDF/Binary data items, structured and mixed grids, hyperslabs and spatial/temporal collections. */
export async function readXDMF(input: FileInput, options: XDMFOptions = {}): Promise<DataSet> {
  const root = readXMLTree(decodeText(await whole(input, options)), 'Xdmf'),
    files = new Map<string, HDF5File>();
  const child = (e: XMLElement, name: string) => e.children.find((e) => e.name === name) ?? bad(`missing Xdmf ${name}`);
  const dimensions = (e: XMLElement) => numbers(e.attributes.Dimensions ?? '');
  function dereference(e: XMLElement): XMLElement {
    const ref = e.attributes.Reference;
    if (!ref) return e;
    const path = ref === 'XML' ? e.text.trim() : ref;
    let nodes = [root];
    for (const segment of path.split('/').filter(Boolean)) {
      const m = /^(\w+)(?:\[(?:(\d+)|@Name=['"]([^'"]+)['"])\])?$/.exec(segment);
      if (!m) bad('unsupported Xdmf reference path');
      nodes = nodes.flatMap((n) => {
        const a = n.children.filter((n) => n.name === m[1] && (!m[3] || n.attributes.Name === m[3]));
        return m[2] ? a.slice(Number(m[2]) - 1, Number(m[2])) : a;
      });
    }
    return nodes[0] ?? bad('Xdmf reference does not exist');
  }
  async function item(original: XMLElement, depth = 0): Promise<Float64Array> {
    options.signal?.throwIfAborted();
    if (depth > 64) bad('cyclic Xdmf data reference');
    const e = dereference(original);
    if (e !== original) return item(e, depth + 1);
    const a = e.attributes,
      type = a.ItemType ?? a.Type ?? 'Uniform',
      kids = e.children.filter(
        (n) => n.name === 'DataItem' || n.name === 'DataStructure' || n.name === 'DataTransform',
      );
    if (type === 'HyperSlab') {
      if (kids.length !== 2) bad('HyperSlab needs selector and source');
      const select = await item(kids[0], depth + 1),
        source = dereference(kids[1]),
        shape = dimensions(source),
        rank = shape.length;
      if (select.length !== 3 * rank) bad('invalid Xdmf hyperslab selector');
      const start = Array.from(select.subarray(0, rank)),
        stride = Array.from(select.subarray(rank, 2 * rank)),
        count = Array.from(select.subarray(2 * rank));
      if (
        shape.some(
          (n, d) =>
            !Number.isInteger(start[d]) ||
            start[d] < 0 ||
            !Number.isInteger(stride[d]) ||
            stride[d] < 1 ||
            !Number.isInteger(count[d]) ||
            count[d] < 0 ||
            (count[d] && start[d] + (count[d] - 1) * stride[d] >= n),
        )
      )
        bad('Xdmf hyperslab outside source');
      if (source.attributes.Format === 'HDF')
        return hdf(source.text.trim(), { start, stride, count, signal: options.signal });
      const data = await item(source, depth + 1),
        out = new Float64Array(product(count));
      for (let i = 0; i < out.length; i++) {
        let q = i,
          index = 0,
          mul = 1;
        for (let d = rank - 1; d >= 0; d--) {
          index += (start[d] + (q % count[d]) * stride[d]) * mul;
          mul *= shape[d];
          q = Math.floor(q / count[d]);
        }
        out[i] = data[index];
      }
      return out;
    }
    if (type === 'Function') {
      const f = (a.Function ?? '').replace(/\s/g, ''),
        args = await Promise.all(kids.map((k) => item(k, depth + 1)));
      const join = /^JOIN\((\$\d+(?:,\$\d+)*)\)$/i.exec(f);
      if (!join) bad('Xdmf Function supports JOIN; materialize other expressions in the writer');
      const order = join[1].split(',').map((s) => Number(s.slice(1))),
        n = args[0]?.length ?? 0;
      if (order.some((i) => !args[i] || args[i].length !== n)) bad('JOIN argument lengths differ');
      return Float64Array.from(
        { length: n * order.length },
        (_, i) => args[order[i % order.length]][Math.floor(i / order.length)],
      );
    }
    const shape = dimensions(e),
      n = product(shape);
    let out: Float64Array;
    if (n * 8 > (options.maxBytes ?? 64 * 1024 * 1024)) bad('Xdmf DataItem exceeds maxBytes');
    if (!a.Format || a.Format === 'XML') out = Float64Array.from(numbers(e.text));
    else if (a.Format === 'HDF') out = await hdf(e.text.trim());
    else if (a.Format === 'Binary') {
      const b = await whole(await resource(e.text.trim(), input, options), options),
        size = Number(a.Precision ?? 4),
        seek = Number(a.Seek ?? 0),
        little = a.Endian !== 'Big',
        type = a.NumberType ?? a.DataType ?? 'Float';
      if (![1, 2, 4, 8].includes(size) || !Number.isSafeInteger(seek) || seek < 0 || seek + n * size > b.length)
        bad('invalid binary Xdmf shape or precision');
      const v = new DataView(b.buffer, b.byteOffset + seek, n * size);
      out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const p = i * size;
        if (type === 'Float') {
          if (size !== 4 && size !== 8) bad('invalid float precision');
          out[i] = size === 4 ? v.getFloat32(p, little) : v.getFloat64(p, little);
        } else if (size === 8) {
          out[i] = Number(type === 'UInt' ? v.getBigUint64(p, little) : v.getBigInt64(p, little));
          if (!Number.isSafeInteger(out[i])) bad('Xdmf integer exceeds safe precision');
        } else
          out[i] =
            size === 1
              ? type === 'UInt' || type === 'UChar'
                ? v.getUint8(p)
                : v.getInt8(p)
              : size === 2
                ? type === 'UInt'
                  ? v.getUint16(p, little)
                  : v.getInt16(p, little)
                : type === 'UInt'
                  ? v.getUint32(p, little)
                  : v.getInt32(p, little);
      }
    } else bad(`unknown Xdmf format ${a.Format}`);
    if (shape.length && out.length !== n) bad('Xdmf Dimensions differ from values');
    return out;
  }
  async function hdf(ref: string, selection = {}): Promise<Float64Array> {
    const split = ref.lastIndexOf(':/');
    if (split < 0) bad('HDF reference needs file:/dataset');
    const name = ref.slice(0, split);
    let f = files.get(name);
    if (!f) {
      f = await openHDF5(await resource(name, input, options), options);
      files.set(name, f);
    }
    const a = await (await f.get(ref.slice(split + 1), options.signal)).read(selection);
    if (!(a instanceof Float64Array)) bad('Xdmf HDF values need numeric data');
    return a;
  }
  async function grid(original: XMLElement, depth = 0): Promise<DataSetInput> {
    if (depth > 64) bad('cyclic Xdmf grid');
    const e = dereference(original);
    if (e !== original) return grid(e, depth + 1);
    const grids = e.children.filter((e) => e.name === 'Grid');
    if (grids.length) {
      if (e.attributes.CollectionType === 'Temporal') {
        const i = options.timeIndex ?? 0;
        if (!Number.isInteger(i) || !grids[i]) bad('invalid Xdmf time index');
        return grid(grids[i], depth + 1);
      }
      return {
        kind: 'multiblock',
        blocks: await Promise.all(grids.map((e) => grid(e, depth + 1))),
        names: grids.map((e) => e.attributes.Name ?? ''),
      };
    }
    const t = child(e, 'Topology'),
      g = child(e, 'Geometry'),
      top = t.attributes.TopologyType ?? t.attributes.Type,
      geo = g.attributes.GeometryType ?? g.attributes.Type ?? 'XYZ',
      gd = await Promise.all(g.children.filter((e) => e.name === 'DataItem').map((e) => item(e)));
    let topology: DataSetInput, pointCount: number, cellCount: number;
    const dims = dimensions(t).reverse();
    while (dims.length < 3) dims.push(1);
    if (/RectMesh|CoRectMesh/.test(top)) {
      const axes = [0, 1, 2].map((d) => {
        if (/CoRectMesh/.test(top)) {
          if (!gd[0] || !gd[1]) bad('origin-spacing geometry needs two DataItems');
          // The axes are generated from the topology's Dimensions, so they obey the same byte limit as a DataItem.
          if (!Number.isInteger(dims[d]) || dims[d] < 1 || dims[d] * 8 > (options.maxBytes ?? 64 * 1024 * 1024))
            bad('Xdmf CoRectMesh dimensions exceed maxBytes');
          const rank = gd[0].length;
          return Float64Array.from(
            { length: dims[d] },
            (_, i) => (gd[0][rank - 1 - d] ?? 0) + i * (gd[1][rank - 1 - d] ?? 1),
          );
        }
        return gd[d] ?? Float64Array.of(0);
      }) as [Float64Array, Float64Array, Float64Array];
      pointCount = product(axes.map((a) => a.length));
      cellCount = product(axes.map((a) => Math.max(1, a.length - 1)));
      topology = { kind: 'rectilinear', axes };
    } else {
      let points: Float64Array;
      if (geo === 'XYZ') points = gd[0];
      else if (geo === 'XY')
        points = Float64Array.from({ length: (gd[0].length / 2) * 3 }, (_, i) =>
          i % 3 === 2 ? 0 : gd[0][Math.floor(i / 3) * 2 + (i % 3)],
        );
      else if (geo === 'X_Y_Z' || geo === 'X_Y')
        points = Float64Array.from({ length: gd[0].length * 3 }, (_, i) => gd[i % 3]?.[Math.floor(i / 3)] ?? 0);
      else bad(`unsupported Xdmf geometry ${geo}`);
      if (!points || points.length % 3) bad('invalid Xdmf coordinates');
      pointCount = points.length / 3;
      if (/SMesh$/.test(top)) {
        topology = { kind: 'structured', points, dimensions: dims as [number, number, number] };
        cellCount = product(dims.map((n) => Math.max(1, n - 1)));
      } else {
        const conn = await item(child(t, 'DataItem')),
          cells: DataSetCell[] = [];
        let at = 0;
        while (at < conn.length) {
          const code = top === 'Mixed' ? conn[at++] : 0,
            name = top === 'Mixed' ? MIXED[code] : top;
          if (code === 16) {
            const nf = conn[at++],
              faces = [nf];
            // Each face takes at least its count entry, so the counts are checked against what is left.
            if (!Number.isInteger(nf) || nf < 1 || at + nf > conn.length) bad('invalid Xdmf polyhedron face count');
            for (let f = 0; f < nf; f++) {
              const n = conn[at++];
              if (!Number.isInteger(n) || n < 1 || at + n > conn.length) bad('invalid Xdmf polyhedron face width');
              faces.push(n, ...conn.subarray(at, (at += n)));
            }
            cells.push({ type: 'polyhedron', faces });
            continue;
          }
          const spec = TOPOLOGY[name];
          if (!spec) bad(`unsupported Xdmf topology ${name}`);
          const n = top === 'Mixed' && code <= 3 ? conn[at++] : Number(t.attributes.NodesPerElement ?? spec[1]);
          if (!Number.isInteger(n) || n < 1 || at + n > conn.length) bad('invalid Xdmf cell width');
          const ids = Array.from(conn.subarray(at, (at += n)));
          if (spec[0] === 'curve' && n > 3) cells.push({ type: 4, ids });
          else if (spec[0] === 'point' && n > 1) cells.push({ type: 2, ids });
          else cells.push(element(spec[0], ids));
        }
        topology = { kind: 'unstructured', points, cells };
        cellCount = cells.length;
      }
    }
    const pointArrays: Record<string, Float64Array> = Object.create(null),
      cellArrays: Record<string, Float64Array> = Object.create(null);
    for (const a of e.children.filter((e) => e.name === 'Attribute')) {
      const center = a.attributes.Center ?? 'Node';
      if (center !== 'Node' && center !== 'Cell') bad(`unsupported Xdmf attribute center ${center}`);
      (center === 'Node' ? pointArrays : cellArrays)[a.attributes.Name ?? 'value'] = await item(child(a, 'DataItem'));
    }
    return {
      ...topology,
      pointArrays,
      cellArrays,
      pointData: scalar(pointArrays, pointCount, options.scalar),
      cellData: scalar(cellArrays, cellCount, options.scalar),
    };
  }
  try {
    const domain = child(child(root, 'Xdmf'), 'Domain'),
      grids = domain.children.filter((e) => e.name === 'Grid');
    if (!grids.length) bad('Xdmf Domain has no grids');
    return await createDataSet(
      grids.length === 1
        ? await grid(grids[0])
        : {
            kind: 'multiblock',
            blocks: await Promise.all(grids.map((e) => grid(e))),
            names: grids.map((e) => e.attributes.Name ?? ''),
          },
      options,
    );
  } finally {
    for (const file of files.values()) file.dispose();
  }
}
