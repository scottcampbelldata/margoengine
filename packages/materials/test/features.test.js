// Optional material features (`Material.features`) on a mock device: the shader text a feature adds, that a material
// without one keeps its text, and the list's own rules. features-browser.mjs checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { LambertMaterial, Material, PbrMaterial, Texture, createInstancedMesh, createMesh } from '../dist/index.js';
import { alphaHash } from '../dist/alpha-hash.js';
import { objectNormal } from '../dist/object-normal.js';

async function scene() {
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
  let n = 0;
  const frame = () =>
    gpu.record(() => {
      store.tick(false);
      view.begin(n++);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, frame };
}
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
/** The WGSL modules compiled in frame log `log`. */
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test('alphaHash compiles into a material only while it is listed', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial();
  createMesh(engine, quad, material);
  const plain = modules(frame()).filter((c) => c.includes('fn surface('));
  assert.ok(plain.length);
  assert.ok(plain.every((c) => !c.includes('margoAlphaHash')));
  assert.equal(material.alphaTest, 0);
  material.features = [alphaHash()];
  assert.equal(material.alphaTest, 0.5, 'the passes without the colour shader cut at the default');
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(code, /let margoCut=margoAlphaHash\(i\.margoObject\);/);
  assert.match(code, /s\.base\.a<margoCut\)\{discard;\}/);
  assert.doesNotMatch(code, /s\.base\.a<f\.settings\.y/);
  assert.match(code, /o\.margoObject=i\.position\.xyz;/);
  material.features = [];
  assert.equal(material.alphaTest, 0);
  assert.ok(modules(frame()).every((c) => !c.includes('margoAlphaHash')));
});

