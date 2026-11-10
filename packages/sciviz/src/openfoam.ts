// OpenFOAM User Guide, mesh description and file syntax. No OpenFOAM implementation source used.
import { createDataSet, type DataSet, type DataSetInput, type DataSetCell } from './datasets.js';
import { engineeringError as bad, resource, scalar, whole, type EngineeringOptions } from './engineering-common.js';
import type { FileInput } from './file-source.js';
export type { EngineeringOptions } from './engineering-common.js';
/** OpenFOAM case layout, selected fields and patch projection with documented defaults. */
export interface OpenFOAMOptions extends EngineeringOptions {
  /** Case time directory, default '0'. */
  readonly time?: string;
  /** Field object names to load. Default [] reads geometry only. */
  readonly fields?: readonly string[];
  /** Include named boundary patches as polydata blocks. Default true. */
  readonly boundaries?: boolean;
  /** Mesh directory relative to the case, default constant/polyMesh. */
  readonly mesh?: string;
}
class Foam {
  at = 0;
  readonly text: string;
  readonly header: Record<string, string> = Object.create(null);
  readonly binary: boolean;
  readonly little: boolean;
  readonly labelBytes: number;
  readonly scalarBytes: number;
  constructor(readonly bytes: Uint8Array) {
    this.text = new TextDecoder('latin1').decode(bytes);
    if (this.token() !== 'FoamFile') bad('missing FoamFile header');
    this.expect('{');
    for (let token = this.token(); token !== '}'; token = this.token()) {
      if (!token) bad('unterminated FoamFile header');
      this.header[token] = this.token();
      this.expect(';');
    }
    this.binary = this.header.format === 'binary';
    if (this.header.format !== 'ascii' && !this.binary) bad('unknown OpenFOAM format');
    const arch = this.header.arch ?? 'LSB;label=32;scalar=64';
    this.little = arch.startsWith('LSB');
    this.labelBytes = Number(/label=(32|64)/.exec(arch)?.[1] ?? 32) / 8;
    this.scalarBytes = Number(/scalar=(32|64)/.exec(arch)?.[1] ?? 64) / 8;
  }
  token(): string {
    for (;;) {
      while (/\s/.test(this.text[this.at] ?? '') && this.at < this.text.length) this.at++;
      if (this.text.startsWith('//', this.at)) {
        const end = this.text.indexOf('\n', this.at + 2);
        this.at = end < 0 ? this.text.length : end + 1;
        continue;
      }
      if (this.text.startsWith('/*', this.at)) {
        const end = this.text.indexOf('*/', this.at + 2);
        if (end < 0) bad('unterminated OpenFOAM comment');
        this.at = end + 2;
        continue;
      }
      break;
    }
    if (this.at >= this.text.length) return '';
    const first = this.text[this.at++];
    if ('{}();[]'.includes(first)) return first;
    if (first === '"') {
      const end = this.text.indexOf('"', this.at);
      if (end < 0) bad('unterminated OpenFOAM string');
      const s = this.text.slice(this.at, end);
      this.at = end + 1;
      return s;
    }
    const start = this.at - 1;
    while (this.at < this.text.length && !/[\s{}();\[\]"]/.test(this.text[this.at])) this.at++;
    return this.text.slice(start, this.at);
  }
  expect(token: string): void {
    const got = this.token();
    if (got !== token) bad(`expected OpenFOAM ${token}, got ${got}`);
  }
  number(): number {
    const t = this.token(),
      n = Number(t);
    if (!t || !Number.isFinite(n)) bad(`invalid OpenFOAM number ${t}`);
    return n;
  }
  count(): number {
    const n = this.number();
    if (!Number.isSafeInteger(n) || n < 0) bad('invalid OpenFOAM count');
    return n;
  }
  values(n: number, kind: 'label' | 'scalar'): Float64Array {
    const width = kind === 'label' ? this.labelBytes : this.scalarBytes,
      out = new Float64Array(n);
    if (!Number.isSafeInteger(n) || n < 0 || n * (this.binary ? width : 1) > this.bytes.length)
      bad('OpenFOAM list exceeds file bound');
    if (!this.binary) {
      for (let i = 0; i < n; i++) {
        let token = this.token();
        while (token === '(' || token === ')') token = this.token();
        const value = Number(token);
        if (!token || !Number.isFinite(value)) bad('invalid OpenFOAM list value');
        out[i] = value;
      }
      return out;
    }
    // Binary Ostream puts raw bytes immediately after the opening parenthesis.
    if (this.at + n * width > this.bytes.length) bad('truncated OpenFOAM binary list');
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, n * width);
    for (let i = 0; i < n; i++) {
      if (kind === 'label') {
        out[i] = width === 4 ? v.getInt32(i * width, this.little) : Number(v.getBigInt64(i * width, this.little));
        if (!Number.isSafeInteger(out[i])) bad('OpenFOAM label exceeds safe precision');
      } else out[i] = width === 4 ? v.getFloat32(i * width, this.little) : v.getFloat64(i * width, this.little);
    }
    this.at += n * width;
    return out;
  }
  list(kind: 'label' | 'scalar', components = 1): Float64Array {
    const n = this.count();
    this.expect('(');
    const out = this.values(n * components, kind);
    // ASCII vector rows each carry parentheses; consume the final row close before the list close.
    if (!this.binary && components > 1 && n) this.expect(')');
    this.expect(')');
    return out;
  }
  field(width: number, n: number): Float64Array {
    const kind = this.token();
    if (kind === 'uniform') {
      if (width > 1) this.expect('(');
      const tuple = Array.from({ length: width }, () => this.number());
      if (width > 1) this.expect(')');
      return Float64Array.from({ length: n * width }, (_, i) => tuple[i % width]);
    }
    if (kind !== 'nonuniform') bad(`unsupported OpenFOAM field ${kind}`);
    this.token();
    const data = this.list('scalar', width);
    if (data.length !== n * width) bad('OpenFOAM field tuple count differs from mesh');
    return data;
  }
  seek(name: string): boolean {
    for (let t = this.token(); t; t = this.token()) if (t === name) return true;
    return false;
  }
}
/** Reads ascii/binary polyMesh and volume/point scalar, vector and tensor fields. */
export async function readOpenFOAM(input: FileInput, options: OpenFOAMOptions = {}): Promise<DataSet> {
  const base = options.mesh ?? 'constant/polyMesh',
    load = async (name: string) => new Foam(await whole(await resource(name, input, options), options));
  const pointsFile = await load(base + '/points'),
    points = pointsFile.list('scalar', 3),
    faceFile = await load(base + '/faces'),
    faces: number[][] = [];
  if (faceFile.header.class === 'faceCompactList') {
    const offsets = faceFile.list('label'),
      ids = faceFile.list('label');
    for (let i = 0; i + 1 < offsets.length; i++) faces.push(Array.from(ids.subarray(offsets[i], offsets[i + 1])));
  } else {
    const n = faceFile.count();
    faceFile.expect('(');
    for (let i = 0; i < n; i++) {
      // A faceList is a list of individual label lists even in binary streams.
      const count = faceFile.count();
      faceFile.expect('(');
      const ids = faceFile.values(count, 'label');
      faceFile.expect(')');
      faces.push(Array.from(ids));
    }
    faceFile.expect(')');
  }
  const owner = (await load(base + '/owner')).list('label'),
    neighbour = (await load(base + '/neighbour')).list('label');
  if (owner.length !== faces.length || neighbour.length > owner.length)
    bad('OpenFOAM owner/neighbour count differs from faces');
  let count = 0;
  for (const ids of [owner, neighbour])
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 0 || id >= faces.length * 2) bad('invalid OpenFOAM cell label');
      count = Math.max(count, id + 1);
    }
  const byCell: number[][][] = Array.from({ length: count }, () => []);
  for (let f = 0; f < faces.length; f++) {
    byCell[owner[f]].push(faces[f]);
    if (f < neighbour.length) byCell[neighbour[f]].push([...faces[f]].reverse());
  }
  const cells: DataSetCell[] = byCell.map((faces) => ({
    type: 'polyhedron',
    faces: [faces.length, ...faces.flatMap((f) => [f.length, ...f])],
  }));
  const pointArrays: Record<string, Float64Array> = Object.create(null),
    cellArrays: Record<string, Float64Array> = Object.create(null),
    fields = new Map<string, { bytes: Uint8Array; width: number }>();
  for (const name of options.fields ?? []) {
    const f = await load((options.time ?? '0') + '/' + name),
      cls = f.header.class,
      width = /SphericalTensor/i.test(cls)
        ? 1
        : /SymmTensor/i.test(cls)
          ? 6
          : /Tensor/i.test(cls)
            ? 9
            : /Vector/i.test(cls)
              ? 3
              : 1,
      n = cls.startsWith('point') ? points.length / 3 : cells.length;
    if (!f.seek('internalField')) bad('OpenFOAM field has no internalField');
    const data = f.field(width, n);
    (cls.startsWith('point') ? pointArrays : cellArrays)[name] = data;
    fields.set(name, { bytes: f.bytes, width });
  }
  const blocks: DataSetInput[] = [
      {
        kind: 'unstructured',
        points,
        cells,
        pointArrays,
        cellArrays,
        pointData: scalar(pointArrays, points.length / 3, options.scalar),
        cellData: scalar(cellArrays, cells.length, options.scalar),
      },
    ],
    names = ['internalMesh'];
  if (options.boundaries ?? true) {
    const b = await load(base + '/boundary'),
      n = b.count();
    b.expect('(');
    for (let i = 0; i < n; i++) {
      const name = b.token();
      b.expect('{');
      let depth = 1,
        start = -1,
        count = -1;
      while (depth) {
        const key = b.token();
        if (!key) bad('unterminated OpenFOAM boundary');
        if (key === '{') depth++;
        if (key === '}') depth--;
        if (depth === 1 && key === 'startFace') start = b.count();
        if (depth === 1 && key === 'nFaces') count = b.count();
      }
      if (start < 0 || count < 0 || start + count > faces.length) bad('OpenFOAM boundary face range is invalid');
      const arrays: Record<string, Float64Array> = Object.create(null);
      for (const [key, data] of Object.entries(cellArrays)) {
        const { width, bytes } = fields.get(key)!;
        arrays[key] = Float64Array.from(
          { length: count * width },
          (_, i) => data[owner[start + Math.floor(i / width)] * width + (i % width)],
        );
        const field = new Foam(bytes);
        if (field.seek('boundaryField')) {
          field.expect('{');
          while (true) {
            const patch = field.token();
            if (patch === '}') break;
            if (!patch) bad('unterminated boundaryField');
            field.expect('{');
            let depth = 1;
            while (depth) {
              const token = field.token();
              if (!token) bad('unterminated boundary patch field');
              if (token === '{') depth++;
              if (token === '}') depth--;
              if (depth === 1 && patch === name && token === 'value') arrays[key] = field.field(width, count);
              else if (depth === 1 && token === 'value') {
                // Consume unrelated raw binary lists without tokenizing arbitrary bytes.
                const at = field.at,
                  kind = field.token();
                field.at = at;
                if (kind === 'nonuniform') {
                  field.token();
                  field.token();
                  const n = field.count();
                  field.expect('(');
                  field.values(n * width, 'scalar');
                  if (!field.binary && width > 1 && n) field.expect(')');
                  field.expect(')');
                }
              }
            }
          }
        }
      }
      blocks.push({
        kind: 'polydata',
        points,
        polygons: faces.slice(start, start + count),
        pointArrays,
        cellArrays: arrays,
        pointData: scalar(pointArrays, points.length / 3, options.scalar),
        cellData: scalar(arrays, count, options.scalar),
      });
      names.push(name);
    }
    b.expect(')');
  }
  return createDataSet({ kind: 'multiblock', blocks, names }, options);
}
