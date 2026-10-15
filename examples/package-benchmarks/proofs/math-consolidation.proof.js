// Proof for the math consolidation (HANDOFF queue item 5): every helper that moved into @margoengine/math gives
// bit-identical results to the package copy it replaced. The old copies are built from `ref` with the repo harness
// (compare.js `versions`); copies that were not exported are first checked to be textually identical (whitespace and
// types aside) to one that is. Inputs mix random values with ±0, NaN, ±Infinity, subnormals, huge values and singular
// matrices; equality is Object.is per element, so -0 and NaN count.
// Run after `npm run build:packages`:
//   node examples/package-benchmarks/proofs/math-consolidation.proof.js [ref] [pin] [--current]          outputs
//   node examples/package-benchmarks/proofs/math-consolidation.proof.js [ref] [pin] [--current] --time   hot-path timings
//     (fresh process, so each side's type feedback is only its own, as in an app)
// Pinned: 2484971 (before 1/n) against 4eed254 (9/n, the last step): @margoengine/math and the package files are built at
// 4eed254 (their own @margoengine/math imports resolve to the working tree's build). --current: 2484971 against the
// working tree, since the guarantee is that math stays bit-identical to the copies it replaced.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {refs, versions, time, entryAt} from './compare.js';

const timing = process.argv.includes('--time'), {ref, pin} = refs('2484971', '4eed254');
const root = resolve(import.meta.dirname, '../../..');
/** An @margoengine/math entry at the candidate (`pin`, else the working tree's build). */
const math = entry => entryAt('math', `src/${entry}.ts`, pin), mat4 = await math('mat4');
/** {baseline, candidate}: one package file at `ref` and at the candidate (now using math). */
const both = (name, entry) => versions(name, ref, entry, pin);
const source = file => execFileSync('git', ['show', `${ref}:${file}`], {cwd: root, encoding: 'utf8', maxBuffer: 1 << 26});
/** Source of `function name(...) {...}` or `const name = ...;` in `file` at `ref`, without whitespace and simple type annotations. */
function body(file, name) {
  const text = source(file), start = text.search(new RegExp(`(function|const) ${name}\\b`));
  assert.ok(start >= 0, `${name} not found in ${file}`);
  let depth = 0, i = text.indexOf('{', start), end = i;
  if (i < 0) i = text.length;
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
const same = (a, b) => Object.is(a, b) || (a && b && a.length === b.length && Array.prototype.every.call(a, (v, i) => Object.is(v, b[i])));
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
  const shared = await sharedAtRef(), validate = await math('validate'), M = matrices(6000);
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

// --- TRS compose: exporters, labels (labels normalizes the quaternion first) ---
families.push({name: 'mat4 compose', async verify() {
  const exporters = (await both('exporters', 'src/scene.ts')).baseline, labels = await both('labels', 'src/projection.ts');
  const vec = n => Array.from({length: n}, value), unit = () => {const q = vec(4), l = Math.hypot(...q); return l && Number.isFinite(l) && random() < 0.8 ? q.map(v => v / l) : q;};
  let n = 0;
  for (let i = 0; i < 30000; i++) {
    const t = vec(3), q = i % 5 ? unit() : vec(4), s = vec(3);
    assert.ok(same(exporters.compose(t, q, s), mat4.composeMatrix(t, q, s, new Float64Array(16))), 'compose');
    for (const Out of [Float64Array, Float32Array]) {const a = mat4.composeMatrix(t, q, s, new Out(16)), b = new Out(exporters.compose(t, q, s)); assert.ok(same(a, b));}
    const x = labels.baseline.composeMatrix(t, q, s, new Float64Array(16).fill(7)), y = labels.candidate.composeMatrix(t, q, s, new Float64Array(16).fill(7)); assert.ok(same(x, y), 'labels composeMatrix');
    assert.ok(same(labels.baseline.composeMatrix(t), labels.candidate.composeMatrix(t)) && same(labels.baseline.composeMatrix(t, q), labels.candidate.composeMatrix(t, q)));
    n += 6;
  }
  return n;
}});

// --- quaternions: euler -> quaternion (physics, text), multiply (controls, animator) ---
families.push({name: 'quat euler + multiply', async verify() {
  const quat = await math('quat'), physics = await both('physics', 'src/math.ts'), text = (await both('text', 'src/math.ts')).baseline;
  // controls' quatMul (not exported) has the same four expressions as animator's quaternionMultiply, which is run below.
  const rows = code => {const start = code.indexOf('[a[3]*b[0]'); return code.slice(start, code.indexOf(']', code.lastIndexOf('a[2]*b[2]')) + 1).replace(/,\]$/, ']');};
  assert.equal(rows(body('packages/controls/src/math.ts', 'quatMul')), rows(body('packages/animator/src/blend.ts', 'quaternionMultiply')));
  const animator = (await both('animator', 'src/blend.ts')).baseline;
  let n = 0;
  for (let i = 0; i < 60000; i++) {
    const [x, y, z] = [value(), value(), i % 3 ? value() : (random() - 0.5) * 20];
    const expected = physics.baseline.eulerToQuat(x, y, z); assert.ok(same(quat.eulerToQuaternion(x, y, z), expected) && same(physics.candidate.eulerToQuat(x, y, z), expected) && same(text.eulerToQuaternion([x, y, z]), expected), 'euler');
    const a = [value(), value(), value(), value()], b = [value(), value(), value(), value()];
    assert.ok(same(quat.multiplyQuaternions(a, b), animator.quaternionMultiply(a, b)), 'multiply'); n += 4;
  }
  return n;
}});

