// Optional material features (`Material.features`) on a mock device: the shader text a feature adds, that a material
// without one keeps its text, and the list's own rules. features-browser.mjs checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { LambertMaterial, Material, PbrMaterial, Texture, UnlitMaterial, createInstancedMesh, createMesh } from '../dist/index.js';
import { alphaHash } from '../dist/alpha-hash.js';
import { objectNormal } from '../dist/object-normal.js';
import { stochasticTiling } from '../dist/stochastic.js';
import { layered } from '../dist/layered.js';
import { hair } from '../dist/hair.js';
import { eye } from '../dist/eye.js';
import { skin, skinProfile, skinTable, skinTransmittance } from '../dist/skin.js';

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
  assert.throws(() => f.shader('no surface here', 2), /standard gltf\/pbr shader/);
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

test('alphaToCoverage: a material asks for it through the render state, and only a boolean goes', async () => {
  const { UnlitMaterial } = await import('../dist/index.js');
  const m = new UnlitMaterial({ alphaTest: 0.5, alphaToCoverage: true });
  assert.equal(m.alphaToCoverage, true);
  assert.equal(m.customState, true);
  assert.equal(new UnlitMaterial().alphaToCoverage, false);
  assert.equal(new UnlitMaterial().customState, false);
  assert.throws(() => new UnlitMaterial({ alphaToCoverage: 1 }), TypeError);
});

test('prefilterCube: refuses anything but a cube, a bad size and an aborted signal', async () => {
  const { prefilterCube } = await import('../dist/prefilter.js');
  const { CubeTexture, Texture } = await import('../dist/index.js');
  const device = { createBuffer() {} };
  const face = { data: new Uint8Array(4), width: 1, height: 1 };
  const cube = new CubeTexture([face, face, face, face, face, face]);
  await assert.rejects(prefilterCube(device, new Texture(face)), /needs a CubeTexture/);
  await assert.rejects(prefilterCube(device, cube, { size: 24 }), /power of two from 16 to 2048/);
  await assert.rejects(prefilterCube(device, cube, { size: 8 }), /power of two from 16 to 2048/);
  await assert.rejects(prefilterCube({ gpu: null }, cube), /needs WebGPU/);
  await assert.rejects(prefilterCube(device, cube, { signal: AbortSignal.abort() }), /abort/i);
});

