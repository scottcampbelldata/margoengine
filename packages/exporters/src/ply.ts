import { LinearToSRGB as toSrgb } from '@margoengine/math/color';
// PLY writer: one merged world-space mesh, with a loaded model's points as vertices and its lines as edges.
import { byte, collect, drawables, num, standZUp, toWorld, turnsToZUp, type ExportSource, type SceneOptions } from './scene.js';

/** Options of exportPLY: binary or ASCII output and per-vertex colours. */
export interface PLYOptions extends SceneOptions {
  /** binary_little_endian (true) or ascii (default false). */
  binary?: boolean;
  /** Write uchar red/green/blue: vertex colors when a mesh has them, else its material base color (sRGB). Default false. */
  colors?: boolean;
  /**
   * The scene's up axis. Blender and most scan tools read PLY with Z up, so 'y', the glTF way, turns the scene to stand up
   * in them; 'z' writes its coordinates as they are. Default 'y'.
   */
  upAxis?: 'y' | 'z';
}

/**
 * Exports PLY with float x/y/z/nx/ny/nz, optional uchar colors and `list uchar uint vertex_indices` faces. A loaded
 * model's glTF points are vertices no face uses, one per point index, and its lines an `edge` element of `int vertex1`
 * and `int vertex2` (with `colors`, the uchar red, green and blue of the edge's first vertex), as Turk's PLY format
 * describes edges; the `edge` element is written only when there are lines. Points and lines without normals get 0 0 0.
 */
export function exportPLY(source: ExportSource, options: PLYOptions & { binary: true }): Uint8Array;
export function exportPLY(source: ExportSource, options?: PLYOptions & { binary?: false }): string;
export function exportPLY(source: ExportSource, options: PLYOptions = {}): Uint8Array | string {
  const binary = options.binary ?? false,
    colors = options.colors ?? false;
  if (typeof binary !== 'boolean' || typeof colors !== 'boolean')
    throw new TypeError('binary and colors must be boolean');
  const turn = turnsToZUp(options.upAxis, 'PLY');
  const items = drawables(collect(source, options, undefined, 'shape', ['points', 'lines']), true).map((item) => {
    const { positions, normals, indices } = toWorld(item),
      // A point is a vertex of its own, in point order; other vertices are written as the geometry holds them.
      order = item.geometry.topology === 'points' ? indices : Uint32Array.from({ length: item.geometry.count }, (_, i) => i);
    return turn
      ? { positions: standZUp(positions), normals: standZUp(normals), indices, item, order }
      : { positions, normals, indices, item, order };
  });
  const vertexCount = items.reduce((sum, { order }) => sum + order.length, 0),
    faceCount = items.reduce((sum, { indices, item }) => sum + (item.geometry.topology ? 0 : indices.length / 3), 0),
    edgeCount = items.reduce(
      (sum, { indices, item }) => sum + (item.geometry.topology === 'lines' ? indices.length / 2 : 0),
      0,
    );
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
    ...(edgeCount
      ? [
          `element edge ${edgeCount}`,
          'property int vertex1',
          'property int vertex2',
          ...(colors ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
        ]
      : []),
    'end_header',
    '',
  ].join('\n');
  // Vertex colors when the geometry has them, else one material color for the whole mesh.
  const flat = (item: (typeof items)[number]['item']): number[] =>
    (item.material?.color ?? [1, 1, 1]).slice(0, 3).map((v) => byte(toSrgb(v)));
  // An edge takes its first vertex's colour, as the vertex lines write it.
  const edgeColor = (item: (typeof items)[number]['item'], vertex: number): number[] => {
    const g = item.geometry;
    return g.colors
      ? [0, 1, 2].map((c) => byte(toSrgb(g.colors![vertex * g.colorSize + c])))
      : flat(item);
  };
  if (!binary) {
    const lines = [header.trimEnd()];
    for (const { positions: p, normals: n, item, order } of items) {
      const g = item.geometry,
        vertexColors = g.colors,
        size = g.colorSize,
        fixed = colors && !vertexColors ? ' ' + flat(item).join(' ') : '';
      for (const i of order) {
        const o = i * 3,
          line = `${num(p[o])} ${num(p[o + 1])} ${num(p[o + 2])} ${num(n[o])} ${num(n[o + 1])} ${num(n[o + 2])}`;
        lines.push(
          colors && vertexColors
            ? `${line} ${byte(toSrgb(vertexColors[i * size]))} ${byte(toSrgb(vertexColors[i * size + 1]))} ${byte(toSrgb(vertexColors[i * size + 2]))}`
            : line + fixed,
        );
      }
    }
    let base = 0;
    for (const { indices, item, order } of items) {
      if (!item.geometry.topology)
        for (let i = 0; i < indices.length; i += 3)
          lines.push(`3 ${indices[i] + base} ${indices[i + 1] + base} ${indices[i + 2] + base}`);
      base += order.length;
    }
    base = 0;
    for (const { indices, item, order } of items) {
      if (item.geometry.topology === 'lines')
        for (let i = 0; i < indices.length; i += 2)
          lines.push(`${indices[i] + base} ${indices[i + 1] + base}${colors ? ' ' + edgeColor(item, indices[i]).join(' ') : ''}`);
      base += order.length;
    }
    lines.push('');
    return lines.join('\n');
  }
  const head = new TextEncoder().encode(header),
    stride = 24 + (colors ? 3 : 0);
  const out = new Uint8Array(head.length + vertexCount * stride + faceCount * 13 + edgeCount * (colors ? 11 : 8)),
    view = new DataView(out.buffer);
  out.set(head);
  let offset = head.length;
  for (const { positions: p, normals: n, item, order } of items) {
    const g = item.geometry,
      vertexColors = g.colors,
      size = g.colorSize,
      fixed = colors && !vertexColors ? flat(item) : [0, 0, 0];
    for (const i of order) {
      const o = i * 3;
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
  for (const { indices, item, order } of items) {
    for (let i = 0; !item.geometry.topology && i < indices.length; i += 3) {
      out[offset] = 3;
      view.setUint32(offset + 1, indices[i] + base, true);
      view.setUint32(offset + 5, indices[i + 1] + base, true);
      view.setUint32(offset + 9, indices[i + 2] + base, true);
      offset += 13;
    }
    base += order.length;
  }
  base = 0;
  for (const { indices, item, order } of items) {
    for (let i = 0; item.geometry.topology === 'lines' && i < indices.length; i += 2) {
      view.setInt32(offset, indices[i] + base, true);
      view.setInt32(offset + 4, indices[i + 1] + base, true);
      offset += 8;
      if (colors) {
        out.set(edgeColor(item, indices[i]), offset);
        offset += 3;
      }
    }
    base += order.length;
  }
  return out;
}
