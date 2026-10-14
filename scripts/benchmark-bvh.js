import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {MeshBVH as Candidate} from '../packages/bvh/dist/index.js';
import {createWorkload} from '../examples/package-benchmarks/bvh.js';

// Build the package first. An explicit prior Git ref keeps this comparison repeatable after landing the change.
const baselineRef = process.argv[2];
if (!baselineRef) throw new Error('Usage: node scripts/benchmark-bvh.js <baseline Git ref>');
const sourcePath = 'packages/bvh/src/bvh.ts', baselineSource = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], {encoding: 'utf8'});
const currentSource = await readFile(sourcePath, 'utf8');
assert.notEqual(currentSource, baselineSource, 'Choose a Git ref before the shapecast change');
for (const name of ['build.ts', 'math.ts']) assert.equal((await readFile(`packages/bvh/src/${name}`, 'utf8')).replace(/\r\n/g, '\n'), execFileSync('git', ['show', `${baselineRef}:packages/bvh/src/${name}`], {encoding: 'utf8'}).replace(/\r\n/g, '\n'), `Benchmark expects unchanged ${name}`);
// Use the package's installed compiler CLI; TypeScript 7 no longer exposes its classic transpile API.
const names = (await readdir('packages/bvh/src')).filter(name => name.endsWith('.ts'));
async function emit(mode) {
  const directory = resolve('test-results/bvh-benchmark-emit', mode); await mkdir(`${directory}/src`, {recursive: true});
  for (const name of names) await writeFile(`${directory}/src/${name}`, mode === 'baseline' ? execFileSync('git', ['show', `${baselineRef}:packages/bvh/src/${name}`], {encoding: 'utf8'}) : await readFile(`packages/bvh/src/${name}`, 'utf8'));
  await writeFile(`${directory}/tsconfig.json`, JSON.stringify({extends: resolve('packages/bvh/tsconfig.json'), compilerOptions: {rootDir: './src', outDir: './dist'}, include: ['src']}));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', `${directory}/tsconfig.json`], {stdio: 'pipe'});
  return readFile(`${directory}/dist/bvh.js`, 'utf8');
}
const baselineCode = await emit('baseline'), currentCode = await readFile('packages/bvh/dist/bvh.js', 'utf8');
assert.equal(await emit('candidate'), currentCode, 'Rebuild BVH before benchmarking');
const loadable = baselineCode.replace(/from\s+(['"])\.\/([^'"]+)\1/g, (_, quote, name) => `from ${quote}${pathToFileURL(resolve('packages/bvh/dist', name)).href}${quote}`);
const {MeshBVH: Original} = await import(`data:text/javascript;base64,${Buffer.from(loadable).toString('base64')}`);
const work = createWorkload(256), source = work.source, old = Original.build(source), current = Candidate.build(source);
for (const key of ['nodes', 'index', 'triangles']) {
  const bytes = value => value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  assert.deepEqual(bytes(old[key]), bytes(current[key]), `Build changed ${key}`);
}
const inputs = Array.from({length: 24}, (_, i) => ({minX: Math.sin(i * 0.137) * work.extent * 0.45 - work.extent * 0.3,
  maxX: Math.sin(i * 0.137) * work.extent * 0.45 + work.extent * 0.3, minZ: Math.cos(i * 0.173) * work.extent * 0.35 - work.extent * 0.3,
  maxZ: Math.cos(i * 0.173) * work.extent * 0.35 + work.extent * 0.3}));
let sink = 0;
function runner(tree, mode) {
  let input, ranges = 0, sum = 0, capture = false, events = [], faces = [];
  const ordered = mode === 'ordered region', contained = mode === 'contained all', early = mode === 'early exit';
  const callbacks = {
    intersectsBounds(box, leaf, score, depth, node) {
      if (capture) events.push(1, node, Number(leaf), score, depth, box.min[0], box.min[1], box.min[2], box.max[0], box.max[1], box.max[2]);
      if (contained) return 2;
      if (box.max[0] < input.minX || box.min[0] > input.maxX || box.max[2] < input.minZ || box.min[2] > input.maxZ) return 0;
      return box.min[0] >= input.minX && box.max[0] <= input.maxX && box.min[2] >= input.minZ && box.max[2] <= input.maxZ ? 2 : 1;
    },
    intersectsRange(offset, count, inside, depth, node) {
      if (capture) {events.push(2, offset, count, Number(inside), depth, node); for (let i = offset; i < offset + count; i++) faces.push(tree.triangles[i]);}
      ranges++; sum += count; return early && ranges === 3;
    }
  };
  if (ordered) callbacks.boundsTraverseOrder = box => {
    const dx = (box.min[0] + box.max[0] - input.minX - input.maxX) * 0.5, dz = (box.min[2] + box.max[2] - input.minZ - input.maxZ) * 0.5;
    const score = dx * dx + dz * dz;
    if (capture) events.push(3, score, box.min[0], box.min[1], box.min[2], box.max[0], box.max[1], box.max[2]);
    return score;
  };
  return {
    trace(value) {input = value; ranges = sum = 0; events = []; faces = []; capture = true; const stopped = tree.shapecast(callbacks); capture = false; return {stopped, events, faces, sum, ranges};},
    batch() {const start = performance.now(); for (const value of inputs) {input = value; ranges = 0; sink += Number(tree.shapecast(callbacks));} sink += sum; sum = 0; return performance.now() - start;}
  };
}
const reports = [];
for (const mode of ['contained all', 'region', 'ordered region', 'early exit']) {
  const original = runner(old, mode), candidate = runner(current, mode);
  for (const input of inputs) assert.deepEqual(candidate.trace(input), original.trace(input), `${mode}: callbacks/results changed`);
  for (let i = 0; i < 12; i++) {original.batch(); candidate.batch();}
  const pairs = [];
  for (let i = 0; i < 12; i++) {
    const a = original.batch(), b = candidate.batch(), c = candidate.batch(), d = original.batch();
    pairs.push({originalMs: (a + d) / 2, candidateMs: (b + c) / 2, ratio: (a + d) / (b + c)});
  }
  const median = values => {const sorted = values.slice().sort((a, b) => a - b); return (sorted[5] + sorted[6]) / 2;};
  reports.push({mode, queriesPerBatch: inputs.length, pairs, originalMedianMs: median(pairs.map(pair => pair.originalMs)),
    candidateMedianMs: median(pairs.map(pair => pair.candidateMs)), medianRatio: median(pairs.map(pair => pair.ratio)), wins: pairs.filter(pair => pair.candidateMs < pair.originalMs).length,
    exactCallbackTraceAndFaceOrderCases: inputs.length});
}
async function size(replacement) {
  const directory = 'packages/bvh/dist', names = (await readdir(directory)).filter(name => name.endsWith('.js')).sort(), modules = {};
  for (const name of names) {const code = name === 'bvh.js' ? Buffer.from(replacement) : await readFile(`${directory}/${name}`); modules[name] = {raw: code.length, gzip: gzipSync(code).length};}
  return {modules, raw: Object.values(modules).reduce((total, module) => total + module.raw, 0), gzipSeparateModules: Object.values(modules).reduce((total, module) => total + module.gzip, 0)};
}
const baselineSize = await size(baselineCode), candidateSize = await size(currentCode);
const report = {baselineRef, nodeVersion: process.version, platform: process.platform, measurement: 'CPU-only Node ABBA; no GPU or render FPS claim', triangles: old.triangleCount,
  nodes: old.nodeCount, buildBytesExact: true, reports, baselineSize, candidateSize,
  delta: {raw: candidateSize.raw - baselineSize.raw, gzipSeparateModules: candidateSize.gzipSeparateModules - baselineSize.gzipSeparateModules}, sink};
await mkdir('test-results', {recursive: true}); await writeFile('test-results/bvh-shapecast-benchmark.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({reports: reports.map(({pairs, ...summary}) => summary), delta: report.delta}));
work.dispose();
