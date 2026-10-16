import { LinearToSRGB as toSrgb } from '@margoengine/math/color';
// PLY writer: the Margo Engine counterpart of Three.js PLYExporter. One merged world-space mesh.
import { byte, collect, drawables, num, toWorld, type ExportSource, type SceneOptions } from './scene.js';

export interface PLYOptions extends SceneOptions {
  /** binary_little_endian (true) or ascii (default false, as in Three.js). */
  binary?: boolean;
  /** Write uchar red/green/blue: vertex colors when a mesh has them, else its material base color (sRGB). Default false. */
  colors?: boolean;
}

/** Exports PLY with float x/y/z/nx/ny/nz, optional uchar colors and `list uchar uint vertex_indices` faces. */
export function exportPLY(source: ExportSource, options: PLYOptions & { binary: true }): Uint8Array;
export function exportPLY(source: ExportSource, options?: PLYOptions & { binary?: false }): string;
export function exportPLY(source: ExportSource, options: PLYOptions = {}): Uint8Array | string {
  const binary = options.binary ?? false,
    colors = options.colors ?? false;
  if (typeof binary !== 'boolean' || typeof colors !== 'boolean')
    throw new TypeError('binary and colors must be boolean');
  const items = drawables(collect(source, options)).map((item) => ({ ...toWorld(item), item }));
  const vertexCount = items.reduce((sum, { item }) => sum + item.geometry.count, 0),
    faceCount = items.reduce((sum, { indices }) => sum + indices.length / 3, 0);
  const header = [
    'ply',
    `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0`,
    'comment Margo Engine PLY export',
    `element vertex ${vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    ...(colors ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    `element face ${faceCount}`,
    'property list uchar uint vertex_indices',
    'end_header',
    '',
  ].join('\n');
  // Vertex colors when the geometry has them, else one material color for the whole mesh.
  const flat = (item: (typeof items)[number]['item']): number[] =>
    (item.material?.color ?? [1, 1, 1]).slice(0, 3).map((v) => byte(toSrgb(v)));
  if (!binary) {
    const lines = [header.trimEnd()];
    for (const { positions: p, normals: n, item } of items) {
      const g = item.geometry,
        vertexColors = g.colors,
        size = g.colorSize,
        fixed = colors && !vertexColors ? ' ' + flat(item).join(' ') : '';
      for (let i = 0, o = 0; i < g.count; i++, o += 3) {
        const line = `${num(p[o])} ${num(p[o + 1])} ${num(p[o + 2])} ${num(n[o])} ${num(n[o + 1])} ${num(n[o + 2])}`;
        lines.push(
          colors && vertexColors
            ? `${line} ${byte(toSrgb(vertexColors[i * size]))} ${byte(toSrgb(vertexColors[i * size + 1]))} ${byte(toSrgb(vertexColors[i * size + 2]))}`
            : line + fixed,
        );
      }
    }
    let base = 0;
    for (const { indices, item } of items) {
      for (let i = 0; i < indices.length; i += 3)
        lines.push(`3 ${indices[i] + base} ${indices[i + 1] + base} ${indices[i + 2] + base}`);
      base += item.geometry.count;
    }
    lines.push('');
    return lines.join('\n');
  }
  const head = new TextEncoder().encode(header),
    stride = 24 + (colors ? 3 : 0);
  const out = new Uint8Array(head.length + vertexCount * stride + faceCount * 13),
    view = new DataView(out.buffer);
  out.set(head);
  let offset = head.length;
  for (const { positions: p, normals: n, item } of items) {
    const g = item.geometry,
      vertexColors = g.colors,
      size = g.colorSize,
      fixed = colors && !vertexColors ? flat(item) : [0, 0, 0];
    for (let i = 0, o = 0; i < g.count; i++, o += 3) {
      view.setFloat32(offset, p[o], true);
      view.setFloat32(offset + 4, p[o + 1], true);
      view.setFloat32(offset + 8, p[o + 2], true);
      view.setFloat32(offset + 12, n[o], true);
      view.setFloat32(offset + 16, n[o + 1], true);
      view.setFloat32(offset + 20, n[o + 2], true);
      offset += 24;
      if (!colors) continue;
      if (vertexColors) {
        out[offset] = byte(toSrgb(vertexColors[i * size]));
        out[offset + 1] = byte(toSrgb(vertexColors[i * size + 1]));
        out[offset + 2] = byte(toSrgb(vertexColors[i * size + 2]));
      } else {
        out[offset] = fixed[0];
        out[offset + 1] = fixed[1];
        out[offset + 2] = fixed[2];
      }
      offset += 3;
    }
  }
  let base = 0;
  for (const { indices, item } of items) {
    for (let i = 0; i < indices.length; i += 3) {
      out[offset] = 3;
      view.setUint32(offset + 1, indices[i] + base, true);
      view.setUint32(offset + 5, indices[i + 1] + base, true);
      view.setUint32(offset + 9, indices[i + 2] + base, true);
      offset += 13;
    }
    base += item.geometry.count;
  }
  return out;
}
