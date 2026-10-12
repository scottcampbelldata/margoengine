// STL writer: the Margo Engine counterpart of Three.js STLExporter. World-space triangles with face normals.
import {collect, drawables, num, toWorld, type ExportSource, type SceneOptions} from './scene.js';

export interface STLOptions extends SceneOptions {
  /** Binary (default) or ASCII. */
  binary?: boolean;
  /** ASCII `solid` name, or the binary 80-byte header text (ASCII, must not start with "solid"). */
  name?: string;
}

interface Triangle {a: number[]; b: number[]; c: number[]; n: number[]}

function triangles(source: ExportSource, options: SceneOptions): Triangle[] {
  const out: Triangle[] = [];
  for (const item of drawables(collect(source, options))) {
    const {positions: p, indices} = toWorld(item);
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i+1], indices[i+2]].map(v => [p[v*3], p[v*3+1], p[v*3+2]]);
      const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
      const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]], l = Math.hypot(n[0], n[1], n[2]);
      out.push({a, b, c, n: l ? n.map(x => x/l) : [0, 0, 0]});
    }
  }
  return out;
}

/** Exports STL. Binary layout: 80-byte header, uint32 triangle count, then 50-byte records (normal, 3 vertices, uint16 0). */
export function exportSTL(source: ExportSource, options?: STLOptions & {binary?: true}): Uint8Array;
export function exportSTL(source: ExportSource, options: STLOptions & {binary: false}): string;
export function exportSTL(source: ExportSource, options: STLOptions = {}): Uint8Array|string {
  const binary = options.binary ?? true;
  if (typeof binary !== 'boolean') throw new TypeError('binary must be boolean');
  const name = options.name ?? (binary ? 'Margo Engine binary STL' : 'margoengine');
  if (typeof name !== 'string' || !/^[\x20-\x7e]*$/.test(name)) throw new TypeError('STL name must be printable ASCII');
  const list = triangles(source, options);
  if (!binary) {
    const solid = name.replace(/\s+/g, '_');
    const lines = [`solid ${solid}`];
    for (const {a, b, c, n} of list) {
      lines.push(`  facet normal ${n.map(num).join(' ')}`, '    outer loop');
      for (const v of [a, b, c]) lines.push(`      vertex ${v.map(num).join(' ')}`);
      lines.push('    endloop', '  endfacet');
    }
    lines.push(`endsolid ${solid}`, '');
    return lines.join('\n');
  }
  if (name.length > 80 || /^solid/i.test(name)) throw new TypeError('Binary STL header must be at most 80 ASCII bytes and not start with "solid"');
  if (list.length > 0xffffffff) throw new RangeError('Too many triangles for STL');
  const out = new Uint8Array(84+list.length*50), view = new DataView(out.buffer);
  for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i);
  view.setUint32(80, list.length, true);
  let offset = 84;
  for (const {a, b, c, n} of list) {
    for (const v of [n, a, b, c]) for (let k = 0; k < 3; k++) {view.setFloat32(offset, v[k], true); offset += 4;}
    view.setUint16(offset, 0, true); offset += 2;
  }
  return out;
}
