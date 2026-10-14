// Proof for the math consolidation (HANDOFF queue item 5): every helper that moved into @margoengine/math gives
// bit-identical results to the package copy it replaced. The old copies are built from `ref` with the repo harness
// (compare.js `versions`); copies that were not exported are first checked to be textually identical (whitespace and
// types aside) to one that is. Inputs mix random values with ±0, NaN, ±Infinity, subnormals, huge values and singular
// matrices; equality is Object.is per element, so -0 and NaN count.
// Run after `npm run build:packages`:
//   node examples/package-benchmarks/proofs/math-consolidation.proof.js [ref]          outputs
//   node examples/package-benchmarks/proofs/math-consolidation.proof.js [ref] --time   hot-path timings (fresh process, so
//     each side's type feedback is only its own, as in an app)
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {versions, time} from './compare.js';
import * as mat4 from '@margoengine/math/mat4';

const timing = process.argv.includes('--time'), ref = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? '2484971';
const root = resolve(import.meta.dirname, '../../..');
/** {baseline, candidate}: one package file at `ref` and in the working tree (now using math). */
const both = (name, entry) => versions(name, ref, entry);
const source = file => execFileSync('git', ['show', `${ref}:${file}`], {cwd: root, encoding: 'utf8', maxBuffer: 1 << 26});
/** Source of `function name(...) {...}` or `const name = ...;` in `file` at `ref`, without whitespace and simple type annotations. */
function body(file, name) {
  const text = source(file), start = text.search(new RegExp(`(function|const) ${name}\\b`));
  assert.ok(start >= 0, `${name} not found in ${file}`);
  let depth = 0, i = text.indexOf('{', start), end = i;
  if (text.startsWith('const', start) && text.indexOf(';', start) < i) end = text.indexOf(';', start);
  else for (; i < text.length; i++) {if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) {end = i; break;}}
  return text.slice(start, end + 1).replace(/:\s*(Float64Array|Float32Array|number\[\]|number|Mat4|ArrayLike<number>)\b/g, '').replace(/<number>/g, '').replace(/\s+/g, '');
}

let seed = 7; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const specials = [0, -0, NaN, Infinity, -Infinity, 1, -1, 5e-324, -5e-324, 2.2250738585072014e-308, 1e-310, 1e300, -1e300, 3.4028235677973366e38, 0.5, 1e-7];
const value = () => {const r = random(); return r < 0.15 ? specials[Math.floor(random() * specials.length)] : r < 0.25 ? Math.round(random() * 8 - 4) : (random() * 2 - 1) * 10 ** (random() * 6 - 3);};
function matrices(count) {
  const out = [new Array(16).fill(0), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 2, 3, 4, 2, 4, 6, 8, 0, 1, 0, 0, 0, 0, 1, 0], [1e-200, 0, 0, 0, 0, 1e-200, 0, 0, 0, 0, 1e-200, 0, 0, 0, 0, 1]];
  for (let i = 0; i < count; i++) {
    const m = Array.from({length: 16}, value);
    if (i % 7 === 0) {m[3] = m[7] = m[11] = 0; m[15] = 1;} // affine
    if (i % 11 === 0) for (let k = 0; k < 4; k++) m[8 + k] = m[k] * 2; // singular: dependent columns
    out.push(i % 3 === 0 ? new Float32Array(m) : i % 3 === 1 ? new Float64Array(m) : m);
  }
  return out;
}
/** Plain random affine matrices (no specials) for timings. */
const poses = count => Array.from({length: count}, () => {const m = Array.from({length: 16}, () => random() * 4 - 2); m[3] = m[7] = m[11] = 0; m[15] = 1; return new Float32Array(m);});
const same = (a, b) => a === b || (a && b && a.length === b.length && Array.prototype.every.call(a, (v, i) => Object.is(v, b[i])));
const families = [];

