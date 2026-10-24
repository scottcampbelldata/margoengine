// Gate 5, clean room: no three.js, Babylon or other graphics engine anywhere in packages/** (source, tests, READMEs,
// package.json, comments), and no third-party runtime dependency beyond the baseline. Docs, benchmarks and reference
// tests outside packages/ are the place for comparisons.
// Items: `mention <file>` -> matches of ENGINES in that text file; `dependency <package> <name>` -> 1 for each
// dependencies / optionalDependencies / peerDependencies entry that is not a Margo package.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIBRARIES =
  'three(?:/[^\'"`]*)?|@react-three/[^\'"`]*|babylonjs|@babylonjs/[^\'"`]*|pixi\\.js|@pixi/[^\'"`]*|playcanvas|ogl|regl|twgl\\.js|@luma\\.gl/[^\'"`]*|aframe|cesium|filament|gl-matrix|wgpu-matrix';
/** Engine names in any text, and other graphics libraries as quoted module specifiers (imports, package.json keys). */
export const ENGINES = new RegExp(`three\\.?js|\\bTHREE\\b|babylon|['"\`](?:${LIBRARIES})['"\`]`, 'gi');
const THREE_CASE = /^three$/i; // `\bTHREE\b` must stay upper case: "three" is an English word

export function cleanRoomGate({ root, files, packages }) {
  const items = {};
  for (const file of files) {
    if (!file.startsWith('packages/')) continue;
    const bytes = readFileSync(join(root, file));
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    let count = 0;
    for (const m of bytes.toString('utf8').matchAll(ENGINES)) if (!THREE_CASE.test(m[0]) || m[0] === 'THREE') count++;
    if (count) items[`mention ${file}`] = count;
  }
  // margoengine only mirrors its packages' optional third-party peers (scripts/umbrella.mjs); those are counted there.
  for (const pkg of packages.filter((p) => p.name !== 'margoengine'))
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const name of Object.keys(pkg.manifest[field] ?? {}))
        if (name !== 'margoengine' && !name.startsWith('@margoengine/')) items[`dependency ${pkg.name} ${name}`] = 1;
  return {
    items,
    summary: () =>
      Object.entries(items)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, v]) => `  ${k}${v > 1 ? ` (${v})` : ''}`),
  };
}
