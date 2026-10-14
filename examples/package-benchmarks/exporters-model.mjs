// exportModel cost and output: export time (median of 7 after 2 warm-ups), output size and Khronos glTF-Validator
// counts for DamagedHelmet, RobotExpressive (14 clips) and a generated instanced GLB, next to the source files.
// Run after `npm run build:packages`: node examples/package-benchmarks/exporters-model.mjs  (writes results/exporters-model.json)
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {parseGLTFAsync} from '../../packages/gltf-pro/dist/index.js';
import {instancing} from '../../packages/gltf-pro/dist/instancing.js';
import {Animation} from '../../packages/animation/dist/index.js';
import {exportModel} from '../../packages/exporters/dist/model.js';
import {headless, headlessModels} from '../../tests/support/pbr-snapshot.js';
import {bigGLB} from '../../tests/support/big-glb.js';

const validator = createRequire(import.meta.url)('gltf-validator');
const summary = async bytes => {
  const r = await validator.validateBytes(bytes, {maxIssues: 0}), codes = {};
  for (const m of r.issues.messages) if (m.severity <= 1) codes[m.code] = (codes[m.code] ?? 0)+1;
  return {errors: r.issues.numErrors, warnings: r.issues.numWarnings, infos: r.issues.numInfos, codes};
};
const asset = name => readFile(new URL(`../assets/${name}`, import.meta.url)).then(b => new Uint8Array(b));
const cases = [
  ['DamagedHelmet', () => asset('damaged-helmet.glb'), false, {}],
  ['RobotExpressive', () => asset('robot-expressive.glb'), true, {}],
  ['Instanced grids (2 x 33x33 vertices, 2 x 500 instances)', async () => bigGLB({segments: 32, meshes: 2, instances: 500}), false, {instancing}],
];
const results = {node: process.version, date: new Date().toISOString(), cases: []};
await headlessModels(async () => {
  for (const [name, load, animated, decoders] of cases) {
    const source = await load(), model = await parseGLTFAsync(await headless(), source.slice(), {decoders});
    const options = {binary: true, animations: animated ? [new Animation(model)] : []}, times = [];
    let glb;
    for (let i = 0; i < 9; i++) {const t = performance.now(); glb = await exportModel(model, options); if (i > 1) times.push(performance.now()-t);}
    times.sort((a, b) => a-b);
    const row = {name, sourceBytes: source.length, exportBytes: glb.length, exportMs: +times[3].toFixed(2), minMs: +times[0].toFixed(2), source: await summary(source), export: await summary(glb)};
    results.cases.push(row); console.log(JSON.stringify(row));
  }
});
await writeFile(new URL('./results/exporters-model.json', import.meta.url), JSON.stringify(results, null, 2)+'\n');
