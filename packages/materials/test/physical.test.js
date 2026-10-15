import test from 'node:test';
import assert from 'node:assert/strict';
import {mockGPU, context} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {wgsl} from '../../core/dist/shaders.js';
import {sphereGeometry} from '../../geometry/dist/index.js';
import {parseGLTF} from '../../gltf-pro/dist/index.js';
import {PostStack, Bloom, FXAA} from '../../post/dist/index.js';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';
import {Material, createMesh} from '../dist/index.js';
import {Transmission} from '../dist/transmission.js';
import * as ref from './physical-reference.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
// 2 pi x the integral over mu = cos(theta) in [0, 1] of D(mu) mu: a normalized microfacet distribution projects to 1.
const projected = D => {let s = 0; const n = 200000; for (let i = 0; i < n; i++) {const mu = (i + 0.5) / n; s += D(mu) * mu;} return 2 * Math.PI * s / n;};

test('CPU reference: dielectric F0 from IOR and KHR_materials_specular, Schlick Fresnel', () => {
  for (const f of ref.dielectricF0()) near(f, 0.04);
  assert.deepEqual(ref.dielectricF0(1.5, [1, 1, 1], 0), [0, 0, 0]);
  near(ref.dielectricF0(1.5, [30, 1, 1])[0], 1, 0); near(ref.dielectricF0(2)[0], 1 / 9);
  near(ref.dielectricF0(1)[0], 0, 0);
  near(ref.schlick(0.04, 1), 0.04); near(ref.schlick(0.04, 0), 1);
});

test('CPU reference: GGX and Charlie distributions are normalized; Smith masking is 1 head-on', () => {
  for (const alpha of [0.25, 0.5, 1]) near(projected(mu => ref.ggxD(alpha, mu)), 1, 2e-3);
  for (const alpha of [0.07 ** 2, 0.3, 1]) near(projected(mu => ref.charlieD(alpha, mu)), 1, 2e-3);
  for (const alpha of [0.01, 0.5, 1]) {near(ref.smithG1(alpha, 1), 1); assert.ok(ref.smithG1(alpha, 0.2) <= 1);}
  near(ref.sheenV(1, 1), 0.25);
  assert.deepEqual(ref.clearcoatMix([1, 1, 1], [0, 0, 0], 0, 0.5), [1, 1, 1]);
  near(ref.clearcoatMix([1, 1, 1], [0, 0, 0], 1, 1)[0], 0.96);
});

test('CPU reference: refraction obeys Snell, volume follows Beer-Lambert, blur and transmitted share', () => {
  const n = [0, 0, 1], v = ref.normalize([1, 0, 1]), t = ref.refract(ref.scale(v, -1), n, 1 / 1.5);
  near(Math.hypot(t[0], t[1]), Math.SQRT1_2 / 1.5); assert.ok(t[2] < 0);
  assert.deepEqual(ref.refract([0, 0, -1], n, 1 / 1.5).map(x => +x.toFixed(12)), [0, 0, -1]);
  assert.deepEqual(ref.exitPoint([1, 2, 3], v, n, 1.5, 0), [1, 2, 3], 'thin-walled');
  const straight = ref.exitPoint([0, 0, 0], v, n, 1, 2); for (let i = 0; i < 3; i++) near(straight[i], -2 * v[i], 1e-12);
  assert.deepEqual(ref.volumeTransmittance([0.5, 0.25, 1], 2, 2), [0.5, 0.25, 1]);
  assert.deepEqual(ref.volumeTransmittance([0.5, 0, 1], 2, 0), [1, 1, 1]); assert.deepEqual(ref.volumeTransmittance([0.5, 0.5, 0.5], Infinity, 3), [1, 1, 1]);
  near(ref.volumeTransmittance([0.5, 1, 1], 1, 3)[0], 0.125);
  assert.equal(ref.transmissionLod(1024, 0.5, 1), 0); near(ref.transmissionLod(1024, 0.5, 1.5), 5); assert.equal(ref.transmissionLod(1024, 0, 1.5), 0);
  // Energy: transmitted + reflected never exceeds the incoming light.
  for (const cos of [0, 0.3, 1]) {
    const v2 = [Math.sqrt(1 - cos * cos), 0, cos], out = ref.transmitted({n, v: v2, base: [1, 1, 1], f0: [0.04, 0.04, 0.04], behind: [1, 1, 1]});
    near(out[0] + ref.schlick(0.04, cos), 1, 1e-12);
  }
  assert.deepEqual(ref.transmitted({n, v: n, base: [1, 1, 1], f0: [0.04, 0.04, 0.04], metal: 1, behind: [1, 1, 1]}), [0, 0, 0], 'metals do not transmit');
});

