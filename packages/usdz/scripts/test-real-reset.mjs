// Reads the real stages of tests/real-files/manifest.json, which reset transform stacks, and compares every
// transformable prim with what OpenUSD answers for the same files: world matrix, visibility, and for each mesh that draws
// its points in world space. Meshes of the guide purpose must not draw. The files are read from the folder given as the
// argument and checked by SHA-256; they are never committed. Nothing is fetched without --download.
// Usage: node packages/usdz/scripts/test-real-reset.mjs <cache folder> [--download]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadArguments } from '../../../scripts/support/download-arguments.mjs';
import { pinnedFiles } from '../../../scripts/support/pinned-files.mjs';
import { parseUSDFiles } from '../dist/compose.js';
import { implicitShapes } from '../dist/shapes.js';
import { nodeAt, pose, shown, transform } from '../tests/pose.js';

const args = downloadArguments(
  `Usage: node packages/usdz/scripts/test-real-reset.mjs <cache folder> [--download]
Reads the pinned USD stages in the folder and compares them with OpenUSD's recorded answers.
  --download   fetch the files that are missing or changed, then check them
  --help       print this and download nothing`,
  { download: { type: 'boolean' } },
  process.argv.slice(2),
  1,
);
if (!args) process.exit(); // process.exit: help or a refused argument, and nothing is open yet

const manifest = JSON.parse(readFileSync(new URL('../tests/real-files/manifest.json', import.meta.url))),
  folder = args.positionals[0];
const rows = manifest.stages.flatMap((stage) =>
  stage.files.map((row) => ({
    name: `${stage.folder}/${row.file}`,
    path: join(folder, stage.folder, row.file),
    url: row.url,
    sha256: row.sha256,
    size: row.bytes,
  })),
);
const read = await pinnedFiles(rows, {
  command: `node packages/usdz/scripts/test-real-reset.mjs ${folder}`,
  download: args.download,
});
const files = new Map(rows.map((row, i) => [row.name, new Uint8Array(read[i])]));

const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
/** Distance from `p` to the nearest of `points`. */
const nearest = (points, p) =>
  points.reduce((best, q) => Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])), Infinity);

const wrong = [];
for (const stage of manifest.stages) {
  const asset = await parseUSDFiles(stage.root, (id) => files.get(`${stage.folder}/${id.replace(/^(\.\/)+/, '')}`), {
    extensions: [implicitShapes()],
  });
  const posed = pose(asset, 0),
    base = asset.document.nodes[0].matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    worst = { matrix: 0, point: 0 };
  let meshes = 0,
    guides = 0;
  for (const [path, prim] of Object.entries(stage.prims)) {
    const id = nodeAt(asset, path);
    if (id === undefined) {
      wrong.push(`${stage.name} ${path}: no node`);
      continue;
    }
    const world = multiply(base, prim.world),
      gap = Math.max(...world.map((x, i) => Math.abs(x - posed.world[id][i])));
    worst.matrix = Math.max(worst.matrix, gap);
    if (gap > 1e-6) wrong.push(`${stage.name} ${path}: world matrix off by ${gap}`);
    if (shown(asset, id, posed) !== prim.visible) wrong.push(`${stage.name} ${path}: visibility`);
    if (!prim.mesh) continue;
    const { mesh } = asset.document.nodes[id];
    if (prim.purpose === 'guide') {
      guides++;
      if (mesh !== undefined) wrong.push(`${stage.name} ${path}: a guide mesh draws`);
      continue;
    }
    if (mesh === undefined) {
      wrong.push(`${stage.name} ${path}: no mesh`);
      continue;
    }
    meshes++;
    const drawn = [];
    for (const primitive of asset.document.meshes[mesh].primitives) {
      const accessor = asset.document.accessors[primitive.attributes.POSITION],
        data = asset.buffers[asset.document.bufferViews[accessor.bufferView].buffer];
      for (let v = 0; v < accessor.count; v++)
        drawn.push(transform(posed.world[id], [data[v * 3], data[v * 3 + 1], data[v * 3 + 2]]));
    }
    const corners = [prim.mesh.min, prim.mesh.max].map((p) => transform(base, p)),
      bounds = [0, 1, 2].map((k) => {
        const values = drawn.map((p) => p[k]);
        return [values.reduce((a, b) => Math.min(a, b)), values.reduce((a, b) => Math.max(a, b))];
      });
    // The stage's up-axis turn may swap a minimum with a maximum, so each axis is compared as an unordered pair.
    for (let k = 0; k < 3; k++) {
      const [low, high] = [Math.min(corners[0][k], corners[1][k]), Math.max(corners[0][k], corners[1][k])],
        off = Math.max(Math.abs(bounds[k][0] - low), Math.abs(bounds[k][1] - high));
      worst.point = Math.max(worst.point, off);
      if (off > 1e-6) wrong.push(`${stage.name} ${path}: bounds off by ${off} on axis ${k}`);
    }
    for (const sample of prim.mesh.samples) {
      const off = nearest(drawn, transform(base, sample));
      worst.point = Math.max(worst.point, off);
      if (off > 1e-6) wrong.push(`${stage.name} ${path}: no vertex within ${off} of OpenUSD's point`);
    }
  }
  console.log(
    `${stage.name}: ${Object.keys(stage.prims).length} prims, ${stage.resets.length} resetting, ${meshes} meshes ` +
      `compared, ${guides} guide meshes not drawn; worst matrix ${worst.matrix.toExponential(1)}, worst point ` +
      `${worst.point.toExponential(1)} (OpenUSD ${stage.openusd})`,
  );
}
if (wrong.length) {
  console.error(wrong.slice(0, 40).join('\n'));
  console.error(`${wrong.length} differences from OpenUSD`);
  process.exitCode = 1;
}
