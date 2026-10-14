import test from 'node:test';
import assert from 'node:assert/strict';
import {mockGPU, context} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {PBRInstances, parseGLTF} from '../dist/index.js';
import {Shadows} from '../../shadows/dist/index.js';
import {Clustered} from '../../clustered/dist/index.js';
import {EnvironmentLighting, Fog} from '../../environment/dist/index.js';
import {Raycaster} from '../../bvh/dist/index.js';
import {instancedGLTF} from '../../../tests/support/instanced-gltf.js';
import {instancedShader} from '../src/instances.ts';
import {pbrShader, physicalShader} from '../src/shader.ts';
import {NodeMaterial, positionLocal, normalLocal, uv, color, mix} from '../../shader/dist/index.js';

const transforms = [{t: [-2, 0, 0]}, {t: [0, 1, -1], r: [0, Math.SQRT1_2, 0, Math.SQRT1_2], s: [1, 2, 1]}, {t: [3, 0, 0], s: [0.5, 0.5, 0.5]}];
async function scene() {
  const gpu = mockGPU(), store = await TransformStore.create(64), renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 6], target: [0, 0, 0]}, null);
  engine.camera.update(4 / 3, true);
  return {gpu, engine, store, view: context(gpu, {samples: 1, format: 'rgba16float', depthFormat: 'depth32float'})};
}
const multiply = (a, b) => Array.from({length: 16}, (_, i) => [0, 1, 2, 3].reduce((s, k) => s + a[k * 4 + i % 4] * b[Math.floor(i / 4) * 4 + k], 0));
const near = (a, b, label) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${label}[${i}]: ${v} != ${b[i]}`));

test('PBRInstances: identity defaults, validated setters, dirty-range uploads, count and mirrored', () => {
  const gpu = mockGPU(), m = new PBRInstances(4);
  assert.equal(m.count, 4); assert.deepEqual([...m.getMatrixAt(2)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); assert.deepEqual([...m.data.slice(16, 20)], [1, 1, 1, 1]);
  assert.deepEqual([...m.data.slice(20, 24)], [1, 1, 0, 0]);
  assert.throws(() => new PBRInstances(0), RangeError); assert.throws(() => m.setMatrixAt(4, m.getMatrixAt(0)), RangeError);
  assert.throws(() => m.setMatrixAt(0, [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), TypeError); assert.throws(() => m.setColorAt(0, [1, -1, 0]), RangeError);
  assert.throws(() => m.setUVTransformAt(0, {rotation: 1}), TypeError); assert.throws(() => (m.count = 5), RangeError);
  const log = gpu.record(() => m.upload(gpu.device)), writes = log.filter(e => e[0] === 'writeBuffer');
  assert.deepEqual(writes.map(w => [w[2], w[3].length / 2]), [[0, 4 * 96]], 'first upload writes every row');
  m.setColorAt(2, [0.5, 0.25, 1]).setUVTransformAt(1, {offset: [0.5, 0], scale: [0.5, 0.5]});
  assert.deepEqual([...m.data.slice(64, 68)], [0.5, 0.25, 1, 1]); assert.deepEqual([...m.data.slice(44, 48)], [0.5, 0.5, 0.5, 0]);
  const again = gpu.record(() => m.upload(gpu.device)).filter(e => e[0] === 'writeBuffer');
  assert.deepEqual(again.map(w => [w[2], w[3].length / 2]), [[96, 2 * 96]], 'only rows 1-2 upload');
  assert.equal(gpu.record(() => m.upload(gpu.device)).filter(e => e[0] === 'writeBuffer').length, 0, 'clean: no upload');
  m.data[0] = 2; m.needsUpdate = true; assert.equal(gpu.record(() => m.upload(gpu.device)).filter(e => e[0] === 'writeBuffer')[0][3].length / 2, 4 * 96);
  assert.equal(m.mirrored, false); m.setMatrixAt(3, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); assert.equal(m.mirrored, true); m.count = 3; assert.equal(m.mirrored, false);
});

test('EXT_mesh_gpu_instancing: TRANSLATION/ROTATION (normalized int16)/SCALE become node-space instance matrices', async () => {
  const {engine, store} = await scene(), {doc, buffers} = instancedGLTF(transforms);
  doc.nodes[0].translation = [0, 0, -1];
  const model = parseGLTF(engine, doc, buffers), inst = model.primitives[0].instances;
  assert.ok(inst instanceof PBRInstances); assert.equal(inst.count, 3);
  // The same transforms as separate nodes give the reference matrices.
  const separate = parseGLTF(engine, ...Object.values(instancedGLTF(transforms, {instanced: false}))); store.tick(false);
  transforms.forEach((_, k) => near(multiply(model.primitives[0].node.matrix, inst.getMatrixAt(k)), multiply([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1], separate.primitives[k].node.matrix), 'instance ' + k));
  near(model.bounds, separate.bounds.map((v, i) => i === 2 || i === 5 ? v - 1 : v), 'bounds');
  const bad = instancedGLTF(transforms); bad.doc.nodes[0].extensions.EXT_mesh_gpu_instancing.attributes.SCALE = bad.doc.meshes[0].primitives[0].attributes.TEXCOORD_0;
  assert.throws(() => parseGLTF(engine, bad.doc, bad.buffers), TypeError);
  model.dispose(); separate.dispose(); engine.dispose();
});

test('instanced primitives draw once with an instance buffer in beauty, ambient and G-buffer passes, lit by every hook', async () => {
  const {gpu, engine, store, view} = await scene(), model = parseGLTF(engine, ...Object.values(instancedGLTF(transforms))); store.tick(false);
  const shadows = new Shadows({resolution: 64}), clustered = new Clustered({grid: [4, 3, 2]}), fog = new Fog({color: '#9ab', density: 0.05});
  const ibl = new EnvironmentLighting({device: gpu.device, disposed: false, version: 0, specularView: {}, sampler: {}, brdfLutView: {}, shBuffer: {}, paramsBuffer: {}, restore: () => Promise.resolve()});
  shadows.setup(engine); clustered.setup(engine); fog.setup(engine); shadows.add(model); clustered.add(model); ibl.applyTo(model); fog.applyTo(model);
  const log = gpu.record(() => {
    view.begin(0); shadows['render'](view.c); // the depth pass alone (the frame pass also patches core's shader)
    for (const mode of ['beauty', 'ambient', 'gbuffer']) model.draw(view.c, mode, view.c.color, view.c.depth);
  });
  const draws = log.filter(e => e[0] === 'pass.drawIndexed');
  assert.deepEqual(draws.map(d => d.slice(1, 3)), [...Array(4).fill([6, 3]), [6, 3], [6, 3], [6, 3]], '4 shadow cascades + 3 passes, each one draw of 3 instances');
  assert.ok(log.some(e => e[0] === 'pass.setVertexBuffer' && e[1] === 1), 'instance buffer bound at slot 1');
  const modules = log.filter(e => e[0] === 'module').map(e => e[2].code), lit = modules.find(code => code.includes('k:Instance') && code.includes('shadowLit(') && code.includes('clusterLighting(') && code.includes('margoAmbient') && code.includes('fogAmount('));
  assert.ok(lit, 'beauty shader is instanced and composes shadows, clustered, IBL and fog');
  assert.ok(modules.some(code => code.includes('mat4x4f(i.m0,i.m1,i.m2,i.m3)')), 'shadow depth shader is instanced');
  const pipelines = log.filter(e => e[0] === 'renderPipeline').map(e => e[2]);
  assert.ok(pipelines.every(p => p.vertex.buffers.length === 2 && p.vertex.buffers[1].stepMode === 'instance'));
  assert.ok(pipelines.filter(p => p.fragment.targets.length).every(p => p.primitive.cullMode === 'back' && p.fragment.constants.margoFaceTest === 0));
  // Nothing to draw at count 0; a mirrored instance turns culling off and the face test on.
  const inst = model.primitives[0].instances; inst.count = 0;
  assert.equal(gpu.record(() => {view.begin(1); model.draw(view.c, 'beauty', view.c.color, view.c.depth);}).filter(e => e[0] === 'pass.drawIndexed').length, 0);
  inst.count = 3; inst.setMatrixAt(0, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mirrored = gpu.record(() => {view.begin(2); model.draw(view.c, 'beauty', view.c.color, view.c.depth);}).find(e => e[0] === 'renderPipeline')[2];
  assert.equal(mirrored.primitive.cullMode, 'none'); assert.equal(mirrored.fragment.constants.margoFaceTest, 1);
  model.dispose(); shadows.dispose(); clustered.dispose(); fog.dispose(); ibl.dispose(); engine.dispose();
});

test('bvh Raycaster reports the instance hit, in its world transform', async () => {
  const {engine, store} = await scene(), model = parseGLTF(engine, ...Object.values(instancedGLTF(transforms))); store.tick(false);
  const ray = new Raycaster([3, 0, 5], [0, 0, -1]), [hit] = ray.intersectObjects(engine, [model]);
  assert.equal(hit.instanceId, 2); assert.equal(hit.mesh, model.primitives[0].node); near(hit.point, [3, 0, 0], 'point');
  const side = new Raycaster([0.2, 1.5, 5], [0, 0, -1]).intersectObjects(engine, [model])[0];
  assert.equal(side, undefined, 'instance 1 is turned edge-on by its rotation');
  const across = new Raycaster([5, 1.5, -1.2], [-1, 0, 0]).intersectObjects(engine, [model]);
  assert.deepEqual(across.map(h => h.instanceId), [1], 'the rotated, stretched instance 1 stands in the YZ plane facing +X'); near(across[0].point, [0, 1.5, -1.2], 'point');
  model.primitives[0].instances.count = 2; assert.equal(ray.intersectObjects(engine, [model]).length, 0, 'undrawn instances are not hit');
  model.dispose(); engine.dispose();
});

test('the instanced vertex patch applies after material and shader-node patches, to both PBR variants', () => {
  const nodes = new NodeMaterial({colorNode: mix(color('#2040ff'), color('#ff8000'), uv().y), positionNode: positionLocal.add(normalLocal.mul(0.05))});
  for (const base of [pbrShader, physicalShader()]) {
    const code = instancedShader(nodes.shader(base, 2));
    assert.match(code, /@vertex fn vertex\(i:Input,k:Instance\)->Out/); assert.match(code, /let p=margoI\*vec4f\(/); assert.ok(!code.includes('f.normalMatrix'), 'normals use the instance cofactor');
    assert.match(code, /color:vec4f, @location\(5\) @interpolate\(flat\) mirror:f32\n\}/); assert.match(code, /let p=margoI\*vec4f\(i\.position\.xyz \+ /, 'the position node is kept');
    assert.equal(instancedShader(nodes.shader(base, 2)), code, 'cached');
  }
  assert.throws(() => instancedShader('fn x(){}'), /instancing patch target missing/);
});