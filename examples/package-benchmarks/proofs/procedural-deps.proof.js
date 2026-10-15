// Record for @margoengine/procedural dropping its third-party runtime dependencies (HANDOFF 5l.v): `simplex-noise` 4.0.3
// gave way to the package's own seamless simplex and `isosurface` 1.0.0 to its own marching tetrahedra. Output is
// intentionally different (seamless 0.5 kernel; tetrahedra instead of cubes), so this compares speed and bundle bytes, not
// values. The baseline is the package at `ref` built by the shared harness; it imports the two old packages, so they must
// still be present in node_modules (5l.v removed them from the lockfile; a fresh install lacks them, then
// `npm install --no-save simplex-noise@4.0.3 isosurface@1.0.0` first). Timings are diagnostic unless the run is quiet-gated (node scripts/quiet-gate.mjs).
// Run after `npm run build:packages`: node examples/package-benchmarks/proofs/procedural-deps.proof.js [ref] [pin]
// Pinned: ed53ec5 against fff47af, the commit that recorded results/procedural-deps.json. Without the two old packages the
// run reports HISTORICAL (exit 0) instead: nothing in the repository can rebuild the baseline without an install.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {build} from 'vite';
import {compactOutput} from '../../../scripts/measure-size.js';
import {refs, versions, time, save, announce} from './compare.js';

const {ref, pin} = refs('ed53ec5', 'fff47af'), root = resolve(import.meta.dirname, '../../..');
announce('procedural src/index.ts', ref, pin);
const missing = ['simplex-noise', 'isosurface'].filter(name => {try {import.meta.resolve(name); return false;} catch {return true;}});
if (missing.length) {
  console.log(`HISTORICAL: fff47af recorded results/procedural-deps.json (${ref} -> fff47af); the baseline imports ${missing.join(' and ')}, removed from the lockfile by 5l.v, so it needs an install to rebuild.`);
  process.exit(0);
}
const {baseline, candidate} = await versions('procedural', ref, undefined, pin);
// Speed: 200k 3D simplex samples on a terrain-like grid, and a 64^3 sphere surface.
const grid = noise => () => {let s = 0; for (let i = 0; i < 200_000; i++) s += noise.simplex(i % 500 * 0.037, 0.3, Math.floor(i / 500) * 0.037); return s;};
const sphere = (x, y, z) => Math.hypot(x, y, z) - 0.7, surface = module => () => module.marchingCubes(sphere, {resolution: [64, 64, 64]});
for (const module of [baseline, candidate]) assert.ok(surface(module)().indices.length > 1000);
const cases = [
  {case: '200k 3D simplex samples', ...time(grid(new baseline.Noise(731)), grid(new candidate.Noise(731)), 8)},
  {case: 'marchingCubes 64^3 sphere', ...time(surface(baseline), surface(candidate), 4)},
];
// Bytes: the root entry with its npm dependencies bundled (what an app ships), @margoengine/* external, as build-modern.
async function bytes(entry) {
  const output = await build({configFile: false, publicDir: false, logLevel: 'silent', build: {write: false, minify: true, target: 'es2022', lib: {entry, formats: ['es']},
    rollupOptions: {external: id => id.startsWith('@margoengine/'), output: compactOutput}}});
  const code = (Array.isArray(output) ? output[0] : output).output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  return {raw: Buffer.byteLength(code), gzip: gzipSync(code).length};
}
/** Root entry bytes of packages/procedural/src at `at` (copied to a temp folder), or of the working tree without one. */
async function sizeAt(at) {
  if (!at) return bytes(resolve(root, 'packages/procedural/src/index.ts'));
  const folder = resolve(root, 'test-results/proofs-tmp', `procedural-${at.replace(/\W/g, '_')}-${process.pid}`);
  await mkdir(resolve(folder, 'src'), {recursive: true});
  for (const file of execFileSync('git', ['ls-tree', '--name-only', `${at}:packages/procedural/src`], {cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean))
    await writeFile(resolve(folder, 'src', file), execFileSync('git', ['show', `${at}:packages/procedural/src/${file}`], {cwd: root, encoding: 'utf8'}));
  try {return await bytes(resolve(folder, 'src/index.ts'));} finally {await rm(folder, {recursive: true, force: true});}
}
const sizes = {before: await sizeAt(ref), after: await sizeAt(pin)};
const report = {package: 'procedural', baseline: ref, candidate: pin ?? 'working tree', node: process.version, recordedAt: new Date().toISOString(), outputsIdentical: false, quietGated: false,
  notes: 'Own simplex (seamless, different values) and marching tetrahedra replace simplex-noise and isosurface. Timings are diagnostic (not quiet-gated). Sizes: root entry min+gzip with npm dependencies bundled, @margoengine/* external.',
  cases, sizes};
await save('procedural-deps', report);
console.log(JSON.stringify(report, null, 2));
