// materialPlugin() on a mock device: its checks, the shader it composes with several plugins, the bindings, live
// uniforms, the shadow and TAA caster record, disposal, a device restore and serialization. plugins-browser.mjs checks
// the rendered pixels on WebGPU and the WebGL2 compatibility layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { shadowDepth } from '../../shadows/src/shader.ts';
import { objectVelocity } from '../../taa/src/shader.ts';
import { displacedDepth } from '../../shared/displacement.js';
import {
  MatcapMaterial,
  NormalMaterial,
  PbrMaterial,
  Texture,
  UnlitMaterial,
  WgslMaterial,
  createMesh,
} from '../dist/index.js';
import { materialPlugin, materialPluginCodec } from '../dist/plugins.js';
import { captureMaterialLibrary, restoreMaterialLibrary } from '../dist/serialization.js';

const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
/** The beauty shader of one triangle of `material` and the mesh, as a mock device receives it. */
async function drawn(material) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  const mesh = createMesh(engine, triangle, material);
  const frame = gpu.record(() => {
    store.tick(false);
    view.begin(0);
    engine.frameGraph.execute(view.c);
  });
  const code = frame.flatMap((e) => (e[0] === 'module' ? [e[2].code] : [])).find((c) => c.includes('fn surface('));
  return { code, mesh, gpu, engine };
}
const wave = (extra = {}) =>
  materialPlugin({
    name: 'wave',
    uniforms: { height: 0.25, tint: [1, 0.5, 0] },
    vertex: 'position += normal * wave.height;',
    surface: 's.base = vec4f(s.base.rgb * wave.tint, s.base.a);',
    ...extra,
  });

test('names, options and uniforms are checked with coded messages before any GPU work', () => {
  const link = /margoengine\.com\/errors#material-plugins/;
  for (const name of ['', '1a', 'a_b', 'f', 'color', 'margoX', 'fn', 'vec3f', 'texture2d', undefined])
    assert.throws(
      () => materialPlugin({ name, surface: 's.n = s.n;' }),
      (e) => e instanceof TypeError && link.test(e.message),
    );
  assert.throws(() => materialPlugin({ name: 'a', fragment: 'x' }), /option 'fragment' is unknown/);
  assert.throws(() => materialPlugin({ name: 'a' }), /has no code/);
  assert.throws(() => materialPlugin({ name: 'a', light: 3 }), /must be WGSL text/);
  assert.throws(() => materialPlugin({ name: 'a', light: 'x', uniforms: { k: [1] } }), TypeError);
  assert.throws(() => materialPlugin({ name: 'a', light: 'x', uniforms: { k: Infinity } }), RangeError);
  assert.throws(() => materialPlugin({ name: 'a', light: 'x', uniforms: { s: 1 } }), /uniform 's' is not usable/);
  assert.throws(
    () => materialPlugin({ name: 'a', light: 'x', declarations: '@group(2) @binding(1) var t:texture_2d<f32>;' }),
    /may not bind resources/,
  );
  const t = () => new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  assert.throws(
    () => materialPlugin({ name: 'a', light: 'x', textures: { a: t(), b: t(), c: t(), d: t(), e: t() } }),
    RangeError,
  );
  assert.throws(() => materialPlugin({ name: 'a', light: 'x', textures: { k: {} } }), /must be a Texture/);
  assert.throws(
    () => materialPlugin({ name: 'a', light: 'x', uniforms: { k: 1 }, textures: { k: t() } }),
    /also a uniform/,
  );
  const p = wave();
  assert.equal(p.name, 'plugin:wave');
  assert.equal(p.uniforms.height, 0.25);
  assert.deepEqual(Array.from(p.uniforms.tint), [1, 0.5, 0]);
  assert.throws(() => (p.uniforms.height = [1, 2]), /has 1 component/);
  assert.throws(() => (p.uniforms.other = 1), TypeError, 'the uniform set is sealed');
  assert.ok(Object.isFrozen(p.code));
});