test('alphaHash follows the instanced vertex stage and every lit shading', async () => {
  const { engine, frame } = await scene();
  createInstancedMesh(engine, quad, new LambertMaterial({ features: [alphaHash({ scale: 2 })] }), 4);
  const code = modules(frame()).find((c) => c.includes('margoAlphaHash'));
  assert.match(code, /let p=margoI\*vec4f\(i\.position\.xyz,1\);o\.margoObject=i\.position\.xyz;/);
  assert.match(code, /log2\(2e\+0\//);
});

test('a material keeps an alphaTest of its own, and clone and copy carry the list', () => {
  const hash = alphaHash({ cutoff: 0.3 }),
    set = new PbrMaterial({ alphaTest: 0.7, features: [hash] }),
    raised = new PbrMaterial({ features: [hash] });
  assert.equal(set.alphaTest, 0.7);
  assert.equal(raised.alphaTest, 0.3);
  assert.deepEqual(raised.clone().features, [hash]);
  assert.deepEqual(new PbrMaterial().copy(raised).features, [hash]);
  set.features = [];
  assert.equal(set.alphaTest, 0.7);
});

test('the feature list is checked', () => {
  const material = new Material();
  assert.throws(() => (material.features = 'alphaHash'), TypeError);
  assert.throws(() => (material.features = [{}]), TypeError);
  assert.throws(() => (material.features = [alphaHash(), alphaHash()]), /different names/);
  assert.throws(() => alphaHash({ scale: 0 }), RangeError);
  assert.throws(() => alphaHash({ cutoff: 0 }), RangeError);
  assert.throws(() => alphaHash({ cutoff: 1.5 }), RangeError);
  assert.ok(Object.isFrozen(new Material({ features: [alphaHash()] }).features));
});

const flat = () =>
  new Texture({ data: new Uint8Array(16).fill(128), width: 2, height: 2 }, { colorSpace: 'linear', mipmaps: false });

test('objectNormal replaces the tangent frame only while a normalMap is set, and follows instances', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({ features: [objectNormal()] });
  createMesh(engine, quad, material);
  assert.ok(modules(frame()).every((c) => !c.includes('margoObjectX')));
  material.normalMap = flat();
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(code, /mat3x3f\(i\.margoObjectX,i\.margoObjectY,i\.margoObjectZ\)\*\(sampledNormal\)/);
  assert.doesNotMatch(code, /s\.n=normalize\(t\*sampledNormal/);
  const other = await scene();
  createInstancedMesh(other.engine, quad, new PbrMaterial({ normalMap: flat(), features: [objectNormal({ up: 'z' })] }), 2);
  const instanced = modules(other.frame()).find((c) => c.includes('margoObjectX'));
  assert.match(instanced, /let margoObjectModel=margoI;/);
  assert.match(instanced, /sampledNormal\.xzy\*vec3f\(1,1,-1\)/);
  assert.throws(() => objectNormal({ up: 'x' }), TypeError);
});

test('loadKTX2Texture: a layer decoder brings a cube, an array or a refusal for a cube array', async () => {
  const { CubeTexture, Texture, loadKTX2Texture } = await import('../dist/index.js');
  const made = (dimension, layers) => ({
    width: 2,
    height: 2,
    layers,
    dimension,
    mipmaps: [{ data: new Uint8Array(16 * layers), width: 2, height: 2, byteLength: 16 * layers }],
    format: 'rgba8unorm',
    target: 'ktx2',
    srgb: false,
    hasAlpha: true,
  });
  const decoder = (file) => ({ decode: async () => file, upload: () => ({}) }),
    fetch = async () => new Response(new Uint8Array(4));
  const cube = await loadKTX2Texture('https://a.test/a.ktx2', { decoder: decoder(made('cube', 6)), fetch });
  assert.ok(cube instanceof CubeTexture);
  assert.equal(cube.dimension, 'cube');
  assert.equal(cube.depth, 6);
  const array = await loadKTX2Texture('https://a.test/a.ktx2', { decoder: decoder(made('2d-array', 3)), fetch });
  assert.ok(array instanceof Texture);
  assert.equal(array.dimension, '2d-array');
  assert.equal(array.depth, 3);
  await assert.rejects(loadKTX2Texture('https://a.test/a.ktx2', { decoder: decoder(made('cube-array', 12)), fetch }), /no material slot/);
  await assert.rejects(
    loadKTX2Texture('https://a.test/a.ktx2', { decoder: decoder(made('cube', 6)), fetch, colorSpace: 'linear' }),
    /comes from the file's format/,
  );
  await assert.rejects(loadKTX2Texture('https://a.test/a.ktx2', { decoder: {}, fetch }), /needs a decoder/);
  assert.throws(() => new CubeTexture(made('2d-array', 3)), /KTX2 cube map/);
});

test('layered: an empty call, bad numbers, an array map without its layer and too many textures refuse', async () => {
  const { layered } = await import('../dist/layered.js');
  const { Texture } = await import('../dist/index.js');
  const t = () => new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  const array = new Texture({ data: new Uint8Array(8), width: 1, height: 1, depth: 2 }, { dimension: '2d-array' });
  assert.throws(() => layered(), /layers or detail/);
  assert.throws(() => layered({ layers: Array(9).fill({}) }), /at most 8/);
  assert.throws(() => layered({ layers: [{ opacity: 2 }] }), /opacity must be from 0 to 1/);
  assert.throws(() => layered({ layers: [{ color: [1, 1] }] }), /color must be 3 finite/);
  assert.throws(() => layered({ layers: [{ heightContrast: 0 }] }), /heightContrast must be above 0/);
  assert.throws(() => layered({ layers: [{ maskChannel: 'x' }] }), /maskChannel/);
  assert.throws(() => layered({ layers: [{ map: array }] }), /pass \{texture, layer\}/);
  assert.throws(() => layered({ layers: [{ map: { texture: array, layer: 2 } }] }), /layer must be an index/);
  assert.throws(() => layered({ detail: {} }), /needs a map or normalMap/);
  const clamped = new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  assert.throws(() => layered({ detail: { map: clamped } }), /tiling needs Textures that repeat/);
  assert.throws(() => layered({ layers: [{ map: clamped, tiling: [2, 1] }] }), /tiling needs Textures that repeat/);
  assert.ok(layered({ layers: [{ map: clamped, mask: clamped }] }));
  assert.throws(
    () => layered({ layers: Array.from({ length: 8 }, () => ({ map: t(), mask: t() })) }),
    /at most; pack|9 at most/,
  );
});
test('layered: textures shared between layers bind once, and only its users see its shader', async () => {
  const { layered } = await import('../dist/layered.js');
  const { Texture } = await import('../dist/index.js');
  const mask = new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  const f = layered({ layers: [{ mask, maskChannel: 'r' }, { mask, maskChannel: 'g' }] });
  const code = f.shader('fn surface(i:Out,front:bool)->Surface {\n  if(!facing&&f.settings.z<0.5){discard;}\n*f.base*i.color;', 2);
  assert.equal(code.match(/var margoLayerMap\d+:/g).length, 1);
  assert.match(code, /margoLayerRows\.rows\[3\]/);
  assert.match(code, /\*f\.base\*i\.color;/, 'colours keep tinting without a vertexChannel');
  const tinted = layered({ layers: [{ vertexChannel: 'r' }] }).shader(
    'fn surface(i:Out,front:bool)->Surface {\n  if(!facing&&f.settings.z<0.5){discard;}\n*f.base*i.color;',
    2,
  );
  assert.match(tinted, /\*f\.base\*vec4f\(1,1,1,i\.color\.a\);/);
  assert.throws(() => f.shader('no surface here', 2), /standard gltf-pro PBR shader/);
});

test('mipTexture: a chain must halve, hold enough texels and match its format', async () => {
  const { mipTexture } = await import('../dist/mips.js');
  const level = (n) => ({ data: new Uint8Array(n * n * 4), width: n, height: n });
  const t = mipTexture([level(4), level(2), level(1)]);
  assert.equal(t.width, 4);
  assert.equal(t.mipmaps, true);
  assert.equal(mipTexture([level(4)]).mipmaps, false);
  assert.equal(mipTexture([{ data: new Uint8Array(8 * 2 * 4), width: 8, height: 2 }, { data: new Uint8Array(4 * 1 * 4), width: 4, height: 1 }, { data: new Uint8Array(2 * 4), width: 2, height: 1 }]).width, 8);
  assert.throws(() => mipTexture([]), /needs mip levels/);
  assert.throws(() => mipTexture([level(4), level(1)]), /level 1 must be 2 x 2, not 1 x 1/);
  assert.throws(() => mipTexture([{ data: new Uint8Array(4), width: 4, height: 4 }]), /level 0 needs 64 values/);
  assert.throws(() => mipTexture([{ data: new Float32Array(64), width: 4, height: 4 }]), /must hold bytes/);
  assert.throws(() => mipTexture([level(4)], { format: 'rgba16float' }), /half-float bits/);
  assert.throws(() => mipTexture([{ data: new Float32Array(64), width: 4, height: 4 }], { format: 'rgba16float', colorSpace: 'srgb' }), /are linear/);
});