// --- colour: parseColor (lines, points, text), sRGB decode (those three, loaders engine, environment), encode (text, exporters) ---
families.push({name: 'colour parse + sRGB', async verify() {
  const color = await math('color'), copies = [];
  for (const name of ['lines', 'points', 'text']) {const {baseline, candidate} = await both(name, 'src/color.ts'); copies.push(baseline.parseColor, candidate.parseColor);}
  const environment = (await both('environment', 'src/color.ts')).baseline, text = (await both('text', 'src/color.ts')).baseline, exporters = (await both('exporters', 'src/scene.ts')).baseline;
  const decode = 'v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4';
  assert.equal(body('packages/loaders/src/engine.ts', 'toLinear').replace(/^.*=>/, ''), decode + ';');
  for (const name of ['lines', 'points', 'text']) assert.equal(body(`packages/${name}/src/color.ts`, 'linear').replace(/^.*=>/, '').replaceAll('value', 'v'), decode + ';');
  const outcome = (f, ...args) => {try {return f(...args);} catch (error) {return [error.constructor, error.message];}};
  const inputs = [0, 0xffffff, 0x123456, -1, 0x1000000, 1.5, NaN, Infinity, '#fff', '#FFF', '#a1B2c3', '#12345', 'fff', '#ggg', '', '#1234567', null, undefined, {}, true,
    [0, 0.5, 1], [2, 3, 4], [-0, 0, 0], [-1, 0, 0], [NaN, 0, 0], [Infinity, 0, 0], ['1', 0, 0], [0, 0], [0, 0, 0, 0], new Float32Array([0.1, 0.2, 0.3])];
  for (let i = 0; i < 5000; i++) inputs.push(Math.floor(random() * 0x1000000), '#' + Math.floor(random() * 0x1000000).toString(16).padStart(6, '0'), '#' + Math.floor(random() * 0x1000).toString(16).padStart(3, '0'), [value(), value(), value()]);
  let n = 0;
  for (const input of inputs) for (const [make, offset] of [[() => [0, 0, 0], 0], [() => new Float32Array(5).fill(9), 2], [undefined, undefined]]) {
    const expected = outcome(copies[0], input, make?.(), offset), actual = outcome(color.parseColor, input, make?.(), offset);
    assert.ok(Array.isArray(expected) && typeof expected[0] === 'function' ? Object.is(expected[0], actual[0]) || expected[0].name === actual[0].name && expected[1] === actual[1] : same(expected, actual), `parseColor ${String(input)}`);
    for (const copy of copies.slice(1)) {const other = outcome(copy, input, make?.(), offset); assert.ok(typeof expected[0] === 'function' ? other[0].name === expected[0].name && other[1] === expected[1] : same(other, expected));}
    n += copies.length;
  }
  // splats' decode lives inside parseSplat: same text, and every byte value decodes the same through the old and new parser.
  assert.equal(body('packages/splats/src/data.ts', 'linear').replace(/^.*=>/, '').replaceAll('c', 'v'), decode + ';');
  const splats = await both('splats', 'src/data.ts'), file = new Uint8Array(256 * 32), view = new DataView(file.buffer);
  for (let i = 0; i < 256; i++) {for (let k = 0; k < 6; k++) view.setFloat32(i * 32 + k * 4, k < 3 ? random() * 10 - 5 : 0.01 + random(), true); for (let k = 24; k < 32; k++) file[i * 32 + k] = k < 28 ? (i + k * 37) & 255 : 1 + Math.floor(random() * 254);}
  const parsed = [splats.baseline.parseSplat(file), splats.candidate.parseSplat(file)];
  for (const key of ['positions', 'covariances', 'colors']) assert.ok(same(parsed[0][key], parsed[1][key]), `splats ${key}`);
  n += 256 * 4;
  for (let i = 0; i < 200000; i++) {
    const v = i < 300 ? specials[i % specials.length] * (i % 2 ? 1 : 1e-3) : i % 2 ? random() : value();
    assert.ok(Object.is(color.SRGBToLinear(v), environment.srgbToLinear(v)) && Object.is(color.LinearToSRGB(v), text.encodeSrgb(v)) && Object.is(color.LinearToSRGB(v), exporters.toSrgb(v))); n += 3;
  }
  return n;
}});