test('Material physical options: live gltf-pro arrays, validation, fixed shape', () => {
  const plain = new Material({color: [0.5, 0.5, 0.5]});
  assert.equal(plain.physical, undefined); assert.equal(plain.ext, undefined); assert.deepEqual(plain.extensions, []); assert.equal(plain.transmissive, false); assert.equal(plain.tint, undefined);
  assert.throws(() => {plain.clearcoat = 1;}, /physical option at construction/);
  const coat = new Material({color: [0.6, 0.05, 0.05], clearcoat: 1, clearcoatRoughness: 0.1, sheenColor: '#ffffff', sheenRoughness: 0.5, specularIntensity: 0.5, specularColor: [1, 0.5, 0.25], ior: 1.8});
  assert.deepEqual(coat.physical, [1, 0.1, 1, 0, 1, 0.5, 0.25, 0.5, 1, 1, 1, 0.5]); assert.deepEqual(coat.ext, [0, 1.8, 0, 0]);
  assert.deepEqual(coat.extensions, ['clearcoat', 'sheen', 'specular', 'ior']); assert.equal(coat.volume, undefined);
  coat.clearcoat = 0.25; coat.sheenColor = [0, 0.5, 0]; coat.ior = 1.33; assert.deepEqual([coat.physical[0], ...coat.physical.slice(8, 11), coat.ext[1]], [0.25, 0, 0.5, 0, 1.33]);
  assert.throws(() => {coat.transmission = 0.5;}, /transmission at construction/); assert.throws(() => {coat.thickness = 1;}, /transmission at construction/);
  assert.throws(() => {coat.ior = 0.5;}, RangeError); assert.throws(() => {coat.clearcoat = 2;}, RangeError);
  assert.throws(() => new Material({shading: 'basic', clearcoat: 1}), /standard shading/);
  const glass = new Material({color: [0.9, 1, 0.8], transmission: 1, thickness: 0.5, attenuationColor: [0.5, 1, 0.25], attenuationDistance: 2});
  assert.equal(glass.transmissive, true); assert.deepEqual(glass.extensions, ['transmission', 'volume']);
  assert.deepEqual(glass.volume, [0.5, 0.5 ** 0.5, 1, 0.25 ** 0.5]);
  // The tinted-blend constant matches gltf-pro's: color x transmission x attenuationColor^(thickness / distance).
  glass.transmission = 0.5; glass.attenuationDistance = Infinity; glass.thickness = 2;
  assert.deepEqual(glass.tint.map(x => +x.toFixed(9)), [0.45, 0.5, 0.4]); assert.deepEqual(glass.volume, [2, 1, 1, 1]);
  glass.attenuationDistance = 1; glass.attenuationColor = [0.5, 0.5, 0.5]; near(glass.tint[0], 0.9 * 0.5 * 0.25);
  assert.throws(() => {glass.thickness = Infinity;}, RangeError); assert.throws(() => {glass.attenuationDistance = 0;}, RangeError);
});

