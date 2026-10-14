import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {GLTFAsset, PBRModel} from '../packages/gltf-pro/dist/index.js';
import {animationSources, importAnimationSources} from './support/animation-output-candidate.js';
import {animationOutputFixture} from '../tests/support/animation-output-fixture.js';

const iterations = Number(process.env.ANIMATION_CANDIDATE_ITERATIONS ?? 5000), counts = (process.env.ANIMATION_CANDIDATE_COUNTS ?? '1,16').split(',').map(Number);
assert.ok(Number.isSafeInteger(iterations) && iterations >= 1000 && iterations <= 100000);
assert.ok(counts.length > 0 && counts.every(count => Number.isSafeInteger(count) && count >= 1 && count <= 64));
const sources = await animationSources(), variant = process.env.ANIMATION_CANDIDATE_VARIANT ?? 'candidate';
assert.ok(['candidate', 'arithmetic', 'minimal'].includes(variant));
const selected = {original: sources.original, candidate: sources[variant]}, implementations = {A: await importAnimationSources(selected.original), B: await importAnimationSources(selected.candidate)};
const hash = text => createHash('sha256').update(text).digest('hex');
const report = {recordedAt: new Date().toISOString(), variant, iterations, order: ['A', 'B', 'B', 'A', 'B', 'A', 'A', 'B'],
  interpretation: 'Private CPU-only actual Animation.seek workload, real Core transform setters and glTF accessors. No render/GPU/FPS/startup claim. A is current source, B is the selected unadopted candidate; Core source and public fresh-output signature remain unchanged.',
  sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, files]) => [name, Object.fromEntries(Object.entries(files).map(([file, text]) => [file, hash(text)]))])), cases: []};
const close = records => {for (const record of records) {record.animation.dispose(); record.model.dispose(); record.engine.dispose();}};
async function create(implementation, count) {
  const records = [];
  try {
    for (let i = 0; i < count; i++) {
      const store = await TransformStore.create(32), engine = new Engine({width: 256, height: 256, clientWidth: 256, clientHeight: 256}, store,
        {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}}), fixture = animationOutputFixture();
      const model = new PBRModel(engine, new GLTFAsset(fixture.doc, fixture.buffers)), animation = new implementation.Animation(model, {loop: false});
      records.push({engine, store, model, animation});
    }
    return records;
  } catch (error) {close(records); throw error;}
}
function update(records, frames) {
  for (let i = 0; i < frames; i++) for (const record of records) {record.animation.clip = i % 3; record.animation.seek((i % 997) / 996);}
}
function allocations(records) {
  const Float32 = globalThis.Float32Array, from = Array.from; let typedOutputs = 0, rotationCopies = 0;
  try {
    globalThis.Float32Array = new Proxy(Float32, {construct(target, args) {typedOutputs++; return Reflect.construct(target, args);}});
    Array.from = function(...args) {rotationCopies++; return from.apply(this, args);}; update(records, 128);
  } finally {globalThis.Float32Array = Float32; Array.from = from;}
  return {frames: 128, typedOutputs, rotationCopies};
}
function imageOfState(records) {
  return records.map(record => ({transforms: Object.fromEntries(Object.entries(record.store.transforms).map(([key, value]) => [key, Array.from(value)])),
    euler: Array.from(record.store.rotations), morphs: record.model.primitives.map(primitive => Array.from(primitive.weights))}));
}
for (const count of counts) {
  const original = await create(implementations.A, count), candidate = await create(implementations.B, count);
  try {
    const records = {A: original, B: candidate}, result = {models: count, tracksPerModel: 4, clips: 3, allocations: {A: allocations(original), B: allocations(candidate)}, runs: []};
    assert.deepEqual(imageOfState(candidate), imageOfState(original));
    assert.equal(result.allocations.A.typedOutputs, count * 128 * 4); assert.equal(result.allocations.A.rotationCopies, count * 128);
    assert.equal(result.allocations.B.typedOutputs, variant === 'candidate' ? 0 : count * 128 * 4); assert.equal(result.allocations.B.rotationCopies, variant === 'candidate' ? 0 : count * 128);
    for (const group of [original, candidate]) update(group, 2000);
    for (const name of report.order) {
      const started = performance.now(); update(records[name], iterations); const elapsed = performance.now() - started;
      result.runs.push({implementation: name, elapsedMilliseconds: elapsed, millisecondsPerModelUpdate: elapsed / iterations / count});
    }
    assert.deepEqual(imageOfState(candidate), imageOfState(original));
    const median = name => result.runs.filter(run => run.implementation === name).map(run => run.millisecondsPerModelUpdate).sort((a, b) => a - b).slice(1, 3).reduce((sum, value) => sum + value, 0) / 2;
    result.medianMillisecondsPerModelUpdate = {A: median('A'), B: median('B')}; result.candidateSpeedRatio = median('A') / median('B');
    report.cases.push(result);
  } finally {close(original); close(candidate);}
}
if (process.env.ANIMATION_CANDIDATE_SIZE === '1') {
  const {build} = await import('vite'), {compactOutput} = await import('./measure-size.js'); report.bundle = {};
  for (const [name, source] of Object.entries(selected)) {
    const output = await build({configFile: false, publicDir: false, logLevel: 'silent', plugins: [{name: 'private-animation-source', enforce: 'pre', transform(_code, id) {
      for (const key of ['index', 'sampling']) if (id.replaceAll('\\', '/') === resolve(`packages/animation/src/${key}.ts`).replaceAll('\\', '/')) return {code: source[key], map: null};
    }}], build: {write: false, target: 'es2022', lib: {entry: 'packages/animation/src/index.ts', formats: ['es'], fileName: () => 'index.js'},
      rollupOptions: {external: ['@margoengine/core', '@margoengine/core/extension', '@margoengine/gltf-pro'], output: compactOutput}}});
    const chunks = (Array.isArray(output) ? output[0] : output).output.filter(chunk => chunk.type === 'chunk'), code = chunks.map(chunk => chunk.code).join('\n');
    assert.equal(chunks.length, 1); report.bundle[name] = {raw: Buffer.byteLength(code), gzip: gzipSync(code).length, sha256: hash(code)};
  }
  report.bundle.delta = {raw: report.bundle.candidate.raw - report.bundle.original.raw, gzip: report.bundle.candidate.gzip - report.bundle.original.gzip};
  const core = await readFile('packages/core/dist/index.js'), stage = await readFile('packages/margoengine/dist/index.js');
  report.coreStageUnmodifiedHashes = {core: hash(core), stage: hash(stage)};
}
report.completedAt = new Date().toISOString(); await mkdir('test-results', {recursive: true});
await writeFile(`test-results/animation-${variant === 'candidate' ? 'output' : variant}-private-candidate.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({cases: report.cases.map(record => ({models: record.models, speedRatio: record.candidateSpeedRatio, allocations: record.allocations})), bundle: report.bundle, productionEdited: false}));
