// STL writer: the Margo Engine counterpart of Three.js STLExporter. World-space triangles with face normals.
import { collect, drawables, num, toWorld, type ExportSource, type SceneOptions } from './scene.js';

export interface STLOptions extends SceneOptions {
  /** Binary (default) or ASCII. */
  binary?: boolean;
  /** ASCII `solid` name, or the binary 80-byte header text (ASCII, must not start with "solid"). */
  name?: string;
}

/** World-space positions and winding-corrected indices of every drawable. */
const meshes = (source: ExportSource, options: SceneOptions) => drawables(collect(source, options)).map(toWorld);

/** Exports STL. Binary layout: 80-byte header, uint32 triangle count, then 50-byte records (normal, 3 vertices, uint16 0). */
export function exportSTL(source: ExportSource, options?: STLOptions & { binary?: true }): Uint8Array;
export function exportSTL(source: ExportSource, options: STLOptions & { binary: false }): string;
export function exportSTL(source: ExportSource, options: STLOptions = {}): Uint8Array | string {
  const binary = options.binary ?? true;
  if (typeof binary !== 'boolean') throw new TypeError('binary must be boolean');
  const name = options.name ?? (binary ? 'Margo Engine binary STL' : 'margoengine');
  if (typeof name !== 'string' || !/^[\x20-\x7e]*$/.test(name)) throw new TypeError('STL name must be printable ASCII');
  const list = meshes(source, options),
    lines: string[] = [];
  let count = 0;
  for (const { indices } of list) count += indices.length / 3;
  if (binary) {
    if (name.length > 80 || /^solid/i.test(name))
      throw new TypeError('Binary STL header must be at most 80 ASCII bytes and not start with "solid"');
    if (count > 0xffffffff) throw new RangeError('Too many triangles for STL');
  }
  const solid = name.replace(/\s+/g, '_'),
    out = new Uint8Array(binary ? 84 + count * 50 : 0),
    view = new DataView(out.buffer);
  if (binary) {
    for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i);
    view.setUint32(80, count, true);
  } else lines.push(`solid ${solid}`);
  let offset = 84;
  for (const { positions: p, indices } of list)
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3,
        b = indices[i + 1] * 3,
        c = indices[i + 2] * 3;
      const ax = p[a],
        ay = p[a + 1],
        az = p[a + 2],
        bx = p[b],
        by = p[b + 1],
        bz = p[b + 2],
        cx = p[c],
        cy = p[c + 1],
        cz = p[c + 2];
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az,
        vx = cx - ax,
        vy = cy - ay,
        vz = cz - az;
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l) {
        nx /= l;
        ny /= l;
        nz /= l;
      } else nx = ny = nz = 0;
      if (binary) {
        view.setFloat32(offset, nx, true);
        view.setFloat32(offset + 4, ny, true);
        view.setFloat32(offset + 8, nz, true);
        view.setFloat32(offset + 12, ax, true);
        view.setFloat32(offset + 16, ay, true);
        view.setFloat32(offset + 20, az, true);
        view.setFloat32(offset + 24, bx, true);
        view.setFloat32(offset + 28, by, true);
        view.setFloat32(offset + 32, bz, true);
        view.setFloat32(offset + 36, cx, true);
        view.setFloat32(offset + 40, cy, true);
        view.setFloat32(offset + 44, cz, true);
        offset += 50; // The attribute byte count stays zero.
      } else
        lines.push(
          `  facet normal ${num(nx)} ${num(ny)} ${num(nz)}`,
          '    outer loop',
          `      vertex ${num(ax)} ${num(ay)} ${num(az)}`,
          `      vertex ${num(bx)} ${num(by)} ${num(bz)}`,
          `      vertex ${num(cx)} ${num(cy)} ${num(cz)}`,
          '    endloop',
          '  endfacet',
        );
    }
  if (binary) return out;
  lines.push(`endsolid ${solid}`, '');
  return lines.join('\n');
}