test('a material without plugins keeps its shader text exactly', async () => {
  const plain = (await drawn(new PbrMaterial())).code,
    after = (await drawn(new PbrMaterial({ features: [] }))).code;
  assert.equal(after, plain);
  assert.doesNotMatch(plain, /margoPlugin/);
});

test('several plugins compose in list order at every point, with their own bindings', async () => {
  const glow = materialPlugin({
    name: 'glow',
    uniforms: { strength: 2 },
    vertex: 'position.z += 0.1;',
    surface: 's.emissive += vec3f(glow.strength);',
    light: 'color += s.base.rgb * glow.strength;',
    output: 'color = min(color, vec3f(1.0));',
  });
  const { code } = await drawn(new PbrMaterial({ features: [wave(), glow] }));
  assert.match(code, /@group\(2\) @binding\(300\) var<uniform> wave:MargoPlugin_wave;/);
  assert.match(code, /@group\(2\) @binding\(316\) var<uniform> glow:MargoPlugin_glow;/);
  assert.match(code, /struct MargoPlugin_wave \{@align\(16\) height:f32, @align\(16\) tint:vec3f\}/);
  assert.equal(code.match(/struct MargoPluginVertex /g).length, 1);
  // The vertex chain: the mesh position and normal through wave, then glow, and every use after it reads the moved ones.
  assert.ok(
    code.includes(
      'var margoPV=MargoPluginVertex(i.position.xyz,i.normal.xyz);margoPV=margoPlugin_wave_vertex(margoPV.position,margoPV.normal);margoPV=margoPlugin_glow_vertex(margoPV.position,margoPV.normal);',
    ),
  );
  assert.match(code, /let p=f\.model\*vec4f\(margoPV\.position,1\);/);
  assert.match(code, /o\.normal=\(f\.normalMatrix\*vec4f\(margoNormal,0\)\)\.xyz;/);
  assert.equal(code.split('i.position.xyz').length, 2, 'only the chain reads the mesh position');
  assert.match(
    code,
    /s=margoPlugin_wave_surface\(i,s\);s=margoPlugin_glow_surface\(i,s\);\s*if\(margoFaceTest&&!facing/,
  );
  assert.match(code, /_=wave;_=glow;/);
  assert.match(code, /var color=[^;]*;color=margoPlugin_glow_light\(i,s,v,color\);/);
  assert.equal(code.match(/var color=/g).length, 1, 'the point functions hold no host colour site');
  assert.match(code, /color=margoPlugin_glow_output\(i,s,v,color\);return vec4f\(color,/);
  assert.ok(
    code.indexOf('margoPlugin_glow_output(i,s,v,color)') > code.indexOf('pbrNeutral(max(color'),
    'output follows tone mapping',
  );
  assert.match(
    code,
    /fn margoPlugin_wave_vertex\(p0:vec3f,n0:vec3f\)->MargoPluginVertex \{var position=p0;var normal=n0;\{\nposition \+= normal \* wave\.height;\n\}/,
  );
  // The order is the list's.
  const swapped = (await drawn(new PbrMaterial({ features: [glow, wave()] }))).code;
  assert.match(swapped, /s=margoPlugin_glow_surface\(i,s\);s=margoPlugin_wave_surface\(i,s\);/);
  assert.match(swapped, /@group\(2\) @binding\(300\) var<uniform> glow:/);
  assert.throws(
    () => glow.shader(code.replace(/fn surface\(/g, 'fn other('), 2, new PbrMaterial({ features: [glow] })),
    (e) => e.code === 'unsupported',
  );
});

test('on a WgslMaterial a plugin surface runs after its shade', async () => {
  const material = new WgslMaterial({
    wgsl: 'fn shade(i: Out, s: Surface) -> Surface { var o = s; o.roughness = 1.0; return o; }',
    features: [wave()],
  });
  const { code } = await drawn(material);
  assert.match(code, /s=shade\(i,s\);\s*s=margoPlugin_wave_surface\(i,s\);/);
  assert.match(code, /vec4f\(margoPV\.position,1\)/);
});

test('the output point runs on shadings that return before the lit code', async () => {
  // An unlit, normal or matcap material returned early, so its output plugins were silently never called.
  for (const Class of [UnlitMaterial, NormalMaterial, MatcapMaterial]) {
    const { code, engine } = await drawn(
      new Class({ features: [materialPlugin({ name: 'paint', output: 'color = vec3f(1.0, 0.0, 0.0);' })] }),
    );
    try {
      const early = code.slice(code.indexOf('if(f.coordsB.w<0.5){'));
      assert.match(
        early.slice(0, early.indexOf('var color=')),
        /var color:vec3f=[^;]*;color=margoPlugin_paint_output\(i,s,v,color\);return vec4f\(color,alpha\);/,
        Class.name,
      );
    } finally {
      engine.dispose();
    }
  }
});

test('more than eight plugins on one material are refused', () => {
  const list = Array.from({ length: 9 }, (_, k) => materialPlugin({ name: 'p' + k, light: 'color += vec3f(0.0);' })),
    m = new PbrMaterial({ features: list });
  assert.throws(() => list[0].shader('fn surface(i:Out,front:bool)->Surface {', 2, m), RangeError);
});

test('uniforms upload when they change, follow a device restore, and the last detach frees them', () => {
  const { device } = mockGPU(),
    writes = [];
  const write = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data) => {
    writes.push(Array.from(data));
    write(buffer, offset, data);
  };
  const p = wave(),
    a = new PbrMaterial({ features: [p] }),
    b = new PbrMaterial({ features: [p] });
  const entries = p.bindings(device, {}, a);
  assert.deepEqual(
    entries.map((e) => e.binding),
    [300],
  );
  assert.deepEqual(writes.at(-1), [0.25, 0, 0, 0, 1, 0.5, 0, 0]);
  p.bindings(device, {}, a);
  assert.equal(writes.length, 1, 'a steady plugin uploads nothing');
  p.uniforms.height = 2;
  p.uniforms.tint[1] = 1;
  p.bindings(device, {}, a);
  assert.deepEqual(writes.at(-1), [2, 0, 0, 0, 1, 1, 0, 0]);
  // A restored device is a new device: a new buffer with the current values.
  const restored = mockGPU().device,
    copied = [];
  restored.queue.writeBuffer = (_b, _o, data) => copied.push(Array.from(data));
  assert.notEqual(p.bindings(restored, {}, a)[0].resource.buffer, entries[0].resource.buffer);
  assert.deepEqual(copied, [[2, 0, 0, 0, 1, 1, 0, 0]]);
  const buffer = entries[0].resource.buffer;
  let destroyed = 0;
  const destroy = buffer.destroy.bind(buffer);
  buffer.destroy = () => (destroyed++, destroy());
  a.features = [];
  assert.equal(destroyed, 0, 'another material still uses it');
  b.features = [];
  assert.equal(destroyed, 1);
  assert.deepEqual(p.bindings(device, {}, b), [], 'a material without the plugin binds nothing of it');
});

test('textures bind at the plugin block, live and of a fixed dimension', () => {
  const { device } = mockGPU(),
    one = new Texture({ data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 }),
    two = new Texture({ data: new Uint8Array([0, 255, 0, 255]), width: 1, height: 1 });
  const p = materialPlugin({
      name: 'paint',
      textures: { mask: one },
      surface: 's.base = textureSample(paint_mask, paint_maskSampler, i.uv.xy);',
    }),
    m = new PbrMaterial({ features: [wave(), p] });
  assert.deepEqual(
    p.bindings(device, {}, m).map((e) => e.binding),
    [317, 318],
  );
  p.textures.mask = two;
  assert.equal(p.textures.mask, two);
  assert.throws(() => (p.textures.mask = {}), TypeError);
  one.dispose();
  two.dispose();
});

// The vertex move must reach every depth pass, or a displaced surface casts its undisplaced shadow and TAA reads
// a velocity for the wrong place.
test('shadow casters and TAA velocity move by the same vertex chain as the colour pass', async () => {
  const p = wave(),
    { mesh, gpu, engine } = await drawn(new PbrMaterial({ features: [p] }));
  try {
    const record = mesh.primitives[0].material.displacement;
    assert.ok(record?.depth, 'the primitive casts through the plugins');
    assert.equal(record, mesh.primitives[0].material.displacement, 'the record is kept while unchanged');
    assert.equal(record.cuts, false);
    const depth = displacedDepth(shadowDepth(true), 2, record);
    assert.match(
      depth,
      /var margoPV=MargoPluginVertex\(i\.position\.xyz,i\.normal\.xyz\);margoPV=margoPlugin_wave_vertex/,
    );
    assert.match(depth, /vec4f\(margoPV\.position,1\)/);
    assert.match(depth, /@group\(2\) @binding\(300\) var<uniform> wave:MargoPlugin_wave;/);
    assert.doesNotMatch(depth, /margoPlugin_wave_surface/, 'the surface point stays out of depth passes');
    assert.deepEqual(
      record.entries().map((e) => e.binding),
      [300],
    );
    assert.ok(record.layout());
    const velocity = objectVelocity(true, false, false, false, true, false, record.velocity);
    assert.match(velocity, /let margoPosition=margoPV\.position;/);
    assert.match(velocity, /let shift=margoPosition-i\.position\.xyz;/);
    // A material whose plugins move nothing casts as before.
    const still = new PbrMaterial({ features: [materialPlugin({ name: 'tint', light: 'color *= 0.5;' })] });
    assert.equal(still.features[0].caster(gpu.device, still, undefined), undefined);
  } finally {
    engine.dispose();
  }
});

test('a displacementMap moves along the moved normal in the caster, after the plugins', async () => {
  const map = new Texture({ data: new Uint8Array(16).fill(255), width: 2, height: 2 }, { mipmaps: false }),
    p = wave(),
    { mesh, engine, code } = await drawn(
      new PbrMaterial({ features: [p], displacementMap: map, displacementScale: 0.2 }),
    );
  try {
    assert.match(
      code,
      /margoPV\.position\+margoNormal\*margoDisplacement\(i\.uv\)/,
      'the colour pass moves the same way',
    );
    const record = mesh.primitives[0].material.displacement;
    assert.ok(record.key.endsWith(':map'));
    const depth = displacedDepth(shadowDepth(true), 2, record);
    assert.match(depth, /margoPV\.position\+=margoPV\.normal\*margoDisplacement\(i\.uv\);/);
    assert.match(depth, /var margoDisplacementMap:texture_2d<f32>/);
    assert.deepEqual(
      record.entries().map((e) => e.binding),
      [0, 1, 2, 300],
    );
  } finally {
    engine.dispose();
    map.dispose();
  }
});

test('a saved material restores its plugin through the codec, with its current uniforms', async () => {
  const p = wave();
  p.uniforms.height = 0.75;
  const codecs = [materialPluginCodec],
    library = await captureMaterialLibrary({ cloth: new PbrMaterial({ features: [p] }) }, { codecs }),
    [restored] = (await restoreMaterialLibrary(JSON.parse(JSON.stringify(library)), { codecs })).cloth.features;
  assert.equal(restored.name, 'plugin:wave');
  assert.equal(restored.uniforms.height, 0.75);
  assert.equal(restored.code.vertex, p.code.vertex);
  assert.notEqual(restored, p);
  await assert.rejects(
    captureMaterialLibrary({ cloth: new PbrMaterial({ features: [p] }) }),
    'without the codec a plugin is not saved in silence',
  );
});