const pixel = (options) => new Texture({ data: new Uint8Array(4), width: 1, height: 1 }, options);
const repeats = { wrapS: 'repeat', wrapT: 'repeat' };
test('stochasticTiling compiles in only while listed and reads the maps it names', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({ map: pixel(repeats), normalMap: pixel(repeats) });
  createMesh(engine, quad, material);
  const plain = modules(frame()).filter((c) => c.includes('fn surface('));
  assert.ok(plain.length && plain.every((c) => !c.includes('margoTile')));
  material.features = [stochasticTiling({ maps: ['map'] })];
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(code, /margoTile_mat_baseMap\(uv\(i,f\.coordsA\.x\)\)/);
  assert.doesNotMatch(code, /margoTile_mat_normalMap/);
  assert.match(code, /textureSample\(mat_normalMap,mat_normalMapS/);
  material.features = [stochasticTiling()];
  const all = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(all, /let sampledNormal=margoTile_mat_normalMap\(/);
  assert.match(all, /margoTile_mat_mrMap\(/);
  material.features = [];
  assert.ok(modules(frame()).every((c) => !c.includes('margoTile')));
});

test('stochasticTiling reads the maps of a physical material by their slot', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({
      map: pixel(repeats),
      metalRoughnessMap: pixel(repeats),
      clearcoat: 1,
      clearcoatMap: pixel(repeats),
      features: [stochasticTiling({ maps: ['map', 'clearcoatMap'] })],
    });
  createMesh(engine, quad, material);
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(code, /s\.base=margoTile_margoPhysicalMap0\(margoPhysicalUV\(i,0\)\)/);
  assert.match(code, /s\.cc=f\.coat\.x\*margoTile_margoPhysicalMap\d\(margoPhysicalUV\(i,5\)\)/);
  assert.match(code, /let mr=textureSample\(margoPhysicalMap1,/);
});

test('stochasticTiling refuses clamped maps and a layered feature after it, and checks its options', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({ map: pixel(), features: [stochasticTiling()] });
  createMesh(engine, quad, material);
  assert.throws(() => frame(), { name: 'TypeError', message: /make map with \{wrapS: 'repeat'/ });
  material.features = [stochasticTiling({ maps: ['normalMap'] })];
  frame();
  material.features = [stochasticTiling({ maps: ['normalMap'] }), layered({ detail: { map: pixel(repeats) } })];
  assert.throws(() => frame(), { name: 'TypeError', message: /list layered\(\) ahead of it/ });
  assert.throws(() => stochasticTiling({ cellSize: 0 }), RangeError);
  assert.throws(() => stochasticTiling({ blend: 1.5 }), RangeError);
  assert.throws(() => stochasticTiling({ maps: ['lightMap'] }), TypeError);
  assert.throws(() => stochasticTiling({ maps: [] }), TypeError);
});

test('stochasticTiling reads a layer through the grid and leaves its mask alone', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({
      features: [layered({ layers: [{ map: pixel(repeats), mask: pixel(repeats) }] }), stochasticTiling()],
    });
  createMesh(engine, quad, material);
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(code, /margoTile_margoLayerMap\d\(margoLayerUV0\)/);
  assert.match(code, /textureSample\(margoLayerMap\d,margoLayerSampler\d,i\.uv\.xy\)\.r/);
});

test('hair, eye and skin compile in only while listed, and take every light through their model', async () => {
  for (const [make, light] of [
    [() => hair(), 'margoHairLight'],
    [() => hair({ direction: [0, -1, 0] }), 'margoHairLight'],
    [() => eye(), 'margoEyeLight'],
    [() => skin(), 'margoSkinLight'],
  ]) {
    const { engine, frame } = await scene(),
      material = new PbrMaterial();
    createMesh(engine, quad, material);
    const plain = modules(frame()).filter((c) => c.includes('fn surface('));
    assert.ok(plain.every((c) => !c.includes(light)));
    material.features = [make()];
    const code = modules(frame()).find((c) => c.includes('fn surface('));
    assert.ok(code.includes(`return ${light}(s.n,v,l,s.base.rgb)*`));
    material.features = [];
    assert.ok(modules(frame()).every((c) => !c.includes(light)));
  }
});

test('hair, eye and skin refuse a physical material and bad options', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({ anisotropy: 0.5, features: [hair()] });
  createMesh(engine, quad, material);
  assert.throws(() => frame(), { name: 'TypeError', message: /hair needs a PbrMaterial without anisotropy/ });
  assert.throws(() => hair({ width: 0 }), RangeError);
  assert.throws(() => hair({ direction: [0, 0, 0] }), TypeError);
  assert.throws(() => hair({ specular: -1 }), RangeError);
  assert.throws(() => eye({ ior: 1 }), RangeError);
  assert.throws(() => eye({ pupil: 1 }), RangeError);
  assert.throws(() => eye({ axis: [0, 0] }), TypeError);
  assert.throws(() => skin({ unitsPerMeter: 0 }), RangeError);
});

test('skin with subsurface drops the wrap and lets the directional light through by the skin profile', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({ features: [skin({ thickness: 0.002 })], subsurface: 0.8 });
  createMesh(engine, quad, material);
  const code = modules(frame()).find((c) => c.includes('fn surface('));
  // The skin table already moves light past the terminator: subsurface's wrap on top of it counted that light twice.
  assert.match(code, /let direct=direct_light\(s,v,l\);/);
  assert.ok(!code.includes('margoSubsurfaceWrap(s,l)'));
  assert.ok(!code.includes('margoSubsurface(i,s,v,l)'));
  assert.match(code, /var color=margoSkinThrough\(i,s,l\)\+/);
  // 2 mm, the depth at subsurfaceThickness 1, and the widest Gaussian (7.41 mm^2) of the profile.
  assert.match(code, /let d=c\.a\*margoThickness\(i\)\*2e\+0;/);
  assert.match(code, /vec3f\(7\.8e-2,0e\+0,0e\+0\)\*exp\(d2\/7\.41e\+0\)/);
  assert.match(code, /max\(0\.3-dot\(margoSkinMesh,l\),0\.0\)/);
  material.subsurface = 0;
  assert.ok(modules(frame()).every((c) => !c.includes('margoSkinThrough')));
  assert.throws(() => skin({ thickness: 0 }), RangeError);
  assert.deepEqual(skin({ unitsPerMeter: 100, thickness: 0.5 }).serialization(), { unitsPerMeter: 100, thickness: 0.5 });
});

