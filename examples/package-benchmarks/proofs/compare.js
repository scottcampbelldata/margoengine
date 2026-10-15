// Shared harness for optimization proofs: build one package from a Git ref and from the working tree,
// check both give the same answers on a real workload, then time them in interleaved rounds.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {build} from 'vite';

const root = resolve(import.meta.dirname, '../../..'), slash = value => value.replaceAll('\\', '/');
const bare = id => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id);

async function load(name, entry, ref) {
  // The package's src and packages/shared (inlined into every bundle) both come from the ref.
  const sources = [slash(resolve(root, 'packages', name, 'src')) + '/', slash(resolve(root, 'packages/shared')) + '/'];
  const show = file => {try {return execFileSync('git', ['show', `${ref}:${file.slice(slash(root).length + 1)}`], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26});} catch {return;}};
  const plugins = ref ? [{name: 'git-source', enforce: 'pre', resolveId(id, importer) {
    // A file deleted or renamed since the ref (e.g. shared/math.js, gltf-pro's instances.ts) is missing on disk; resolve it
    // to its path in the ref (.ts when the ref has one) so load() reads the ref.
    if (!importer || !id.startsWith('.')) return;
    const file = slash(resolve(dirname(importer.split('?')[0]), id)), ts = file.replace(/\.js$/, '.ts');
    if (sources.some(s => file.startsWith(s)) && !existsSync(file) && !existsSync(ts)) return show(ts) === undefined ? file : ts;
  }, load(id) {
    const file = slash(id.split('?')[0]);
    if (sources.some(s => file.startsWith(s))) return show(file); // undefined (not in the ref): the working tree
  }}] : [];
  const result = await build({root: resolve(root, 'packages', name), configFile: false, publicDir: false, logLevel: 'silent', plugins,
    build: {write: false, minify: false, target: 'es2022', lib: {entry: resolve(root, 'packages', name, entry), formats: ['es']}, rollupOptions: {external: bare}}});
  const chunks = result[0].output.filter(item => item.type === 'chunk');
  assert.equal(chunks.length, 1, `${name} must build to one module for comparison`);
  // Written inside the repository so bare imports such as @margoengine/core resolve normally.
  const directory = resolve(root, 'test-results/proofs-tmp'); await mkdir(directory, {recursive: true});
  const file = resolve(directory, `${name}-${entry.replace(/\W+/g, '_')}-${ref ?? 'working'}-${process.pid}.mjs`); await writeFile(file, chunks[0].code);
  return import(pathToFileURL(file).href);
}

/** `baseline` is the package at `ref`; `candidate` is the working tree, or `candidateRef` for a proof of an API that later changed. */
export async function versions(name, ref, entry = 'src/index.ts', candidateRef) {
  const commit = value => execFileSync('git', ['rev-parse', '--verify', `${value}^{commit}`], {cwd: root, encoding: 'utf8'}).trim();
  return {baseline: await load(name, entry, commit(ref)), candidate: await load(name, entry, candidateRef && commit(candidateRef))};
}

const median = values => values.slice().sort((a, b) => a - b)[values.length >> 1];
/** Interleave baseline (A) and candidate (B) runs A B B A so drift affects both alike. Each run returns nothing. */
export function time(runBaseline, runCandidate, rounds = 12) {
  for (let i = 0; i < 3; i++) {runBaseline(); runCandidate();}
  const a = [], b = [], once = run => {const start = performance.now(); run(); return performance.now() - start;};
  for (let i = 0; i < rounds; i++) {a.push(once(runBaseline)); b.push(once(runCandidate)); b.push(once(runCandidate)); a.push(once(runBaseline));}
  const baselineMs = median(a), candidateMs = median(b);
  return {baselineMs: +baselineMs.toFixed(4), candidateMs: +candidateMs.toFixed(4), speedup: +(baselineMs / candidateMs).toFixed(3)};
}

/** Save one package's proof next to this file and fail when the candidate is not faster. */
export async function record(name, ref, cases, notes = '') {
  for (const item of cases) assert.ok(item.speedup >= 1, `${name} ${item.case} is slower than ${ref}: ${item.speedup}x`);
  const report = {package: name, baseline: ref, node: process.version, recordedAt: new Date().toISOString(), outputsIdentical: true, notes, cases};
  await mkdir(resolve(import.meta.dirname, 'results'), {recursive: true});
  await writeFile(resolve(import.meta.dirname, 'results', `${name}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

/** Recorded GPU calls with the `agx()` WGSL body blanked: eaddd64 re-derived AgX from primary sources (same constants to
 * 1.2e-8, full-precision Rec.709/Rec.2020 matrices), an intended change that proofs against older refs must not flag. */
export const ignoreAgx = calls => JSON.parse(JSON.stringify(calls).replace(/fn agx\(v:vec3f\)->vec3f \{.*?\\n\}/g, 'fn agx(v:vec3f)->vec3f {}'));