async function scene({samples = 4, post = 'hdr'} = {}) {
  const gpu = mockGPU(), store = await TransformStore.create(64), renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 6], target: [0, 0, 0]}, null);
  engine.camera.update(4 / 3, true);
  if (post) PostStack.attach(engine, [post === 'hdr' ? new Bloom() : new FXAA()]);
  const view = context(gpu, {samples, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl, width: 64, height: 32});
  const frame = n => gpu.record(() => {store.tick(false); view.begin(n); engine.frameGraph.execute(view.c);});
  return {gpu, engine, view, frame, id: value => gpu.snap(value)};
}
const of = (log, name) => log.filter(e => e[0] === name);
const passes = log => of(log, 'beginRenderPass').map(e => e[1]);
const textures = code => code.match(/var\s*\w+\s*:\s*texture_(?!storage)/g).length;
// gltf-pro uniform rows: physical factors at float 208, ext (unlit, ior) at 100.
const floats = hex => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);

test('physical materials meshes draw gltf-pro\'s factor-only physical variant: 5 + 5 textures, live factors', async () => {
  const {engine, frame} = await scene({post: null}), m = new Material({clearcoat: 1, sheenColor: [0.2, 0.3, 0.4], ior: 1.4});
  const mesh = createMesh(engine, sphereGeometry(1, 8, 4), m), g = mesh.primitives[0].material;
  assert.equal(g.physical, m.physical); assert.equal(g.ext, m.ext); assert.equal(g.maps.length, 5); assert.equal(g.tint, undefined);
  assert.deepEqual(Object.keys(mesh.asset.doc.materials[0].extensions), ['KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_ior']);
  let log = frame(0); const code = of(log, 'module').map(e => e[2].code).find(c => c.includes('fn layers('));
  assert.ok(code, 'physical layers'); assert.equal(textures(code), 10); assert.doesNotMatch(code, /clearcoatMap|Map,\w+Sampler,uv\(i,\d/);
  m.clearcoat = 0.5; log = frame(1); const v = floats(of(log, 'writeBuffer').find(e => e[3].length === 1760)[3]);
  assert.deepEqual([v[101], v[208], v[216], v[219]].map(x => +x.toFixed(6)), [1.4, 0.5, 0.2, 0]);
  // Plain materials keep their doc and shader: no extensions, standard variant.
  const plain = createMesh(engine, sphereGeometry(1, 8, 4), new Material());
  assert.equal('extensions' in plain.asset.doc.materials[0], false); assert.equal(plain.primitives[0].material.physical, undefined);
});

for (const samples of [4, 1]) test(`Transmission refracts materials glass and glTF transmission through the scene copy (${samples}x)`, async () => {
  const {engine, view, frame, id} = await scene({samples});
  const glass = createMesh(engine, sphereGeometry(1, 8, 4), new Material({color: [0.9, 1, 0.9], transmission: 1, thickness: 0.4, attenuationColor: [0.5, 0.5, 1], attenuationDistance: 2, roughness: 0.1}));
  const fixture = animatedTriangle(); delete fixture.doc.skins; delete fixture.doc.animations;
  fixture.doc.materials = [{extensions: {KHR_materials_transmission: {transmissionFactor: 0.8}, KHR_materials_volume: {thicknessFactor: 0.3, attenuationColor: [1, 0.5, 0.5], attenuationDistance: 4}}}];
  fixture.doc.meshes[0].primitives[0].material = 0; fixture.doc.extensionsUsed = ['KHR_materials_transmission', 'KHR_materials_volume'];
  const model = parseGLTF(engine, fixture.doc, fixture.buffers), transmission = Transmission.attach(engine);
  createMesh(engine, sphereGeometry(1, 8, 4), new Material()).root.setPosition([0, 0, -3]);
  assert.throws(() => new Transmission().add(glass), /attach/);
  const tinted = frame(0); assert.equal(passes(tinted).filter(p => p.label?.startsWith('transmission')).length, 0, 'not added: tinted blend');
  transmission.add(glass); transmission.add(model);
  const log = frame(1), list = passes(log), labels = list.map(p => p.label);
  const levels = Math.floor(Math.log2(64)) + 1, copies = labels.filter(l => l === 'transmission:copy').length;
  assert.equal(copies, levels, 'scene copy: level 0 + one reduction per mip'); assert.equal(labels.filter(l => l === 'transmission').length, 1);
  // Into the scene capture the opaque mesh drew into, depth read-only.
  const pass = list.find(p => p.label === 'transmission'), beauty = list.find(p => p.depthStencilAttachment?.depthLoadOp === 'load');
  assert.deepEqual(pass.colorAttachments, [{view: beauty.colorAttachments[0].view, loadOp: 'load', storeOp: 'store'}]); assert.notEqual(beauty.colorAttachments[0].view, id(view.c.color));
  assert.deepEqual(pass.depthStencilAttachment, {view: beauty.depthStencilAttachment.view, depthReadOnly: true, stencilReadOnly: true});
  const copy = of(log, 'texture').map(e => e[2]).find(t => t.label === 'transmission:scene');
  assert.deepEqual([copy.format, copy.mipLevelCount, copy.size], ['rgba16float', levels, [64, 32]]);
  const modules = of(log, 'module').map(e => e[2].code).filter(c => c.includes('fn margoTransmission('));
  assert.equal(modules.length, 2, 'factor-only (materials) and mapped (glTF) physical variants');
  for (const code of modules) {assert.ok(code.includes('color=layers(s,v,l,color+margoTransmission(s,v,i));') && code.includes('var<uniform> margoVolume:vec4f') && code.includes('@binding(124)'));}
  assert.equal(textures(modules.find(c => !c.includes('clearcoatMap'))), 11, 'materials glass: 10 + the scene copy');
  const pipelines = of(log, 'renderPipeline').map(e => e[2]).filter(p => p.fragment?.targets?.[0]?.blend?.color?.dstFactor === 'one-minus-src-alpha' && p.depthStencil);
  assert.equal(pipelines.length, 2); for (const p of pipelines) assert.deepEqual([p.depthStencil.depthWriteEnabled, p.depthStencil.depthCompare, p.multisample.count, p.fragment.entryPoint], [false, 'greater-equal', samples, 'fragment']);
  // Volume rows: [thickness, attenuationColor^(1/distance)] per primitive.
  const sixteen = new Set(of(log, 'buffer').filter(e => e[2].size === 16).map(e => e[1])), volumes = of(log, 'writeBuffer').filter(e => sixteen.has(e[1])).map(e => [...floats(e[3])].map(x => +x.toFixed(6)));
  assert.deepEqual(volumes.sort(), [[0.3, 1, +(0.5 ** 0.25).toFixed(6), +(0.5 ** 0.25).toFixed(6)], [0.4, +(0.5 ** 0.5).toFixed(6), +(0.5 ** 0.5).toFixed(6), 1]].sort());
  assert.ok(of(log, 'group').some(e => e[2].entries.length === 2 && e[2].entries[1].binding === 1), 'group 0 binds the volume');
  assert.equal(of(log, 'pass.drawIndexed').length, 3, 'opaque mesh in the beauty pass; both transmissive ones only in the transmission pass');
  // Steady frames create nothing; hidden glass costs no copy.
  const next = frame(2); for (const name of ['texture', 'renderPipeline', 'group', 'module', 'view', 'buffer']) assert.equal(of(next, name).length, 0, name);
  glass.root.visible = false; model.root.visible = false;
  assert.equal(passes(frame(3)).filter(p => p.label?.startsWith('transmission')).length, 0);
  // Dispose restores the tinted blend (beauty draws them again).
  glass.root.visible = true; transmission.dispose();
  const after = frame(4); assert.equal(passes(after).filter(p => p.label?.startsWith('transmission')).length, 0); assert.equal(of(after, 'pass.setBlendConstant').length, 1);
});

test('Transmission needs an HDR scene capture', async () => {
  for (const post of [null, 'ldr']) {
    const {engine, frame} = await scene({post}), transmission = Transmission.attach(engine);
    transmission.add(createMesh(engine, sphereGeometry(1, 8, 4), new Material({transmission: 1})));
    assert.throws(() => frame(0), /HDR scene capture/);
  }
  assert.throws(() => new Transmission({order: 0}), RangeError);
});