test('skin transmittance is the profile integrated over the back of a slab', () => {
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(skinTransmittance(0)[c] - 1) < 1e-12);
  for (const depth of [0.25, 1, 2, 4]) {
    const total = [0, 0, 0];
    for (let r = 0.00025; r < 60; r += 0.0005) {
      const p = skinProfile(Math.hypot(r, depth));
      for (let c = 0; c < 3; c++) total[c] += p[c] * 2 * Math.PI * r * 0.0005;
    }
    const t = skinTransmittance(depth);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(total[c] - t[c]) < 1e-5, `${depth} mm channel ${c}: ${total[c]} ${t[c]}`);
    assert.ok(t[0] > t[1] && t[1] >= t[2], 'red passes furthest');
  }
});

test('the skin profile is the published fit, and the table holds it', () => {
  // The weights of each colour sum to 1, so the profile integrates to 1 over the plane: sum of w G(v, r) 2 pi r dr.
  for (let c = 0; c < 3; c++) {
    let total = 0;
    for (let r = 0.0005; r < 40; r += 0.001) total += skinProfile(r)[c] * 2 * Math.PI * r * 0.001;
    assert.ok(Math.abs(total - 1) < 0.002, `channel ${c}: ${total}`);
  }
  const size = 16,
    table = skinTable(size),
    at = (column, row, c) => table[(row * size + column) * 4 + c],
    nl = (column) => ((column + 0.5) / size) * 2 - 1;
  // Convolving on the ring moves light around it and loses none: the integral of D over the circle is that of cos+, 2.
  for (let row = 0; row < size; row++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      const fine = 2048;
      for (let k = 0; k < fine; k++) {
        const theta = ((k + 0.5) / fine) * Math.PI,
          x = ((Math.cos(theta) + 1) / 2) * size - 0.5,
          low = Math.max(0, Math.min(size - 2, Math.floor(x))),
          t = Math.min(1, Math.max(0, x - low));
        sum += (at(low, row, c) * (1 - t) + at(low + 1, row, c) * t) * (Math.PI / fine);
      }
      // Half the circle, as the table is symmetric: 1, less what a table of 16 columns rounds off the kink at n.l = 0.
      assert.ok(Math.abs(sum - 1) < 0.03, `row ${row} channel ${c}: ${sum}`);
    }
  // Sharply curved: at the terminator red has crept furthest, blue least. Nearly flat: D is n.l.
  const curved = size - 1,
    middle = size / 2;
  assert.ok(at(middle, curved, 0) > at(middle, curved, 1) && at(middle, curved, 1) > at(middle, curved, 2));
  const flat = skinTable(64);
  for (const column of [8, 20, 44, 60])
    assert.ok(Math.abs(flat[column * 4] - Math.max(0, ((column + 0.5) / 64) * 2 - 1)) < 0.02, `column ${column}`);
});

