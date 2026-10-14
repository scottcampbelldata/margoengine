// CPU checks (mock GPU) for the scene-wide pieces: EnvironmentLighting, Fog, ColorBackground and UltraHDR decoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mockGPU, passes, context} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {parseGLTF} from '../../gltf-pro/dist/index.js';
import {
  ColorBackground, EnvironmentLighting, Fog, IBL_BINDING, FOG_BINDING, srgbColor, parseUltraHDR, applyGainMap, decodeUltraHDR, parseEnvironmentImage,
} from '../dist/index.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8').split('`')[1];
const coreShader = source('../../core/src/shaders.ts'), gltfShader = source('../../gltf-pro/src/shader.ts');
// Core shader as other packages leave it before order -1 (shadows -5, sky -6, clustered -3, tonemap/ssao/dof/post capture).
const variants = {
  core: coreShader,
  shadows: coreShader.replace('let linear=direct*', 'let linear=shadowLit(direct,i.position,i.normal)*'),
  sky: coreShader.replace('frame.radiance.w', 'skyAmbient.rgb'),
  clustered: coreShader.replace(/let linear=([^;]+);/, 'let linear=$1+clusterLighting(i.clip.xy,i.position,n,frame.eye.xyz,i.color,i.material.x,i.material.y);'),
  hdr: coreShader.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);'),
};
const fakeEngine = device => ({backend: 'webgpu', gpu: device, errors: [], removed: [], onError(error) {this.errors.push(error);}, removePlugin(name) {this.removed.push(name);}});
function fakeEnvironment(device) {
  return {device, disposed: false, version: 0, restores: [], specularView: {id: 'specular'}, sampler: {}, brdfLutView: {}, shBuffer: {}, paramsBuffer: {},
    restore(target) {this.restores.push(target); return Promise.resolve();}};
}
const hexFloats = hex => {const b = Buffer.from(hex, 'hex'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));};
const fragment = shader => shader.slice(shader.lastIndexOf('@fragment fn fragment'));

test('EnvironmentLighting patches core meshes only while the environment is live on the frame device', () => {
  const gpu = mockGPU(), environment = fakeEnvironment(gpu.device), lighting = new EnvironmentLighting(environment), engine = fakeEngine(gpu.device);
  lighting.setup(engine);
  assert.equal(environment.restores.length, 0, 'no restore when already on the engine device');
  const run = passes(lighting), frame = context(gpu, {shader: coreShader, format: 'bgra8unorm'});
  frame.begin(0); run(frame.c);
  const patched = frame.c.shader;
  assert.match(patched, /@group\(0\) @binding\(20\) var iblSpecular:texture_cube<f32>;/);
  assert.match(patched, /@group\(0\) @binding\(24\) var<uniform> iblParams:vec4f;/);
  assert.match(fragment(patched), /\*0\.0\+iblShade\(iblSpecular,iblSampler,iblBrdf,iblSh,iblParams,n,v,i\.color,i\.material\.y,i\.material\.x\);/);
  assert.doesNotMatch(fragment(patched), /frame\.radiance\.w/, 'IBL replaces the constant ambient term');
  assert.deepEqual(frame.c.bindings.map(entry => entry.binding), [20, 21, 22, 23, 24]);
  assert.equal(frame.c.bindings[0].resource, environment.specularView);
  assert.equal(IBL_BINDING, 20);
  // Steady frames reuse the patched string and the entry objects.
  const entries = lighting.bindings();
  for (let i = 1; i < 5; i++) {frame.begin(i); run(frame.c); assert.equal(frame.c.shader, patched); assert.equal(frame.c.bindings[0], entries[0]);}
  // Restoring (device null), another device or disposal leave core's shader and bindings untouched.
  for (const device of [null, {}]) {
    environment.device = device; frame.begin(9); run(frame.c);
    assert.equal(frame.c.shader, coreShader); assert.equal(frame.c.bindings.length, 0);
    if (!device) {assert.equal(lighting.shader(gltfShader, 2), gltfShader); assert.deepEqual(lighting.bindings(), []);}
  }
  // Device restore: new version, new views, new entries.
  environment.device = gpu.device; environment.version++; environment.specularView = {id: 'restored'};
  frame.begin(10); run(frame.c); assert.equal(frame.c.bindings[0].resource, environment.specularView);
  const other = {}; lighting.onDeviceRestored(fakeEngine(other)); assert.equal(environment.restores.at(-1), other);
  lighting.dispose(); assert.deepEqual(engine.removed, ['environment:lighting']);
  frame.begin(11); run(frame.c); assert.equal(frame.c.shader, coreShader); assert.equal(frame.c.bindings.length, 0);
  assert.throws(() => new EnvironmentLighting(environment).setup({backend: 'webgl2'}), /WebGPU/);
});

