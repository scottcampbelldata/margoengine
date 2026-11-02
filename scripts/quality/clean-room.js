// Gate 5, clean room: no three.js, Babylon or other graphics engine anywhere in packages/** (source, tests, READMEs,
// package.json, comments), and no third-party runtime dependency beyond the baseline. Docs, benchmarks and reference
// tests outside packages/ are the place for comparisons.
// Items: `mention <file>` -> matches of ENGINES in that text file; `dependency <package> <name>` -> 1 for each
// dependencies / optionalDependencies / peerDependencies entry that is not a Margo package.
// Allowed without a baseline entry (the clean-room rule is about copying code, not about libraries an app brings itself):
//  - an OPTIONAL PEER dependency (peerDependenciesMeta optional) that THIRD-PARTY-NOTICES.md lists as "optional peer"
//    for that package, with its licence and reason (scripts/supply-chain.mjs keeps that file true);
//  - a mention in ALLOWED_MENTIONS: a test that asserts the engine is NOT used.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIBRARIES =
  'three(?:/[^\'"`]*)?|@react-three/[^\'"`]*|babylonjs|@babylonjs/[^\'"`]*|pixi\\.js|@pixi/[^\'"`]*|playcanvas|ogl|regl|twgl\\.js|@luma\\.gl/[^\'"`]*|aframe|cesium|filament|gl-matrix|wgpu-matrix';
/** Engine names in any text, and other graphics libraries as quoted module specifiers (imports, package.json keys). */
export const ENGINES = new RegExp(`three\\.?js|\\bTHREE\\b|babylon|['"\`](?:${LIBRARIES})['"\`]`, 'gi');
const THREE_CASE = /^three$/i; // `\bTHREE\b` must stay upper case: "three" is an English word

/** Files that name an engine only to assert it is absent; each value says what the file checks. */
export const ALLOWED_MENTIONS = {
  'packages/react/tests/subpaths.test.js': '@margoengine/react must not depend on or import three or react-reconciler',
};

/** Map of package name -> Set of Margo packages that THIRD-PARTY-NOTICES.md lists it for as an "optional peer". */
export function noticedOptionalPeers(root) {
  const file = join(root, 'THIRD-PARTY-NOTICES.md');
  const peers = new Map();
  if (!existsSync(file)) return peers;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const cells = line.split('|').map((c) => c.trim());
    // | `name` | version | licence | kind | used by | why |
    const name = /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1];
    if (name && cells[4] === 'optional peer') peers.set(name, new Set((cells[5] ?? '').split(/,\s*/)));
  }
  return peers;
}

export function cleanRoomGate({ root, files, packages }) {
  const items = {};
  for (const file of files) {
    if (!file.startsWith('packages/') || file in ALLOWED_MENTIONS) continue;
    const bytes = readFileSync(join(root, file));
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    let count = 0;
    for (const m of bytes.toString('utf8').matchAll(ENGINES)) if (!THREE_CASE.test(m[0]) || m[0] === 'THREE') count++;
    if (count) items[`mention ${file}`] = count;
  }
  // margoengine only mirrors its packages' optional third-party peers (scripts/umbrella.mjs); those are counted there.
  const noticed = noticedOptionalPeers(root);
  for (const pkg of packages.filter((p) => p.name !== 'margoengine'))
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const name of Object.keys(pkg.manifest[field] ?? {})) {
        if (name === 'margoengine' || name.startsWith('@margoengine/')) continue;
        const optionalPeer =
          field === 'peerDependencies' && pkg.manifest.peerDependenciesMeta?.[name]?.optional === true;
        if (optionalPeer && noticed.get(name)?.has(pkg.name)) continue;
        items[`dependency ${pkg.name} ${name}`] = 1;
      }
  return {
    items,
    summary: () =>
      Object.entries(items)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, v]) => `  ${k}${v > 1 ? ` (${v})` : ''}`),
  };
}
