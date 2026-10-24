// Writes tests/fixtures/tree.vox, a Margo-made single-model .vox file: a small tree (trunk, branch, hollow leaf
// canopy, a few fruit) filling a 13 x 11 x 18 grid (MagicaVoxel axes, z up). The file is the minimal old-style layout,
// written chunk by chunk from the public format description: "VOX " + version 150, then MAIN whose children are
// SIZE (x, y, z as int32), XYZI (voxel count, then x, y, z, colour index bytes) and RGBA (256 entries; entry k is the
// colour of index k + 1, and the last entry holds index 0). Every integer is little-endian; each chunk is its id,
// content size, children size, content, children. Run `node packages/voxel/scripts/make-vox-fixture.js` to rewrite it.
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Colour indices used by the tree. */
export const TREE_COLORS = { bark: 1, barkDark: 2, leaf: 3, leafLight: 4, leafDark: 5, fruit: 6, grass: 7 };

/**
 * The tree model.
 * @returns {{size: number[], voxels: number[][], palette: number[][]}} voxels are [x, y, z, colour index];
 * palette has 256 RGBA entries indexed by colour index (index 0 unused).
 */
export function tree() {
  const size = [13, 11, 18],
    cells = new Map(),
    put = (x, y, z, c) => cells.set(`${x},${y},${z}`, [x, y, z, c]);
  const { bark, barkDark, leaf, leafLight, leafDark, fruit, grass } = TREE_COLORS;
  // Grass tuft ring around the trunk foot.
  for (let x = 3; x <= 8; x++) for (let y = 3; y <= 7; y++) if ((x + y) % 3 === 0) put(x, y, 0, grass);
  // Trunk (2 x 2) with a darker seam, and one branch reaching +x.
  for (let z = 0; z < 10; z++)
    for (const [x, y] of [
      [5, 5],
      [6, 5],
      [5, 6],
      [6, 6],
    ])
      put(x, y, z, (x + z) % 4 === 0 ? barkDark : bark);
  for (let i = 0; i < 3; i++) put(7 + i, 5, 6 + i, bark);
  // Hollow canopy: cells of an ellipsoid within one cell of its surface.
  const centre = [6, 5, 12.5],
    radii = [6, 5, 5];
  for (let x = 0; x < size[0]; x++)
    for (let y = 0; y < size[1]; y++)
      for (let z = 8; z < size[2]; z++) {
        const d = Math.hypot((x - centre[0]) / radii[0], (y - centre[1]) / radii[1], (z - centre[2]) / radii[2]);
        if (d > 1 || d < 0.78) continue;
        const shade = z > 14 ? leafLight : (x * 7 + y * 3 + z) % 5 === 0 ? leafDark : leaf;
        put(x, y, z, shade);
      }
  for (const [x, y, z] of [
    [0, 5, 12],
    [12, 4, 12],
    [6, 0, 10],
    [4, 10, 13],
  ])
    put(x, y, z, fruit);
  const voxels = [...cells.values()].sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const named = {
    [bark]: [120, 82, 48, 255],
    [barkDark]: [86, 56, 32, 255],
    [leaf]: [62, 150, 70, 255],
    [leafLight]: [118, 196, 96, 255],
    [leafDark]: [36, 104, 56, 255],
    [fruit]: [214, 52, 46, 255],
    [grass]: [96, 168, 64, 255],
  };
  // Unused entries: a deterministic ramp, so the palette is not the format's default one.
  const palette = Array.from({ length: 256 }, (_, i) =>
    i === 0 ? [0, 0, 0, 0] : (named[i] ?? [i, (i * 3) & 255, 255 - i, 255]),
  );
  return { size, voxels, palette };
}

/** Assembles the .vox bytes for `model` (see the header comment for the layout). */
export function encodeVox({ size, voxels, palette }) {
  const chunk = (id, content) => {
    const out = new Uint8Array(12 + content.length),
      view = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    view.setInt32(4, content.length, true);
    view.setInt32(8, 0, true);
    out.set(content, 12);
    return out;
  };
  const ints = (...values) => {
    const out = new Uint8Array(values.length * 4),
      view = new DataView(out.buffer);
    values.forEach((v, i) => view.setInt32(i * 4, v, true));
    return out;
  };
  const xyzi = new Uint8Array(4 + voxels.length * 4);
  xyzi.set(ints(voxels.length));
  voxels.forEach((v, i) => xyzi.set(v, 4 + i * 4));
  const rgba = new Uint8Array(1024);
  for (let k = 0; k < 256; k++) rgba.set(palette[(k + 1) & 255], k * 4);
  const children = [chunk('SIZE', ints(...size)), chunk('XYZI', xyzi), chunk('RGBA', rgba)],
    childBytes = children.reduce((n, c) => n + c.length, 0),
    out = new Uint8Array(8 + 12 + childBytes),
    view = new DataView(out.buffer);
  out.set([86, 79, 88, 32]); // "VOX "
  view.setInt32(4, 150, true);
  out.set([77, 65, 73, 78], 8); // "MAIN"
  view.setInt32(12, 0, true);
  view.setInt32(16, childBytes, true);
  let at = 20;
  for (const c of children) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bytes = encodeVox(tree());
  writeFileSync(fileURLToPath(new URL('../tests/fixtures/tree.vox', import.meta.url)), bytes);
  console.log(`tree.vox ${bytes.length} bytes, ${tree().voxels.length} voxels`);
}