// --- mat4 multiply: animation, bvh, points, text, exporters, loaders/usdz, usdz ---
families.push({name: 'mat4 multiply', async verify() {
  const M = matrices(4000), bvh = await both('bvh', 'src/math.ts'), points = await both('points', 'src/math.ts'), text = (await both('text', 'src/math.ts')).baseline;
  const animation = await both('animation', 'src/sampling.ts'), exporters = (await both('exporters', 'src/scene.ts')).baseline;
  // Same loops and the same element expression as bvh's; only how `out` is obtained and returned differs.
  const core = code => /for\(letc=0;c<4;c\+\+\)for\(letr=0;r<4;r\+\+\)\{?(out\[c\*4\+r\]=[^;]+;)/.exec(code)?.[1], reference = core(body('packages/bvh/src/math.ts', 'multiply'));
  assert.ok(reference);
  for (const [file, name] of [['packages/points/src/math.ts', 'multiply'], ['packages/text/src/math.ts', 'multiply'], ['packages/animation/src/sampling.ts', 'multiplyMatrices'],
    ['packages/exporters/src/scene.ts', 'multiply'], ['packages/loaders/src/usdz.ts', 'multiply'], ['packages/usdz/src/index.ts', 'multiply']]) assert.equal(core(body(file, name)), reference, `${file} ${name}`);
  for (let i = 0; i + 1 < M.length; i++) {
    const a = M[i], b = M[M.length - 1 - i];
    for (const make of [() => new Float64Array(16), () => new Float32Array(16), () => new Array(16).fill(0)]) {
      const expected = make(), actual = make(), p = make(), q = make();
      bvh.baseline.multiply(a, b, expected); assert.equal(mat4.multiplyMatrices(a, b, actual), actual); assert.ok(same(actual, expected), `multiply ${i}`);
      points.baseline.multiply(a, b, p); assert.equal(points.candidate.multiply(a, b, q), q); assert.ok(same(p, actual) && same(q, actual));
    }
    const t = new Float32Array(16), u = new Float32Array(16), s = new Float32Array(16), v = new Float32Array(16);
    text.multiply(t, a, b); mat4.multiplyMatrices(a, b, u); assert.ok(same(t, u));
    animation.baseline.multiplyMatrices(s, a, b); assert.equal(animation.candidate.multiplyMatrices(v, a, b), undefined); assert.ok(same(s, u) && same(v, u));
    assert.ok(same(exporters.multiply(new Float64Array(a), new Float64Array(b)), mat4.multiplyMatrices(a, b, new Float64Array(16))));
    for (const module of [bvh, points]) {const x = module.baseline.multiply(a, b), y = module.candidate.multiply(a, b); assert.ok(y instanceof Float64Array && same(x, y));}
  }
  return M.length * 12;
}, async bench() {
  const animation = await both('animation', 'src/sampling.ts'), text = (await both('text', 'src/math.ts')).baseline;
  const joints = poses(64), palette = new Float32Array(16 * 64), joint = new Float32Array(16), old = animation.baseline.multiplyMatrices;
  return [
    {case: 'animation skinning palette (index.ts/vat.ts), 64 joints x 1,000 frames', ...time(
      () => {for (let f = 0; f < 1000; f++) for (let j = 0; j < 64; j++) {old(joint, joints[j], joints[63 - j]); old(palette.subarray(j * 16, j * 16 + 16), joints[j], joint);}},
      () => {for (let f = 0; f < 1000; f++) for (let j = 0; j < 64; j++) {mat4.multiplyMatrices(joints[j], joints[63 - j], joint); mat4.multiplyMatrices(joints[j], joint, palette.subarray(j * 16, j * 16 + 16));}})},
    {case: 'text renderer parented model matrices, 100,000', ...time(
      () => {for (let i = 0; i < 100000; i++) text.multiply(joint, joints[i & 63], joints[(i + 1) & 63]);},
      () => {for (let i = 0; i < 100000; i++) mat4.multiplyMatrices(joints[i & 63], joints[(i + 1) & 63], joint);})},
  ];
}});

// --- mat4 invert (cofactors): bvh, lines, environment ---
families.push({name: 'mat4 invert', async verify() {
  const M = matrices(6000), bvh = await both('bvh', 'src/math.ts'), lines = (await both('lines', 'src/math.ts')).baseline, environment = (await both('environment', 'src/background.ts')).baseline;
  // environment's copy is the same text as lines' (both return a boolean); bvh's returns out/null with `inv` for `d`.
  const inner = code => code.slice(code.indexOf('{'));
  assert.equal(inner(body('packages/environment/src/background.ts', 'invert')), inner(body('packages/lines/src/math.ts', 'invert')));
  for (const m of M) for (const make of [() => new Float64Array(16).fill(7), () => new Float32Array(16).fill(7), () => new Array(16).fill(7)]) {
    const a = make(), b = make(), c = make(), d = make(), e = make(), result = mat4.invertMatrix(m, a);
    assert.ok(result === a || result === null);
    assert.equal(bvh.baseline.invert(m, b), result && b); assert.ok(same(a, b), 'invert');
    assert.equal(lines.invert(c, m), result !== null); assert.equal(environment.invert(m, d), result !== null); assert.ok(same(a, c) && same(a, d));
    assert.equal(bvh.candidate.invert(m, e), result && e); assert.ok(same(a, e));
    const x = bvh.baseline.invert(m), y = bvh.candidate.invert(m); assert.ok(x === null ? y === null : y instanceof Float64Array && same(x, y));
  }
  return M.length * 3 * 5;
}, async bench() {
  const bvh = await both('bvh', 'src/math.ts'), lines = (await both('lines', 'src/math.ts')).baseline, M = poses(256), out = new Float64Array(16);
  return [
    {case: 'bvh Raycaster per-mesh inverse, 200,000', ...time(
      () => {for (let i = 0; i < 200000; i++) bvh.baseline.invert(M[i & 255], out);}, () => {for (let i = 0; i < 200000; i++) mat4.invertMatrix(M[i & 255], out);})},
    {case: 'lines CameraHelper / environment background inverse, 200,000', ...time(
      () => {for (let i = 0; i < 200000; i++) lines.invert(out, M[i & 255]);}, () => {for (let i = 0; i < 200000; i++) mat4.invertMatrix(M[i & 255], out);})},
  ];
}});

// --- packages/shared/math.js (pivoted invert + finiteVector) moved to math: animation, creative, gltf-pro, machinery,
// post, sky, taa (invert); animator, clustered, creative, shadows, sky, terrain, vfx (finiteVector) ---
async function sharedAtRef() {
  const {mkdir, writeFile} = await import('node:fs/promises'), {pathToFileURL} = await import('node:url');
  const directory = resolve(root, 'test-results/proofs-tmp'), file = resolve(directory, `shared-math-${ref}-${process.pid}.mjs`);
  await mkdir(directory, {recursive: true}); await writeFile(file, source('packages/shared/math.js'));
  return import(pathToFileURL(file).href);
}
families.push({name: 'shared/math invert + finiteVector', async verify() {
  const shared = await sharedAtRef(), validate = await import('@margoengine/math/validate'), M = matrices(6000);
  let n = 0;
  for (const m of M) for (const Out of [Float64Array, Float32Array]) for (const workspace of [undefined, new Float64Array(52)]) {
    const a = new Out(16).fill(7), b = new Out(16).fill(7), ok = shared.invert(a, m, 0, workspace), result = mat4.invertMatrixStable(m, b, workspace);
    assert.equal(result, ok ? b : null); assert.ok(same(a, b), 'invertMatrixStable'); n++;
    if (m instanceof Out) {const c = m.slice(), d = m.slice(); assert.equal(shared.invert(c, c), mat4.invertMatrixStable(d, d) === d); assert.ok(same(c, d)); n++;} // out aliases m
  }
  // Rejected arguments: short arrays, a workspace that is too small, not float64, or shares out's or m's buffer.
  const m = new Float64Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]), shared52 = new Float64Array(52 + 16);
  for (const [out, input, workspace] of [[new Float64Array(15), m], [new Float64Array(16), m.subarray(1)], [new Float64Array(16), m, new Float64Array(51)], [new Float64Array(16), m, new Float32Array(52)],
    [shared52.subarray(52), m, shared52.subarray(0, 52)], [new Float64Array(16), shared52.subarray(52), shared52.subarray(0, 52)], [new Float32Array(16), [3.4e38, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].map((v, i) => i ? v : 1e-39)]]) {
    const a = out.slice(), b = out.slice(); assert.equal(shared.invert(a, input, 0, workspace), mat4.invertMatrixStable(input, b, workspace) === b); assert.ok(same(a, b)); n++;
  }
  for (const v of [...specials, '1', null, undefined, 3.4028235e38, -3.4028235e38, 3.40282357e38]) for (const size of [1, 2]) {
    const error = f => {try {f(); return null;} catch (e) {return [e.constructor, e.message];}};
    assert.deepEqual(error(() => validate.finiteVector([v, 0].slice(0, size), size, 'Vector')), error(() => shared.finiteVector([v, 0].slice(0, size), size, 'Vector'))); n++;
    assert.deepEqual(error(() => validate.finiteVector([v], size, 'Vector')), error(() => shared.finiteVector([v], size, 'Vector'))); n++;
  }
  return n;
}, async bench() {
  const shared = await sharedAtRef(), M = poses(256), out = new Float32Array(16), workspace = new Float64Array(52);
  return [{case: 'post/taa/sky/creative per-frame camera inverse (pivoted), 100,000', ...time(
    () => {for (let i = 0; i < 100000; i++) shared.invert(out, M[i & 255], 0, workspace);}, () => {for (let i = 0; i < 100000; i++) mat4.invertMatrixStable(M[i & 255], out, workspace);})}];
}});

const checked = {}, timings = [];
for (const family of families) {
  if (timing) {if (family.bench) timings.push(...(await family.bench()).map(item => ({family: family.name, ...item})));}
  else checked[family.name] = await family.verify();
}
console.log(JSON.stringify(timing ? {ref, node: process.version, timings} : {ref, node: process.version, outputsIdentical: true, checked}, null, 1));
