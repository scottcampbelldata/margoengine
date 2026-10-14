import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {GLTFAsset, PBRModel} from '../../gltf-pro/dist/index.js';
const parseGLTF = (engine, doc, buffers = []) => new PBRModel(engine, new GLTFAsset(doc, buffers));
import {Animation} from '../dist/index.js';
import {bakeVAT, vatTexel, VATCrowd, VAT_STRIDE, VAT_WIDTH} from '../dist/vat.js';
import {mockGPU, passes, context} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {skinnedStrip, bent} from './fixture.js';

const headless = async () => new Engine({width: 64, height: 64, clientWidth: 64, clientHeight: 64}, await TransformStore.create(256), {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}});
const read = (vat, row, vertex, k) => {const [x, y] = vatTexel(row, vertex, k, vat.vertexCount, vat.width), o = (y * vat.width + x) * 4; return [...vat.texels.subarray(o, o + 3)];};
const floats = hex => {const b = Buffer.from(hex, 'hex'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));};
const near = (a, b, label, eps = 1e-5) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${label}: ${a} vs ${b}`));

test('vatTexel wraps rows of (position, normal) pairs at the texture width', () => {
  assert.deepEqual(vatTexel(0, 0, 0, 10), [0, 0]); assert.deepEqual(vatTexel(0, 9, 1, 10), [19, 0]); assert.deepEqual(vatTexel(3, 4, 1, 10), [69, 0]);
  assert.deepEqual(vatTexel(0, 1024, 0, 5000), [0, 1]); assert.deepEqual(vatTexel(2, 7, 1, 1000, 64), [(4015) % 64, Math.floor(4015 / 64)]);
});

test('bakeVAT samples skinning on the CPU into rows that match the analytic pose, loops back to row 0 and restores the animation', async () => {
  const engine = await headless(), {doc, buffers, positions} = skinnedStrip({extraClip: true});
  const model = parseGLTF(engine, doc, buffers), animation = new Animation(model);
  animation.play('lift').seek(0.5); animation.playing = false;
  model.root.setPosition([5, 0, 0]).setScale([2, 2, 2]); // root transforms are not baked: VAT positions are in the root's space
  try {
    const vat = bakeVAT(animation, {fps: 8, clips: ['bend', 1]}), n = positions.length / 3;
    assert.equal(vat.vertexCount, n); assert.equal(vat.width, VAT_WIDTH);
    assert.deepEqual(vat.clips, [{name: 'bend', start: 0, frames: 8, duration: 1, loop: true}, {name: 'lift', start: 9, frames: 16, duration: 2, loop: true}]);
    assert.equal(vat.rows, 9 + 17); assert.equal(vat.texels.length % (VAT_WIDTH * 4), 0); assert.ok(vat.texels.length >= vat.rows * n * 8);
    for (let r = 0; r < 8; r++) for (let v = 0; v < n; v++) {
      near(read(vat, r, v, 0), bent(positions[v * 3], positions[v * 3 + 1], r / 8), `row ${r} vertex ${v}`);
      near(read(vat, r, v, 1), [0, 0, 1], 'normals stay +Z under a Z rotation');
    }
    for (let v = 0; v < n; v++) near(read(vat, 8, v, 0), read(vat, 0, v, 0), 'a looping clip ends on its first pose');
    // lift moves joint 0 (and its child) up by t/2; the skinned strip follows.
    for (let v = 0; v < n; v++) near(read(vat, 9 + 8, v, 0), [positions[v * 3], positions[v * 3 + 1] + 0.5, 0], 'lift at 1 s');
    assert.deepEqual([...vat.uvs.subarray(0, 4)], [0, 1, 0, 0], 'UVs flip to three.js orientation (v up)');
    assert.deepEqual([vat.indices.length, vat.indices[0], vat.indices[1]], [24, 0, 2]);
    assert.deepEqual([animation.clip, animation.time, animation.playing], [1, 0.5, false], 'clip, time and playing restored');
    assert.throws(() => bakeVAT(animation, {clips: ['missing']}), RangeError); assert.throws(() => bakeVAT(animation, {fps: 0}), RangeError);
  } finally {model.dispose(); engine.dispose();}
});

test('bakeVAT bakes the RobotExpressive clips (skin + morph) to finite rows', async () => {
  const engine = await headless();
  const bytes = await readFile(new URL('../../../examples/assets/robot-expressive.glb', import.meta.url));
  // GLB: JSON chunk then BIN chunk.
  const json = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + json).toString()), bin = bytes.subarray(28 + json, 28 + json + bytes.readUInt32LE(20 + json));
  const model = new PBRModel(engine, new GLTFAsset(doc, [], bin));
  try {
    const animation = new Animation(model), vat = bakeVAT(animation, {fps: 15, clips: ['Walking', 'Running']});
    assert.equal(vat.vertexCount, model.primitives.reduce((n, p) => n + p.vertices.length / 20, 0));
    assert.ok(vat.clips.every(c => c.loop && c.frames > 5));
    for (const c of vat.clips) for (let v = 0; v < vat.vertexCount; v += 97) near(read(vat, c.start + c.frames, v, 0), read(vat, c.start, v, 0), 'Walking/Running loop', 1e-4);
    const moved = [0, 1, 2].map(k => Math.abs(read(vat, 3, 500, 0)[k] - read(vat, 0, 500, 0)[k])).some(d => d > 1e-3);
    assert.ok(moved, 'the walk moves vertices');
  } finally {model.dispose(); engine.dispose();}
});

test('VATCrowd draws every instance in one indexed call and uploads instance data only when it changes', async () => {
  const engine = await headless(), {doc, buffers} = skinnedStrip(), model = parseGLTF(engine, doc, buffers), vat = bakeVAT(new Animation(model), {fps: 4});
  model.dispose(); engine.dispose();
  const gpu = mockGPU(), crowd = new VATCrowd(vat, {color: [1, 0.5, 0.25, 1], roughness: 0.3}), host = {lighting: {direction: new Float32Array([0, 1, 0, 3]), radiance: new Float32Array([1, 1, 1, 0.2])}, stats: {visible: 0, drawCalls: 0}};
  crowd.setup(host);
  for (let i = 0; i < 1000; i++) crowd.add({matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, i,0,0,1], offset: i * 0.01, speed: 1 + (i % 3) * 0.1, uvTransform: {offset: [(i % 4) / 4, 0], scale: [0.25, 1]}});
  assert.equal(crowd.count, 1000);
  assert.throws(() => crowd.add({clip: 1}), RangeError); assert.throws(() => crowd.set(0, {matrix: [0]}), RangeError); assert.equal(crowd.count, 1000, 'a rejected add leaves the count');
  const run = passes(crowd), view = context(gpu, {samples: 4});
  const frame = i => {view.begin(i); crowd.onPreUpdate(1 / 60); run(view.c); view.end();};
  const first = gpu.record(() => frame(0)), second = gpu.record(() => frame(1));
  const draws = log => log.filter(e => e[0] === 'pass.drawIndexed'), writes = (log, size) => log.filter(e => e[0] === 'writeBuffer' && e[3].length === size * 2);
  assert.deepEqual(draws(first).map(e => e.slice(1, 3)), [[24, 1000]]); assert.deepEqual(draws(second).map(e => e.slice(1, 3)), [[24, 1000]]);
  assert.equal(writes(first, 1000 * VAT_STRIDE * 4).length, 1, 'instances upload once'); assert.equal(writes(second, 1000 * VAT_STRIDE * 4).length, 0, 'and not again while unchanged');
  assert.equal(second.filter(e => e[0] === 'renderPipeline' || e[0] === 'group' || e[0] === 'texture').length, 0, 'steady state creates nothing');
  const instance = floats(writes(first, 1000 * VAT_STRIDE * 4)[0][3]).subarray(5 * VAT_STRIDE, 6 * VAT_STRIDE);
  assert.deepEqual([...instance.subarray(12, 24)].map(v => +v.toFixed(5)), [5, 0, 0, 1, 0, 0.05, 1.2, 0, 0.25, 0, 0.25, 1]);
  const uniform = floats(writes(second, 160)[0][3]);
  assert.deepEqual([uniform[28], uniform[29], uniform[30], uniform[32].toFixed(4), uniform[34], uniform[36], uniform[37], uniform[38]], [1, 0.5, 0.25, (2 / 60).toFixed(4), Math.fround(0.3), 10, VAT_WIDTH, 1]);
  const clips = gpu.record(() => {crowd.onDeviceRestored(); frame(2);}).filter(e => e[0] === 'writeBuffer' && e[3].length === 32);
  assert.deepEqual([...floats(clips[0][3])], [0, 4, 1, 1], 'clip table: start, frames, duration, loop');
  crowd.set(3, {clip: 0}); assert.equal(writes(gpu.record(() => frame(3)), 1000 * VAT_STRIDE * 4).length, 1, 'a change re-uploads');
  assert.equal(host.stats.drawCalls, 4); crowd.dispose();
});