test('EnvironmentLighting and Fog compose with every known core shader variant and reject unknown shaders', () => {
  const gpu = mockGPU(), engine = fakeEngine(gpu.device), lighting = new EnvironmentLighting(fakeEnvironment(gpu.device)), fog = new Fog({color: '#808080'});
  lighting.setup(engine); fog.setup(engine);
  for (const [name, shader] of Object.entries(variants)) {
    const lit = lighting.shader(shader, 0), both = fog.shader(lit, 0);
    assert.match(fragment(lit), /\+iblShade\(/, name);
    assert.match(both, /@group\(0\) @binding\(25\) var<uniform> margoFog:MargoFog;/, name);
    if (name === 'hdr') assert.match(fragment(both), /return vec4f\(mix\(linear,margoFog\.color\.rgb,fogAmount\(i\.position,frame\.eye\.xyz\)\),1\);/);
    else assert.match(fragment(both), /let mapped=mix\(linear\/\(1\.0\+linear\),margoFog\.color\.rgb,fogAmount\(i\.position,frame\.eye\.xyz\)\);/, name);
    if (name === 'sky') assert.match(fragment(lit), /skyAmbient\.rgb\+iblShade/, 'sky ambient stays and IBL adds');
    if (name === 'shadows') assert.match(fragment(lit), /shadowLit\(direct,i\.position,i\.normal\)/);
    assert.equal(fog.shader(lit, 0), both, 'cached');
  }
  assert.throws(() => lighting.shader('@fragment fn custom() {}', 0), /standard core or glTF-pro PBR shader/);
  assert.throws(() => fog.shader('@fragment fn custom() {}', 0), /standard core or glTF-pro PBR shader/);
  lighting.dispose(); fog.dispose();
});

test('Fog validates options, uploads only when changed and rebuilds its uniform on device restore', () => {
  assert.throws(() => new Fog({near: -1}), RangeError);
  assert.throws(() => new Fog({density: NaN}), RangeError);
  assert.throws(() => new Fog({color: '#12'}), TypeError);
  assert.throws(() => new Fog().setup({backend: 'webgpu', gpu: null}), /WebGPU/);
  const gpu = mockGPU(), engine = fakeEngine(gpu.device), fog = new Fog({color: [1, 0.5, 0], near: 2, far: 20, heightFalloff: 0.5, height: 3});
  assert.deepEqual(fog.bindings(), [], 'not ready before setup');
  assert.equal(fog.shader(coreShader, 0), coreShader);
  fog.setup(engine);
  const run = passes(fog), frame = context(gpu, {shader: coreShader, format: 'bgra8unorm'});
  const log = gpu.record(() => {for (let i = 0; i < 3; i++) {frame.begin(i); run(frame.c);}});
  const writes = log.filter(entry => entry[0] === 'writeBuffer');
  assert.equal(writes.length, 1, 'one upload for three frames');
  const values = hexFloats(writes[0][3]);
  assert.deepEqual([...values].map(v => +v.toFixed(5)), [1, 0.21404, 0, 3, 2, 20, 0, 0.5]);
  assert.deepEqual(frame.c.bindings.map(entry => entry.binding), [FOG_BINDING]);
  fog.density = 0.05; fog.color = '#000';
  const after = gpu.record(() => {frame.begin(3); run(frame.c);}).filter(entry => entry[0] === 'writeBuffer');
  assert.equal(after.length, 1);
  assert.equal(fog.color, '#000');
  // Device restore: old uniform destroyed, new one on the new device; frames on the old device skip patching.
  const old = frame.c.bindings[0].resource.buffer, next = mockGPU();
  fog.onDeviceRestored(fakeEngine(next.device));
  assert.equal(old.destroyed, true);
  frame.begin(4); run(frame.c); assert.equal(frame.c.shader, coreShader); assert.equal(frame.c.bindings.length, 0);
  const restored = context(next, {shader: coreShader, format: 'bgra8unorm'}); restored.begin(0); passes(fog)(restored.c);
  assert.notEqual(restored.c.bindings[0].resource.buffer, old);
  const buffer = restored.c.bindings[0].resource.buffer;
  fog.dispose(); assert.equal(buffer.destroyed, true); assert.deepEqual(fog.bindings(), []);
});

async function model(materials) {
  const harness = optionalGPU(), device = harness.engine.gpu, store = await TransformStore.create(16);
  const renderer = {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const fixture = animatedTriangle(), primitive = fixture.doc.meshes[0].primitives[0];
  fixture.doc.materials = materials; fixture.doc.extensionsUsed = ['KHR_materials_clearcoat'];
  fixture.doc.meshes = materials.map((_, material) => ({primitives: [{...primitive, material}]}));
  fixture.doc.nodes = materials.map((_, mesh) => ({mesh, translation: [0, 0, -mesh]}));
  delete fixture.doc.skins; delete fixture.doc.animations;
  const loaded = parseGLTF(engine, fixture.doc, fixture.buffers);
  engine.camera.update(128 / 96, true); store.tick(false);
  return {engine, model: loaded, harness, context: {...harness.context, camera: engine.camera}};
}

test('glTF-pro models: applyTo lights and fogs opaque and blended primitives in the real PBR shader, and removal restores it', async () => {
  const {engine, model: loaded, harness, context: c} = await model([{alphaMode: 'OPAQUE'}, {alphaMode: 'BLEND'}, {extensions: {KHR_materials_clearcoat: {clearcoatFactor: 1}}}]);
  try {
    const lighting = new EnvironmentLighting(fakeEnvironment(engine.gpu)), fog = new Fog({color: '#bcd', density: 0.1});
    fog.setup(engine);
    const draw = () => {const start = harness.pipelines.length, groups = harness.groups.length; loaded.draw(c, 'beauty', {}, {}); return {pipelines: harness.pipelines.slice(start), groups: harness.groups.slice(groups)};};
    const plain = draw();
    assert.equal(plain.pipelines.length, 3);
    const removeLighting = lighting.applyTo(loaded), removeFog = fog.applyTo(loaded);
    assert.equal(lighting.applyTo(loaded), removeLighting, 'applying twice reuses the registration');
    const lit = draw();
    assert.equal(lit.pipelines.length, 3);
    for (const pipeline of lit.pipelines) {
      const code = pipeline.vertex.module.code;
      assert.match(code, /@group\(2\) @binding\(20\) var iblSpecular/);
      assert.match(code, /fn ambient\(s:Surface\)->vec3f \{return vec3f\(0\);\}/);
      assert.match(code, /\+s\.emissive\+iblShade\(iblSpecular,iblSampler,iblBrdf,iblSh,iblParams,s\.n,v,s\.base\.rgb,s\.metal,s\.roughness\)\*s\.occlusion;/);
      assert.match(code, /color=mix\(select\(color,aces\(max\(color,vec3f\(0\)\)\/0\.6\),f\.settings\.w<0\.5\),margoFog\.color\.rgb,fogAmount\(i\.position,f\.eye\.xyz\)\);if\(f\.settings\.w<0\.5\) \{/);
    }
    assert.ok(lit.pipelines.some(pipeline => pipeline.fragment.targets[0].blend), 'the blended primitive is fogged too');
    assert.equal(lit.pipelines.filter(pipeline => /fn layers\(/.test(pipeline.vertex.module.code)).length, 1, 'the physical (clearcoat) variant is patched too');
    const group = lit.groups.find(descriptor => descriptor.entries.some(entry => entry.binding === 20));
    assert.deepEqual(group.entries.map(entry => entry.binding), [20, 21, 22, 23, 24, 25]);
    // Steady frames: no new pipelines or bind groups.
    const steady = draw(); assert.equal(steady.pipelines.length, 0); assert.equal(steady.groups.length, 0);
    removeFog(); lighting.dispose();
    const back = draw();
    assert.equal(back.pipelines.length, 0, 'the unpatched pipelines are reused');
    fog.dispose();
  } finally {engine.dispose();}
});

test('ColorBackground fills only cleared depth with exact sRGB on the canvas and linear values on HDR targets', () => {
  assert.throws(() => new ColorBackground({order: 0}), RangeError);
  assert.throws(() => new ColorBackground({color: 'red'}), TypeError);
  assert.throws(() => new ColorBackground().setup({backend: 'webgl2'}), /WebGPU/);
  assert.deepEqual(srgbColor('#ff8000'), [1, 128 / 255, 0]);
  assert.deepEqual(srgbColor(0x00ff00), [0, 1, 0]);
  assert.deepEqual(srgbColor('#fff'), [1, 1, 1]);
  const gpu = mockGPU(), background = new ColorBackground({color: '#336699'}), run = passes(background);
  assert.equal(background.order, 0.5);
  const frame = context(gpu, {format: 'bgra8unorm', samples: 4});
  const floats = entry => [...hexFloats(entry[3])].map(v => +v.toFixed(5));
  const first = gpu.record(() => {frame.begin(0); run(frame.c);});
  const pipeline = first.find(entry => entry[0] === 'renderPipeline')[2];
  assert.deepEqual(pipeline.depthStencil, {depthCompare: 'greater-equal', depthWriteEnabled: false, format: 'depth24plus-stencil8'});
  assert.equal(pipeline.multisample.count, 4);
  assert.deepEqual(floats(first.find(entry => entry[0] === 'writeBuffer')), [0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1]);
  const begin = first.find(entry => entry[0] === 'beginRenderPass')[1];
  assert.equal(begin.colorAttachments[0].loadOp, 'load');
  assert.equal(begin.depthStencilAttachment.depthReadOnly, true); assert.equal(begin.depthStencilAttachment.stencilReadOnly, true);
  assert.ok(first.some(entry => entry[0] === 'pass.draw' && entry[1] === 3));
  // Steady frames and resizes create nothing.
  frame.state.width = 640;
  const steady = gpu.record(() => {for (let i = 1; i < 4; i++) {frame.begin(i); run(frame.c);}}).filter(entry => ['buffer', 'renderPipeline', 'group', 'module'].includes(entry[0]));
  assert.deepEqual(steady, []);
  // HDR target: linear values and a gradient.
  background.bottom = [1, 1, 1]; frame.state.format = 'rgba16float';
  const hdr = gpu.record(() => {frame.begin(5); run(frame.c);});
  assert.ok(hdr.some(entry => entry[0] === 'renderPipeline'), 'new target format, new pipeline');
  assert.deepEqual(floats(hdr.find(entry => entry[0] === 'writeBuffer')), [0.03310, 0.13287, 0.31855, 1, 1, 1, 1, 1]);
  assert.deepEqual(background.bottom, [1, 1, 1]); background.bottom = undefined; assert.equal(background.bottom, undefined);
  // Device restore and dispose release the uniform.
  const uniform = first.find(entry => entry[0] === 'buffer')[1];
  background.onDeviceRestored();
  const restored = gpu.record(() => {frame.begin(6); run(frame.c);});
  assert.ok(restored.includes(restored.find(entry => entry[0] === 'buffer')));
  assert.ok(gpu.record(() => background.dispose()).some(entry => entry[0] === 'destroy'));
  assert.notEqual(uniform, undefined);
  assert.deepEqual(gpu.record(() => {frame.begin(7); run(frame.c);}).filter(entry => entry[0] === 'beginRenderPass'), [], 'disposed backgrounds draw nothing');
});

// ------------------------------------------------------------------ UltraHDR

const segment = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
const ascii = text => [...new TextEncoder().encode(text)];
const xmp = body => segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0' + body));
// A JPEG-shaped stream: SOI, APP segments, SOS with entropy bytes (stuffed 0xFF00 and a restart marker), EOI.
const jpeg = (id, ...apps) => [0xff, 0xd8, ...apps.flat(), ...segment(0xdb, [0, id]), ...segment(0xda, [1, 2, 3]), id, 0xff, 0x00, 7, 0xff, 0xd3, 9, 0xff, 0xd9];
const gainXmp = '<x:xmpmeta><rdf:Description hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="2" hdrgm:Gamma="1" hdrgm:OffsetSDR="0" hdrgm:OffsetHDR="0" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2"/></x:xmpmeta>';
const file = (gain = gainXmp) => new Uint8Array([...jpeg(1, xmp('<rdf:Description hdrgm:Version="1.0"/>'), segment(0xe2, ascii('MPF\0'))), 0, 0, ...jpeg(2, xmp(gain))]);

test('UltraHDR: splits primary and gain-map JPEGs and reads hdrgm metadata in attribute and element form', () => {
  const bytes = file(), parts = parseUltraHDR(bytes);
  assert.equal(parts.primary[0], 0xff); assert.equal(parts.primary.at(-1), 0xd9);
  assert.equal(parts.gainMap.byteOffset - parts.primary.byteOffset, parts.primary.length + 2);
  assert.equal(parts.gainMap.at(-1), 0xd9); assert.equal(parts.gainMap.byteOffset + parts.gainMap.length, bytes.length);
  assert.deepEqual(parts.metadata, {gainMapMin: [0, 0, 0], gainMapMax: [2, 2, 2], gamma: [1, 1, 1], offsetSdr: [0, 0, 0], offsetHdr: [0, 0, 0], hdrCapacityMin: 0, hdrCapacityMax: 2});
  const element = parseUltraHDR(file('<rdf:Description hdrgm:HDRCapacityMax="3"><hdrgm:GainMapMax><rdf:Seq><rdf:li>1</rdf:li><rdf:li>2.5</rdf:li><rdf:li>3e0</rdf:li></rdf:Seq></hdrgm:GainMapMax></rdf:Description>')).metadata;
  assert.deepEqual(element.gainMapMax, [1, 2.5, 3]); assert.deepEqual(element.offsetSdr, [1 / 64, 1 / 64, 1 / 64]); assert.deepEqual(element.gamma, [1, 1, 1]);
  assert.throws(() => parseUltraHDR(new Uint8Array(jpeg(1))), /no gain-map image/);
  assert.throws(() => parseUltraHDR(file('<x hdrgm:Version="1.0"/>')), /no hdrgm gain-map metadata/);
  assert.throws(() => parseUltraHDR(file(gainXmp.replace('hdrgm:HDRCapacityMax="2"', ''))), /HDRCapacityMax/);
  assert.throws(() => parseUltraHDR(file(gainXmp.replace('/>', ' hdrgm:BaseRenditionIsHDR="True"/>'))), /HDR base rendition/);
  assert.throws(() => parseUltraHDR(bytes.subarray(0, 30)), /Truncated|Corrupt/);
  assert.throws(() => parseUltraHDR(new Uint8Array([1, 2, 3])), /Invalid JPEG/);
  assert.throws(() => parseEnvironmentImage(bytes), /decodeUltraHDR/);
  for (let i = 0; i < 200; i++) {const copy = bytes.slice(); copy[(i * 7919) % copy.length] ^= 0x5a; try {parseUltraHDR(copy);} catch (error) {assert.ok(error instanceof Error);}}
});

test('UltraHDR: gain-map math matches the hdrgm formula, upsamples the gain map and honours weight', async () => {
  const meta = {gainMapMin: [0, 0, 0], gainMapMax: [2, 2, 2], gamma: [1, 1, 1], offsetSdr: [0, 0, 0], offsetHdr: [0, 0, 0], hdrCapacityMin: 0, hdrCapacityMax: 2};
  const sdr = {width: 2, height: 1, data: new Uint8Array([255, 128, 0, 255, 255, 255, 255, 255])};
  const full = applyGainMap(sdr, {width: 2, height: 1, data: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255])}, meta);
  assert.deepEqual([...full.data].map(v => +v.toFixed(4)), [4, +(4 * ((128 / 255 + 0.055) / 1.055) ** 2.4).toFixed(4), 0, 1, 1, 1, 1, 1]);
  assert.deepEqual([...applyGainMap(sdr, {width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255])}, meta, 0).data].slice(4, 7), [1, 1, 1], 'weight 0 is the SDR image');
  // A 1x1 gain map of value 128 upsamples to every pixel: boost 2^(2 * 128/255).
  const half = applyGainMap({width: 3, height: 2, data: new Uint8Array(24).fill(255)}, {width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255])}, {...meta, gamma: [2, 2, 2], offsetSdr: [0.5, 0.5, 0.5], offsetHdr: [0.25, 0.25, 0.25]});
  const expected = 1.5 * 2 ** (2 * Math.sqrt(128 / 255)) - 0.25;
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(half.data[i * 4] - expected) < 1e-3 * expected, `${half.data[i * 4]} vs ${expected}`);
  assert.throws(() => applyGainMap(sdr, {width: 1, height: 1, data: new Uint8Array(3)}, meta), TypeError);
  assert.throws(() => applyGainMap(sdr, sdr, meta, 2), RangeError);
  // decodeUltraHDR wires the parts to the injected decoder.
  const seen = [];
  const image = await decodeUltraHDR(file(), {decode: bytes => {const gain = bytes.byteOffset > 0; seen.push(gain ? 'gain' : 'primary'); return gain ? {width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255])} : sdr;}});
  assert.deepEqual(seen.sort(), ['gain', 'primary']);
  assert.equal(image.width, 2); assert.equal(image.data[0], 4);
});
