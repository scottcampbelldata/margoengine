// Ansys EnSight User Manual, Gold case, geometry and variable file specification.
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
import type { ElementShape } from './datasets-elements.js';
import type { FileInput } from './file-source.js';
export type { EngineeringOptions } from './engineering-common.js';
/** Selected Gold time index and binary byte order. Defaults: first step, little endian. */
export interface EnSightOptions extends EngineeringOptions {
  readonly timeIndex?: number;
  /** Binary numbers default little endian. Set false for big-endian files. */
  readonly littleEndian?: boolean;
}
interface Part {
  id: number;
  name: string;
  points: Float64Array;
  cells: DataSetCell[];
  dimensions?: [number, number, number];
  groups: { type: string; offset: number; count: number }[];
  pointArrays: Record<string, Float64Array>;
  cellArrays: Record<string, Float64Array>;
}
const TYPES: Record<string, [ElementShape | 'point', number]> = {
  point: ['point', 1],
  bar2: ['curve', 2],
  bar3: ['curve', 3],
  tria3: ['triangle', 3],
  tria6: ['triangle', 6],
  quad4: ['quad', 4],
  quad8: ['quad', 8],
  tetra4: ['tetra', 4],
  tetra10: ['tetra', 10],
  pyramid5: ['pyramid', 5],
  pyramid13: ['pyramid', 13],
  penta6: ['wedge', 6],
  penta15: ['wedge', 15],
  hexa8: ['hex', 8],
  hexa20: ['hex', 20],
};
class Gold {
  at = 0;
  afterNumber = false;
  readonly binary: boolean;
  readonly view: DataView;
  readonly ascii: string;
  constructor(
    readonly bytes: Uint8Array,
    readonly little: boolean,
  ) {
    this.binary = decodeText(bytes.subarray(0, 80)).startsWith('C Binary');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    this.ascii = this.binary ? '' : decodeText(bytes);
  }
  done(): boolean {
    return this.binary ? this.at >= this.bytes.length : !this.ascii.slice(this.at).trim();
  }
  line(): string {
    if (this.binary) {
      if (this.at + 80 > this.bytes.length) bad('truncated EnSight string record');
      const s = decodeText(this.bytes.subarray(this.at, this.at + 80))
        .replace(/\0.*$/s, '')
        .trim();
      this.at += 80;
      return s;
    }
    if (this.afterNumber) while (this.at < this.ascii.length && /\s/.test(this.ascii[this.at])) this.at++;
    this.afterNumber = false;
    const stop = this.ascii.indexOf('\n', this.at),
      end = stop < 0 ? this.ascii.length : stop,
      s = this.ascii.slice(this.at, end).trim();
    this.at = end + 1;
    return s;
  }
  number(integer = false): number {
    let n: number;
    if (this.binary) {
      if (this.at + 4 > this.bytes.length) bad('truncated EnSight numeric record');
      n = integer ? this.view.getInt32(this.at, this.little) : this.view.getFloat32(this.at, this.little);
      this.at += 4;
    } else {
      while (this.at < this.ascii.length && /\s/.test(this.ascii[this.at])) this.at++;
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?/.exec(this.ascii.slice(this.at));
      if (!m) bad('invalid EnSight numeric record');
      this.at += m[0].length;
      n = Number(m[0].replace(/[dD]/, 'e'));
    }
    this.afterNumber = true;
    if (!Number.isFinite(n) || (integer && !Number.isSafeInteger(n))) bad('invalid EnSight number');
    return n;
  }
  count(): number {
    const n = this.number(true);
    if (n < 0 || n > this.bytes.length) bad('EnSight count exceeds input bound');
    return n;
  }
  values(n: number, integer = false): Float64Array {
    if (n < 0 || !Number.isSafeInteger(n) || n * (this.binary ? 4 : 1) > this.bytes.length)
      bad('invalid EnSight array length');
    return Float64Array.from({ length: n }, () => this.number(integer));
  }
  peek(): string {
    const at = this.at,
      afterNumber = this.afterNumber,
      s = this.line();
    this.at = at;
    this.afterNumber = afterNumber;
    return s;
  }
}
function gold(bytes: Uint8Array, little: boolean): Gold {
  // Fortran unformatted files wrap each logical write in matching four-byte byte counts.
  const head = decodeText(bytes.subarray(4, 84));
  const prefix = bytes.length >= 88 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.length) : undefined;
  if (prefix?.getUint32(0, little) === 80 && prefix.getUint32(84, little) === 80) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
      parts: Uint8Array[] = [];
    let at = 0,
      size = 0;
    while (at < bytes.length) {
      if (at + 8 > bytes.length) bad('truncated Fortran EnSight record');
      const n = v.getUint32(at, little);
      if (at + n + 8 > bytes.length || v.getUint32(at + n + 4, little) !== n)
        bad('EnSight Fortran record markers differ');
      parts.push(bytes.subarray(at + 4, at + 4 + n));
      size += n;
      at += n + 8;
    }
    const data = new Uint8Array(size);
    at = 0;
    for (const p of parts) {
      data.set(p, at);
      at += p.length;
    }
    if (head.startsWith('Fortran Binary') || head.startsWith('C Binary')) {
      data.fill(32, 0, 80);
      data.set(new TextEncoder().encode('C Binary'));
      return new Gold(data, little);
    }
    return new Gold(withBinaryMarker(data), little);
  }
  return new Gold(bytes, little);
}
function geometry(g: Gold, time: number): Part[] {
  if (g.binary) g.line();
  if (g.peek() === 'BEGIN TIME STEP') {
    for (let i = 0; i < time; i++) {
      while (!g.done() && g.line() !== 'END TIME STEP') {}
      if (g.done()) bad('missing EnSight geometry time step');
    }
    if (g.line() !== 'BEGIN TIME STEP') bad('missing EnSight geometry time marker');
  }
  g.line();
  g.line();
  const nodeIds = /\b(?:given|ignore)\b/.test(g.line()),
    elementIds = /\b(?:given|ignore)\b/.test(g.line());
  if (g.peek() === 'extents') {
    g.line();
    g.values(6);
  }
  const parts: Part[] = [];
  while (!g.done() && g.peek() !== 'END TIME STEP') {
    if (g.line() !== 'part') bad('expected EnSight part');
    const id = g.count(),
      name = g.line(),
      mode = g.line();
    const p: Part = {
      id,
      name,
      points: new Float64Array(),
      cells: [],
      groups: [],
      pointArrays: Object.create(null),
      cellArrays: Object.create(null),
    };
    if (mode.startsWith('block')) {
      const dims = [g.count(), g.count(), g.count()] as [number, number, number],
        n = dims.reduce((a, b) => a * b, 1);
      p.dimensions = dims;
      if (mode.includes('uniform')) {
        const o = g.values(3),
          delta = g.values(3);
        p.points = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
          let q = i;
          for (let d = 0; d < 3; d++) {
            p.points[i * 3 + d] = o[d] + (q % dims[d]) * delta[d];
            q = Math.floor(q / dims[d]);
          }
        }
      } else if (mode.includes('rectilinear')) {
        const axes = dims.map((n) => g.values(n));
        p.points = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
          let q = i;
          for (let d = 0; d < 3; d++) {
            p.points[i * 3 + d] = axes[d][q % dims[d]];
            q = Math.floor(q / dims[d]);
          }
        }
      } else {
        const xyz = g.values(n * 3);
        p.points = Float64Array.from({ length: n * 3 }, (_, i) => xyz[(i % 3) * n + Math.floor(i / 3)]);
      }
      const nc = dims.reduce((a, b) => a * Math.max(1, b - 1), 1);
      p.groups.push({ type: 'block', offset: 0, count: nc });
      if (mode.includes('iblanked')) {
        const blank = g.values(n, true);
        p.pointArrays.iblank = blank;
      }
    } else if (mode === 'coordinates') {
      const n = g.count();
      if (nodeIds) g.values(n, true);
      const xyz = g.values(n * 3);
      p.points = Float64Array.from({ length: n * 3 }, (_, i) => xyz[(i % 3) * n + Math.floor(i / 3)]);
      while (!g.done() && g.peek() !== 'part' && g.peek() !== 'END TIME STEP') {
        const type = g.line(),
          count = g.count();
        if (elementIds) g.values(count, true);
        p.groups.push({ type, offset: p.cells.length, count });
        if (type === 'nsided' || type === 'g_nsided') {
          const sizes = g.values(count, true);
          for (const n of sizes) p.cells.push({ type: 7, ids: Array.from(g.values(n, true), (n) => n - 1) });
        } else if (type === 'nfaced' || type === 'g_nfaced') {
          const faces = g.values(count, true),
            sizes = g.values(
              faces.reduce((a, b) => a + b, 0),
              true,
            );
          let at = 0;
          for (const n of faces) {
            const stream = [n];
            for (let i = 0; i < n; i++) {
              const size = sizes[at++];
              stream.push(size, ...Array.from(g.values(size, true), (n) => n - 1));
            }
            p.cells.push({ type: 'polyhedron', faces: stream });
          }
        } else {
          const spec = TYPES[type.replace(/^g_/, '')];
          if (!spec) bad(`unsupported EnSight element ${type}`);
          for (let i = 0; i < count; i++)
            p.cells.push(
              element(
                spec[0],
                Array.from(g.values(spec[1], true), (n) => n - 1),
              ),
            );
        }
      }
    } else bad(`unsupported EnSight part geometry ${mode}`);
    if (parts.some((q) => q.id === id)) bad('duplicate EnSight part ID');
    parts.push(p);
  }
  return parts;
}
/** Loads Gold ascii, C binary and Fortran binary parts, node/cell scalar, vector and tensor results, and times. */
export async function readEnSight(input: FileInput, options: EnSightOptions = {}): Promise<DataSet> {
  const text = decodeText(await whole(input, options)),
    lines = text
      .split(/\r?\n/)
      .map((s) => s.replace(/#.*/, '').trim())
      .filter(Boolean),
    time = options.timeIndex ?? 0,
    little = options.littleEndian ?? true;
  if (!/type\s*:\s*ensight gold/i.test(text) || !Number.isInteger(time) || time < 0)
    bad('expected an EnSight Gold case and nonnegative timeIndex');
  let section = '',
    model = '',
    start = 0,
    increment = 1,
    times: number[] = [],
    numberOfSteps = 1;
  const variables: { name: string; file: string; width: number; cell: boolean }[] = [];
  const filename = (s: string) => s.replace(/^\d+\s+(?:\d+\s+)?/, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(FORMAT|GEOMETRY|VARIABLE|TIME|FILE)$/.test(line)) {
      section = line;
      continue;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (section === 'GEOMETRY' && m[1] === 'model')
      model = filename(m[2]).split(/\s+(?:change_coords_only|changing_geometry_per_part)/)[0];
    if (section === 'VARIABLE') {
      const type = /^(scalar|vector|tensor symm|tensor asym) per (node|element)$/.exec(m[1]);
      if (type) {
        const fields = filename(m[2]).split(/\s+/);
        if (fields.length < 2) bad('EnSight variable needs a name and filename');
        variables.push({
          name: fields.slice(0, -1).join(' '),
          file: fields.at(-1)!,
          width: type[1] === 'vector' ? 3 : type[1] === 'tensor symm' ? 6 : type[1] === 'tensor asym' ? 9 : 1,
          cell: type[2] === 'element',
        });
      }
    }
    if (section === 'TIME') {
      if (m[1] === 'filename start number') start = Number(m[2]);
      if (m[1] === 'filename increment') increment = Number(m[2]);
      if (m[1] === 'number of steps') numberOfSteps = Number(m[2]);
      if (m[1] === 'time values') {
        times = numbers(m[2]);
        while (times.length < numberOfSteps && i + 1 < lines.length && !lines[i + 1].includes(':'))
          times.push(...numbers(lines[++i]));
      }
    }
  }
  if (!model || time >= numberOfSteps) bad('missing EnSight model or out-of-range time');
  const resolve = async (name: string) =>
      whole(
        await resource(
          name.replace(/\*+/g, (stars) => String(start + time * increment).padStart(stars.length, '0')),
          input,
          options,
        ),
        options,
      ),
    geometryBytes = await resolve(model),
    geomBinary = gold(geometryBytes, little).binary,
    parts = geometry(gold(geometryBytes, little), time);
  for (const variable of variables) {
    const g = gold(await resolve(variable.file), little);
    // Variable binary files omit the initial C Binary marker; geometry determines the encoding.
    const v = geomBinary && !g.binary ? gold(withBinaryMarker(g.bytes), little) : g;
    if (v.binary && v.peek() === 'C Binary') v.line();
    v.line();
    while (!v.done()) {
      if (v.line() !== 'part') bad('expected EnSight variable part');
      const id = v.count(),
        part = parts.find((p) => p.id === id);
      if (!part) bad('variable references absent EnSight part');
      const count = variable.cell ? part.groups.reduce((n, g) => n + g.count, 0) : part.points.length / 3,
        values = new Float64Array(count * variable.width);
      if (!variable.cell) {
        if (v.line() !== (part.dimensions ? 'block' : 'coordinates')) bad('invalid EnSight nodal variable location');
        const data = v.values(count * variable.width);
        for (let i = 0; i < values.length; i++)
          values[i] = data[(i % variable.width) * count + Math.floor(i / variable.width)];
      } else
        for (const group of part.groups) {
          if (v.line() !== group.type) bad('EnSight element variable block differs from geometry');
          const data = v.values(group.count * variable.width);
          for (let i = 0; i < data.length; i++)
            values[group.offset * variable.width + i] =
              data[(i % variable.width) * group.count + Math.floor(i / variable.width)];
        }
      (variable.cell ? part.cellArrays : part.pointArrays)[variable.name] = values;
    }
  }
  const blocks: DataSetInput[] = parts.map((p) => ({
    ...(p.dimensions
      ? { kind: 'structured' as const, dimensions: p.dimensions, points: p.points }
      : { kind: 'unstructured' as const, points: p.points, cells: p.cells }),
    pointArrays: p.pointArrays,
    cellArrays: p.cellArrays,
    pointData: scalar(p.pointArrays, p.points.length / 3, options.scalar),
    cellData: scalar(
      p.cellArrays,
      p.groups.reduce((n, g) => n + g.count, 0),
      options.scalar,
    ),
  }));
  return createDataSet({ kind: 'multiblock', blocks, names: parts.map((p) => p.name) }, options);
}
function withBinaryMarker(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(80 + b.length);
  out.fill(32, 0, 80);
  out.set(new TextEncoder().encode('C Binary'));
  out.set(b, 80);
  return out;
}