// --- seeded PRNGs: points' mulberry32 (= math createRandom), scatter + creative grass LCG (= math createLcgRandom) ---
families.push({name: 'seeded PRNGs', async verify() {
  const utils = await math('mathutils'), points = await both('points', 'src/math.ts'), scatter = await both('scatter', 'src/candidates.ts');
  const seeds = [0, -0, 1, -1, 7, 2 ** 31, 2 ** 32, 2 ** 32 + 5, -(2 ** 31), 2 ** 53, 1.5, -2.5, NaN, Infinity, -Infinity, 0x9e3779b1, 0x12345678];
  for (let i = 0; i < 200; i++) seeds.push(Math.floor(random() * 2 ** 32), (random() - 0.5) * 1e12);
  let n = 0;
  for (const seed of seeds) {
    const a = points.baseline.random(seed), b = points.candidate.random(seed), c = utils.createRandom(seed);
    for (let i = 0; i < 1000; i++) {const x = a(); assert.ok(Object.is(b(), x) && Object.is(c(), x), `mulberry32 ${seed}`); n++;}
  }
  // grass's closure has math's expression (state named seed); scatter's is the |0 form, compared through its public API.
  assert.ok(body('packages/creative/src/grass.ts', 'random').includes('seed=(Math.imul(seed,1664525)+1013904223)>>>0;returnseed/4294967296;'));
  assert.ok(body('packages/scatter/src/candidates.ts', 'random').includes('seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;'));
  for (const seed of [0, 1, 0x12345678, 0xffffffff, 2 ** 31, ...seeds.slice(17, 80).filter(s => Number.isInteger(s) && s >= 0 && s <= 0xffffffff)]) {
    const bounds = [-50, -50, 50, 50], x = scatter.baseline.randomPlacements(500, bounds, [0.5, 2], seed), y = scatter.candidate.randomPlacements(500, bounds, [0.5, 2], seed);
    assert.deepEqual(y, x);
    const lcg = utils.createLcgRandom(seed); let state = seed; // the scatter expression, transcribed
    for (let i = 0; i < 1000; i++) {state = Math.imul(state, 1664525) + 1013904223 | 0; assert.ok(Object.is(lcg(), (state >>> 0) / 4294967296)); n++;}
    n += 500;
  }
  return n;
}, async bench() {
  const points = await both('points', 'src/math.ts'), count = 400000, positions = new Float32Array(count * 3).map(() => random() * 100);
  assert.deepEqual(points.candidate.buildBlocks(positions, count, 4096, 3).order, points.baseline.buildBlocks(positions, count, 4096, 3).order);
  return [{case: 'points buildBlocks (seeded shuffle per block), 400,000 points', ...time(
    () => {points.baseline.buildBlocks(positions, count, 4096, 3);}, () => {points.candidate.buildBlocks(positions, count, 4096, 3);}, 8)}];
}});

// --- vec3 helpers: controls (add, sub, scale, dot, cross, length, normalize, clamp), machinery metrology/clearance/dimensions ---
families.push({name: 'vec3 helpers', async verify() {
  const vec3 = await math('vec3'), utils = await math('mathutils'), controls = (await both('controls', 'src/math.ts')).baseline;
  // machinery's copies differ from controls' only in parameter types.
  const expression = code => code.replace(/^const\w+=\([^)]*\)(:\w+)?=>/, '');
  for (const [file, names] of [['packages/machinery/src/metrology.ts', ['sub', 'dot', 'cross']], ['packages/machinery/src/clearance.ts', ['dot', 'sub', 'cross']], ['packages/machinery/src/dimensions.ts', ['sub']]])
    for (const name of names) assert.equal(expression(body(file, name)), expression(body('packages/controls/src/math.ts', name).replace(/\s/g, '')), `${file} ${name}`);
  let n = 0;
  for (let i = 0; i < 100000; i++) {
    const a = [value(), value(), value()], b = i % 4 ? [value(), value(), value()] : new Float32Array([value(), value(), value()]), s = value();
    for (const name of ['add', 'sub', 'dot', 'cross']) {assert.ok(same(vec3[name](a, b), controls[name](a, b)), name); n++;}
    assert.ok(same(vec3.scale(a, s), controls.scale(a, s)) && same(vec3.length(a), controls.length(a)) && same(vec3.normalize(a), controls.normalize(a)) && same(vec3.normalize(b), controls.normalize(b)));
    assert.ok(Object.is(utils.clamp(s, a[0], a[1]), controls.clamp(s, a[0], a[1]))); n += 5;
  }
  return n;
}});

const checked = {}, timings = [];
for (const family of families) {
  if (timing) {if (family.bench) timings.push(...(await family.bench()).map(item => ({family: family.name, ...item})));}
  else checked[family.name] = await family.verify();
}
console.log(JSON.stringify(timing ? {ref, node: process.version, timings} : {ref, node: process.version, outputsIdentical: true, checked}, null, 1));
