// PLY writer: the Margo Engine counterpart of Three.js PLYExporter. One merged world-space mesh.
import {byte, collect, drawables, num, toSrgb, toWorld, type ExportSource, type SceneOptions} from './scene.js';

export interface PLYOptions extends SceneOptions {
  /** binary_little_endian (true) or ascii (default false, as in Three.js). */
  binary?: boolean;
  /** Write uchar red/green/blue: vertex colors when a mesh has them, else its material base color (sRGB). Default false. */
  colors?: boolean;
}

/** Exports PLY with float x/y/z/nx/ny/nz, optional uchar colors and `list uchar uint vertex_indices` faces. */
export function exportPLY(source: ExportSource, options: PLYOptions & {binary: true}): Uint8Array;
export function exportPLY(source: ExportSource, options?: PLYOptions & {binary?: false}): string;
export function exportPLY(source: ExportSource, options: PLYOptions = {}): Uint8Array|string {
  const binary = options.binary ?? false, colors = options.colors ?? false;
  if (typeof binary !== 'boolean' || typeof colors !== 'boolean') throw new TypeError('binary and colors must be boolean');
  const items = drawables(collect(source, options)).map(item => ({...toWorld(item), item}));
  const vertexCount = items.reduce((sum, {item}) => sum+item.geometry.count, 0), faceCount = items.reduce((sum, {indices}) => sum+indices.length/3, 0);
  const header = ['ply', `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0`, 'comment Margo Engine PLY export', `element vertex ${vertexCount}`,
    'property float x', 'property float y', 'property float z', 'property float nx', 'property float ny', 'property float nz',
    ...(colors ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    `element face ${faceCount}`, 'property list uchar uint vertex_indices', 'end_header', ''].join('\n');
  const rgb = (item: typeof items[number]['item'], i: number): number[] => {
    const g = item.geometry, color = g.colors ? [0, 1, 2].map(k => g.colors![i*g.colorSize+k]) : (item.material?.color ?? [1, 1, 1]).slice(0, 3);
    return color.map(v => byte(toSrgb(v)));
  };
  if (!binary) {
    const lines = [header.trimEnd()];
    for (const {positions: p, normals: n, item} of items) for (let i = 0; i < item.geometry.count; i++) {
      const values = [p[i*3], p[i*3+1], p[i*3+2], n[i*3], n[i*3+1], n[i*3+2]].map(num);
      lines.push((colors ? [...values, ...rgb(item, i)] : values).join(' '));
    }
    let base = 0;
    for (const {indices, item} of items) {
      for (let i = 0; i < indices.length; i += 3) lines.push(`3 ${indices[i]+base} ${indices[i+1]+base} ${indices[i+2]+base}`);
      base += item.geometry.count;
    }
    lines.push('');
    return lines.join('\n');
  }
  const head = new TextEncoder().encode(header), stride = 24+(colors ? 3 : 0);
  const out = new Uint8Array(head.length+vertexCount*stride+faceCount*13), view = new DataView(out.buffer);
  out.set(head);
  let offset = head.length;
  for (const {positions: p, normals: n, item} of items) for (let i = 0; i < item.geometry.count; i++) {
    for (const v of [p[i*3], p[i*3+1], p[i*3+2], n[i*3], n[i*3+1], n[i*3+2]]) {view.setFloat32(offset, v, true); offset += 4;}
    if (colors) for (const c of rgb(item, i)) out[offset++] = c;
  }
  let base = 0;
  for (const {indices, item} of items) {
    for (let i = 0; i < indices.length; i += 3) {
      out[offset++] = 3;
      for (let k = 0; k < 3; k++) {view.setUint32(offset, indices[i+k]+base, true); offset += 4;}
    }
    base += item.geometry.count;
  }
  return out;
}