test('dithering compiles in only while set, on the 8-bit path, and is live', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial();
  createMesh(engine, quad, material);
  assert.ok(modules(frame()).every((c) => !c.includes('margoDither')));
  material.dithering = true;
  const lit = modules(frame()).find((c) => c.includes('fn surface('));
  assert.match(lit, /color=margoDither\(color,i\.clip\.xy\);\s*return vec4f\(color,/);
  assert.match(lit, /c,margoView\.flags\.x>0\.5\)/, 'a float scene target keeps its values');
  material.dithering = false;
  assert.ok(modules(frame()).every((c) => !c.includes('margoDither')));
  const { engine: second, frame: draw } = await scene();
  createMesh(second, quad, new UnlitMaterial({ dithering: true }));
  assert.match(modules(draw()).find((c) => c.includes('fn surface(')), /return vec4f\(margoDither\(mat_out\(/);
  const clone = new PbrMaterial({ dithering: true }).clone();
  assert.equal(clone.dithering, true);
  assert.throws(() => (material.dithering = 1), TypeError);
});

test('clipping planes cut in the rasterizer only on a device with clip-distances, a union and room for the distances', async () => {
  const fitted = async (features) => {
      const made = await scene();
      Object.defineProperty(made.gpu.device, 'limits', { value: { ...made.gpu.device.limits, maxInterStageShaderVariables: 16 } });
      for (const name of features) made.gpu.device.features.add(name);
      return made;
    },
    plane = [[0, 1, 0, 0]],
    surface = (log) => modules(log).find((c) => c.includes('fn surface('));
  {
    const { engine, frame } = await fitted(['clip-distances']);
    createMesh(engine, quad, new PbrMaterial({ clippingPlanes: plane }));
    const code = surface(frame());
    assert.ok(code.startsWith('enable clip_distances;\n'));
    assert.match(code, /@vertex fn vertex\(i:Input\)->MargoClipped \{\s*var o:MargoClipped;/);
    assert.match(code, /struct MargoClipped \{[^}]*@builtin\(clip_distances\) margoClip:array<f32,8>\}/);
    assert.match(code, /@fragment fn fragment\(i:Out,/, 'a fragment stage cannot read the distances');
    assert.ok(!code.includes('materialClipBehind'), 'no discard');
  }
  {
    const { engine, frame } = await fitted([]);
    createMesh(engine, quad, new PbrMaterial({ clippingPlanes: plane }));
    const code = surface(frame());
    assert.ok(!code.includes('clip_distances'));
    assert.ok(code.includes('materialClipBehind'));
  }
  {
    const { engine, frame } = await fitted(['clip-distances']),
      material = new PbrMaterial({ clippingPlanes: plane, clipIntersection: true });
    createMesh(engine, quad, material);
    assert.ok(surface(frame()).includes('materialClipBehind'), 'an intersection is no union');
    material.clipIntersection = false;
    assert.ok(surface(frame()).includes('clip_distances'), 'the switch recompiles');
  }
  {
    const { engine, frame } = await fitted(['clip-distances']);
    createMesh(engine, quad, new PbrMaterial({ clippingPlanes: plane, features: [eye()] }));
    const code = surface(frame());
    assert.ok(!code.includes('clip_distances') && code.includes('materialClipBehind'), 'an eye fills the inter-stage slots');
  }
  {
    // WGSL's clip_distances holds 8: past 8 planes the material discards, and back at 8 it cuts in the rasterizer again.
    const { engine, frame } = await fitted(['clip-distances']),
      eight = Array.from({ length: 8 }, (_, i) => [Math.cos(i), Math.sin(i), 0, 1]),
      material = new PbrMaterial({ clippingPlanes: eight });
    createMesh(engine, quad, material);
    assert.ok(surface(frame()).includes('clip_distances'), 'eight planes cut in the rasterizer');
    material.clippingPlanes = [...eight, [0, 0, 1, 1]];
    const nine = surface(frame());
    assert.ok(!nine.includes('clip_distances') && nine.includes('materialClipBehind'), 'nine planes discard');
    assert.match(nine, /planes:array<vec4f,16>/);
    material.clippingPlanes = eight;
    assert.equal(surface(frame()), undefined, 'back at eight reuses the rasterizer variant compiled first');
  }
});

// A thin cornea with nearly parallel faces leaves a ray in the direction Snell's law gives from air into the aqueous
// humour (Gullstrand 1.336); the eye bent the view and light rays by the cornea's 1.376, too far, which moved the iris.
// The cornea's index still sets its reflection: F0 = ((1.376 - 1) / (1.376 + 1))^2.
test('the eye bends its rays by the aqueous humour and reflects by the cornea', async () => {
  const { engine, frame } = await scene(),
    material = new PbrMaterial({ features: [eye()] });
  createMesh(engine, quad, material);
  const code = modules(frame()).find((c) => c.includes('fn margoEyeSurface('));
  const bends = [...code.matchAll(/refract\(-[vl],c?n,1\.0\/([0-9.e+-]+)\)/g)].map((m) => Number(m[1]));
  assert.deepEqual(bends, [1.336, 1.336]);
  const f0 = ((1.376 - 1) / (1.376 + 1)) ** 2;
  assert.ok(code.includes(`mix(0.04,mix(${f0.toExponential()},`), 'the cornea reflects by its own index when dry');
  assert.throws(() => eye({ chamberIor: 1 }), RangeError);
  const { engine: other, frame: next } = await scene();
  createMesh(other, quad, new PbrMaterial({ features: [eye({ chamberIor: 1.4 })] }));
  const custom = modules(next()).find((c) => c.includes('fn margoEyeSurface('));
  assert.deepEqual(
    [...custom.matchAll(/refract\(-[vl],c?n,1\.0\/([0-9.e+-]+)\)/g)].map((m) => Number(m[1])),
    [1.4, 1.4],
  );
});

// The cornea is steeper than the globe: 7.8 mm on a 12 mm eye (Le Grand's full theoretical eye, Atchison and Smith 2000).
// The view ray refracted on the globe's own sphere, which magnified the entrance pupil 1.064 times against the published
// 1.133. The whole front wears a tear film of index 1.337 (Craig et al. 1995) whose share of reflection is `wetness`.
test("the eye bends rays on the cornea's own sphere and wears a live tear film", async () => {
  const { engine, frame } = await scene(),
    feature = eye();
  createMesh(engine, quad, new PbrMaterial({ features: [feature] }));
  const code = modules(frame()).find((c) => c.includes('fn margoEyeSurface('));
  assert.match(code, /let cn=normalize\(d-axis\*\(radius\*\(1\.0-6\.5e-1\)\)\);/);
  assert.match(code, /refract\(-v,cn,/);
  const film = ((1.337 - 1) / (1.337 + 1)) ** 2;
  assert.ok(code.includes(film.toExponential()), 'the film reflects as water of 1.337');
  assert.match(code, /let coat=margoEyeWet\*\(1\.0-margoEyeCornea\)/);
  assert.equal(feature.wetness, 1);
  feature.wetness = 0.25;
  assert.equal(feature.serialization().wetness, 0.25);
  assert.throws(() => (feature.wetness = 2), RangeError);
  assert.throws(() => eye({ corneaRadius: 0 }), RangeError);
  assert.throws(() => eye({ corneaRadius: 1.5 }), RangeError);
  assert.throws(() => eye({ wetness: -1 }), RangeError);
  const { engine: other, frame: next } = await scene();
  createMesh(other, quad, new PbrMaterial({ features: [eye({ corneaRadius: 1 })] }));
  const globe = modules(next()).find((c) => c.includes('fn margoEyeSurface('));
  assert.match(globe, /radius\*\(1\.0-1e\+0\)\)/, "corneaRadius 1 keeps the globe's sphere");
});

// The upper lid shades the ball under its margin by default (the ledge's ambient occlusion over a sky brighter
// overhead, and its shadow): its row, after the eye's five, is height, tilt, curve and depth; false leaves a bare ball.
test('the eye wears an upper lid by default, measured from its up, and false leaves a bare eyeball', async () => {
  const written = [],
    device = {
      createBuffer: () => ({ destroy() {} }),
      queue: { writeBuffer: (_b, _o, data) => written.push(Float32Array.from(data)) },
    };
  eye().bindings(device);
  assert.equal(written.at(-1).length, 28);
  assert.deepEqual([...written.at(-1).slice(20, 24)], [0.375, 0, -0.4, 1 / 6].map(Math.fround));
  eye({ lid: false }).bindings(device);
  assert.deepEqual([...written.at(-1).slice(20, 24)], [0, 0, 0, 0]);
  eye({ lid: { height: 0.2, tilt: 0.05, curve: -0.42, depth: 0.2 } }).bindings(device);
  assert.deepEqual([...written.at(-1).slice(20, 24)], [0.2, 0.05, -0.42, 0.2].map(Math.fround));
  // The side row is up cross axis: the lid's tilt and the iris picture follow `up`.
  eye({ axis: [0, 0, 1], up: [1, 0, 0] }).bindings(device);
  assert.deepEqual([...written.at(-1).slice(16, 19)], [0, -1, 0]);
  eye().bindings(device);
  assert.deepEqual([...written.at(-1).slice(16, 19)], [1, 0, 0], 'the default up keeps the side the eye had');
  assert.throws(() => eye({ lid: { depth: 0 } }), RangeError);
  assert.throws(() => eye({ lid: { height: 2 } }), RangeError);
  assert.throws(() => eye({ lid: true }), TypeError);
  assert.throws(() => eye({ up: [0, 0] }), TypeError);
  const { engine, frame } = await scene();
  createMesh(engine, quad, new PbrMaterial({ features: [eye()] }));
  const code = modules(frame()).find((c) => c.includes('fn margoEyeSurface('));
  assert.match(code, /s\.occlusion\*=select\(1\.0,\(0\.2015\+0\.7985\*\(1\.0-1\.0\/\(1\.0\+0\.44\*lq\+1\.15\*lq\*lq\)\)\),lid\.w>0\.0\)\+select\(0\.0,/);
  assert.match(code, /let lit=select\(1\.0,1\.0-smoothstep\(0\.0,0\.02,margoEyeDepth\*dot\(l,margoEyeUp\)-margoEyeBelow\*dot\(l,margoEyeLook\)\)/);
});

// The lower lid is the same ledge turned over: its row follows the upper lid's, and its ambient term takes off only the
// ground's share of the light, 0.2015 under the overcast sky, as q / sqrt(1 + q^2) of the lower half comes back.
test('the eye wears a lower lid by default that shades the ground light above its margin, and false leaves it off', async () => {
  const written = [],
    device = {
      createBuffer: () => ({ destroy() {} }),
      queue: { writeBuffer: (_b, _o, data) => written.push(Float32Array.from(data)) },
    };
  eye().bindings(device);
  assert.deepEqual([...written.at(-1).slice(24)], [-0.45, 0, 0.3, 1 / 6].map(Math.fround));
  eye({ lowerLid: false }).bindings(device);
  assert.deepEqual([...written.at(-1).slice(24)], [0, 0, 0, 0]);
  eye({ lowerLid: { height: -0.42, tilt: -0.02, curve: 0.25, depth: 0.15 } }).bindings(device);
  assert.deepEqual([...written.at(-1).slice(24)], [-0.42, -0.02, 0.25, 0.15].map(Math.fround));
  assert.throws(() => eye({ lowerLid: { depth: 0 } }), RangeError);
  assert.throws(() => eye({ lowerLid: { height: -2 } }), RangeError);
  assert.throws(() => eye({ lowerLid: true }), TypeError);
  const { engine, frame } = await scene();
  createMesh(engine, quad, new PbrMaterial({ features: [eye()] }));
  const code = modules(frame()).find((c) => c.includes('fn margoEyeSurface('));
  assert.match(code, /\+select\(0\.0,-0\.2015\*\(1\.0-uq\/sqrt\(1\.0\+uq\*uq\)\),low\.w>0\.0\);/);
  assert.match(code, /-margoEyeLowDepth\*dot\(l,margoEyeUp\)-margoEyeAbove\*dot\(l,margoEyeLook\)/);
  // The closed form is the integral: a cosine-weighted sum over the forward hemisphere of an even ground under the
  // ledge, at q = height above the margin over the lid's depth.
  const visible = (q) => {
    let seen = 0,
      all = 0;
    for (let i = 0; i < 400; i++)
      for (let j = 0; j < 400; j++) {
        const z = (i + 0.5) / 400,
          y = Math.sqrt(1 - z * z) * Math.sin((2 * Math.PI * (j + 0.5)) / 400);
        if (y >= 0) continue;
        all += z;
        if (!(q * z < -y)) seen += z;
      }
    return seen / all;
  };
  for (const q of [0, 0.25, 0.5, 1, 2, 4]) assert.ok(Math.abs(visible(q) - q / Math.hypot(1, q)) < 0.005, `q ${q}`);
});

test('the eye carries its centre and axis along a follow matrix and reads an iris that fills part of its map', () => {
  // A fake device that keeps what the eye uploads: 28 floats, the centre at 8 to 10 and the axis at 12 to 14.
  const written = [],
    device = {
      createBuffer: () => ({ destroy() {} }),
      queue: { writeBuffer: (_b, _o, data) => written.push(Float32Array.from(data)) },
    };
  let matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const feature = eye({ center: [1, 2, 3], axis: [0, 0, 1], follow: () => matrix });
  feature.bindings(device);
  assert.deepEqual([...written.at(-1).slice(8, 11)], [1, 2, 3]);
  // A joint turned 90 degrees about y and moved 0.5 along x: the centre and the gaze turn with it.
  matrix = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0.5, 0, 0, 1];
  feature.bindings(device);
  const moved = written.at(-1);
  assert.deepEqual([...moved.slice(8, 11)], [3.5, 2, -1]);
  assert.deepEqual([...moved.slice(12, 15)], [1, 0, 0]);
  assert.throws(() => eye({ follow: [1, 0, 0] }), TypeError);
  matrix = [1, 2, 3];
  assert.throws(() => feature.bindings(device), TypeError);
  // Character Creator's iris sits within 0.123 of its map's middle: the shader scales the map lookup by that.
  const code = eye({ irisMap: { bind: () => undefined }, irisMapRadius: 0.123 }).shader(
    'fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {x}\nstruct Out {\n a:f32\n}\nlet p=f.model*vec4f(i.p,1);\nif(!facing&&f.settings.z<0.5){discard;}',
    3,
  );
  assert.match(code, /\*1\.23e-1\+0\.5,dx\*1\.23e-1/);
  assert.throws(() => eye({ irisMapRadius: 0.6 }), RangeError);
});

test('a mesh-axis hair direction turns with a follow matrix, so skinned strands turn with their joint', () => {
  // A fake device that keeps what the hair uploads: the turned direction, four floats.
  const written = [],
    made = [],
    device = {
      createBuffer: () => {
        const b = { destroyed: false, destroy() { this.destroyed = true; } };
        made.push(b);
        return b;
      },
      queue: { writeBuffer: (_b, _o, data) => written.push(Float32Array.from(data)) },
    };
  let matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const feature = hair({ direction: [0, -1, 0], follow: () => matrix });
  assert.deepEqual(feature.bindings(device).map((e) => e.binding), [135]);
  assert.deepEqual([...written.at(-1).slice(0, 3)], [0, -1, 0]);
  // A steady frame uploads nothing.
  feature.bindings(device);
  assert.equal(written.length, 1);
  // The joint turned 90 degrees about z and moved: the strands turn with it; the move does not touch a direction.
  matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0.5, 2, 0, 1];
  feature.bindings(device);
  assert.deepEqual([...written.at(-1).slice(0, 3)], [1, 0, 0]);
  // The vertex stage reads the uploaded direction in the feature's own group, not a constant.
  const source =
    'fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {x}\nstruct Out {\n a:f32\n}\nlet p=f.model*vec4f(i.p,1);\nif(!facing&&f.settings.z<0.5){discard;}';
  const code = feature.shader(source, 3);
  assert.match(code, /@group\(3\) @binding\(135\) var<uniform> margoHairRows/);
  assert.match(code, /margoObjectModel\*vec4f\(margoHairRows\.axis\.xyz,0\)/);
  assert.match(feature.shader(source, 2), /@group\(2\) @binding\(135\)/);
  // Without follow the direction stays a constant and the feature binds nothing.
  const fixed = hair({ direction: [0, -1, 0] });
  assert.equal(fixed.bindings, undefined);
  assert.doesNotMatch(fixed.shader(source, 3), /margoHairRows/);
  // The last material to let go frees the buffer.
  feature.attach({});
  feature.detach({});
  assert.equal(made[0].destroyed, true);
  // Bad follows.
  assert.throws(() => hair({ direction: [0, -1, 0], follow: [1, 0, 0] }), TypeError);
  assert.throws(() => hair({ follow: () => matrix }), /'u' or 'v' direction/);
  matrix = [1, 2, 3];
  assert.throws(() => hair({ direction: [0, -1, 0], follow: () => matrix }).bindings(device), TypeError);
});
