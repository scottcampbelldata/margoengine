// ./apply without a GPU: a bake becomes a linear lightmap texture with its decode scale, Material targets get and give
// back their lightMap settings, and bad input is refused before anything changes. Drawing is in tests/gpu.browser.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LambertMaterial, PbrMaterial, UnlitMaterial } from '@margoengine/materials';
import { applyLightmap, lightmapTexture } from '../dist/apply.js';
import { bakeLightmap } from '../dist/index.js';
import { bakeMeshLightmap } from '../dist/mesh.js';
import { bakeDirectionalLightmap } from '../dist/directional.js';

const lights = [{ type: 'directional', direction: [0.3, 1, 0.2], intensity: 3 }];
const atlas = await bakeLightmap({ positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]) }, { lights });
const meshBake = await bakeMeshLightmap(
  {
    positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
    uv1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  },
  { width: 8, lights, radiometry: 'physical' },
);

test('a CPU bake becomes a linear texture of its lightmap with the scale that decodes it', () => {
  for (const [bake, data] of [
    [atlas, atlas.textures.lightmap],
    [meshBake, meshBake.lightmap],
  ]) {
    const { texture, intensity } = lightmapTexture(bake);
    assert.equal(texture.source.data, data);
    assert.deepEqual([texture.width, texture.height], [bake.width, bake.height]);
    assert.equal(texture.options.colorSpace, 'linear');
    assert.equal(texture.options.mipmaps, false);
    assert.equal(intensity, bake.lightmapScale);
  }
});

test('a material gets the lightmap, its scale and the response its radiometry needs, and gets its own back', () => {
  const material = new PbrMaterial({ lightMapIntensity: 0.5 }),
    app = applyLightmap(material, meshBake, { intensity: 2 });
  assert.equal(material.lightMap, app.texture);
  assert.equal(material.lightMapResponse, 'lambertian');
  assert.equal(material.lightMapIntensity, meshBake.lightmapScale * 2);
  assert.equal(app.scale, (meshBake.lightmapScale * 2) / Math.PI);
  app.dispose();
  app.dispose();
  assert.deepEqual([material.lightMap, material.lightMapIntensity, material.lightMapResponse], [null, 0.5, 'multiply']);
  // A legacy bake multiplies, unlit shading included.
  const unlit = new UnlitMaterial();
  using _ = applyLightmap(unlit, atlas);
  assert.deepEqual([unlit.lightMapResponse, unlit.lightMapIntensity], ['multiply', atlas.lightmapScale]);
});

test('a later lightMap is not undone by disposing an older application', () => {
  const material = new LambertMaterial(),
    first = applyLightmap(material, atlas),
    second = applyLightmap(material, meshBake);
  first.dispose();
  assert.equal(material.lightMap, second.texture);
  second.dispose();
  // R5: the second used to give back what it found, the first (already disposed) application's lightmap.
  assert.deepEqual(
    [material.lightMap, material.lightMapIntensity, material.lightMapResponse],
    [null, 1, 'multiply'],
    'disposing both in any order gives back the material as it was',
  );
  // Newest first restores each step; a manual lightMap set after an application is never undone.
  const a = applyLightmap(material, atlas),
    b = applyLightmap(material, meshBake);
  b.dispose();
  assert.equal(material.lightMap, a.texture);
  a.dispose();
  assert.equal(material.lightMap, null);
  const c = applyLightmap(material, atlas),
    own = lightmapTexture(meshBake).texture;
  material.lightMap = own;
  c.dispose();
  assert.equal(material.lightMap, own);
});

test('dispose frees the GPU copy of the texture an application made', () => {
  const material = new LambertMaterial(),
    app = applyLightmap(material, atlas);
  let freed = 0;
  const free = app.texture.dispose.bind(app.texture);
  app.texture.dispose = () => {
    freed++;
    free();
  };
  app.dispose();
  app.dispose();
  assert.equal(freed, 1);
});

test('bad input is refused before any material changes', () => {
  const lit = new PbrMaterial(),
    unlit = new UnlitMaterial();
  assert.throws(() => applyLightmap(unlit, meshBake), /lit shading/);
  assert.equal(unlit.lightMap, null);
  assert.throws(() => applyLightmap(lit, atlas, { intensity: -1 }), RangeError);
  assert.throws(() => applyLightmap(lit, atlas, { intensity: Number.NaN }), RangeError);
  assert.throws(() => applyLightmap(lit, atlas, { response: 'add' }), TypeError);
  assert.throws(
    () => applyLightmap(lit, { width: 2, height: 2, lightmap: new Uint8Array(3), lightmapScale: 1 }),
    /a bake/,
  );
  assert.throws(() => applyLightmap(lit, { ...atlas, lightmapScale: 0 }), /a bake/);
  assert.throws(() => applyLightmap({}, atlas), /Material, a materials or glTF PBR mesh or a core Mesh/);
  assert.throws(() => applyLightmap(null, atlas), TypeError);
  assert.equal(lit.lightMap, null);
});

// KB-OWN-LIGHTMAP1: a device restore gives the engine a new GPUDevice, and WebGPU objects are valid only with the
// device that made them (W3C WebGPU, section 3.2.1). The model's extension kept the attach-time device's view and
// sampler, so the model's restore bound them on the new device and failed validation. Each fake object names its device.
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
const fakeDevice = () => {
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    features: new Set(),
    lost: new Promise(() => {}),
    createTexture: (d) => ({
      device,
      format: d.format,
      dimension: '2d',
      width: d.size[0],
      height: d.size[1],
      depthOrArrayLayers: 1,
      mipLevelCount: d.mipLevelCount ?? 1,
      usage: d.usage,
      createView: () => ({ device }),
      destroy() {},
    }),
    createSampler: (d) => ({ device, ...d }),
    queue: { writeTexture() {}, copyExternalImageToTexture() {} },
  };
  return device;
};
const fakeModel = (engine) => {
  const primitive = { material: { name: 'grey' } };
  return {
    primitive,
    model: { disposed: false, root: { engine }, primitives: [primitive], onDispose: () => () => {} },
  };
};

test('a lit glTF PBR model binds its lightmap on the device drawing it, also after a device restore', () => {
  const first = fakeDevice(),
    second = fakeDevice(),
    engine = { gpu: first },
    { primitive, model } = fakeModel(engine),
    own = primitive.material,
    app = applyLightmap(model, meshBake),
    extension = primitive.material.extension;
  assert.notEqual(primitive.material, own);
  let [{ view, sampler }] = extension.textures;
  assert.equal(view.device, first);
  assert.equal(sampler.device, first);
  assert.equal(sampler.addressModeU, 'clamp-to-edge');
  assert.equal(sampler.magFilter, 'linear');
  // The restore: the engine draws with a new device and the model derives its draws again.
  engine.gpu = second;
  [{ view, sampler }] = extension.textures;
  assert.equal(view.device, second, 'the view is made on the restored device');
  assert.equal(sampler.device, second, 'the sampler is made on the restored device');
  assert.equal(sampler.addressModeV, 'clamp-to-edge');
  app.dispose();
  assert.equal(primitive.material, own);
});

test("a live bake's texture went with its device: a restored model binds a black texture of the new device", () => {
  const first = fakeDevice(),
    second = fakeDevice(),
    engine = { gpu: first },
    { primitive, model } = fakeModel(engine),
    live = { device: first, texture: first.createTexture({ size: [4, 4], format: 'rgba16float', usage: 4 }) },
    app = applyLightmap(model, live),
    extension = primitive.material.extension;
  assert.equal(extension.textures[0].view.device, first);
  engine.gpu = second;
  assert.equal(extension.textures[0].view.device, second);
  assert.equal(extension.textures[0].sampler.device, second);
  app.dispose();
});

// Batch 54 gap: a directional bake had no GPU shader (only the CPU directionalIrradiance). On a glTF PBR model it now
// binds its direction and directional colour maps beside the lightmap and draws directionalIrradiance per pixel.
const directionalBake = await bakeDirectionalLightmap(
  {
    positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
    uv1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  },
  { width: 8, lights, radiometry: 'physical' },
);

test('a directional bake on a glTF PBR model draws its direction and colour maps with the mapped normal', () => {
  const engine = { gpu: fakeDevice() },
    { primitive, model } = fakeModel(engine),
    own = primitive.material,
    app = applyLightmap(model, directionalBake, { intensity: 2 }),
    extension = primitive.material.extension;
  assert.equal(app.directional, true);
  assert.equal(extension.textures.length, 3, 'lightmap, direction and directional colour');
  for (const { view, sampler } of extension.textures) {
    assert.equal(view.device, engine.gpu);
    assert.equal(sampler.addressModeU, 'clamp-to-edge');
  }
  assert.match(extension.wgsl, /materialTexture1/);
  assert.match(extension.wgsl, /dot\(lmN,lmD\)/, 'the mapped normal reads the main direction');
  const lambert = 2 / Math.PI;
  assert.ok(Math.abs(extension.factors[0] - directionalBake.lightmapScale * lambert) < 1e-6);
  assert.ok(Math.abs(extension.factors[1] - directionalBake.directionalScale * lambert) < 1e-6);
  app.dispose();
  assert.equal(primitive.material, own);
});

test('directional: false draws a directional bake flat, and other targets refuse directional: true', () => {
  const engine = { gpu: fakeDevice() },
    { primitive, model } = fakeModel(engine);
  let app = applyLightmap(model, directionalBake, { directional: false });
  assert.equal(app.directional, false);
  assert.equal(primitive.material.extension.textures.length, 1);
  assert.equal(primitive.material.extension.factors[1], 0);
  app.dispose();
  // A materials target draws the flat lightmap: the same light at the vertex normal.
  const material = new PbrMaterial();
  app = applyLightmap(material, directionalBake);
  assert.equal(app.directional, false);
  app.dispose();
  assert.throws(() => applyLightmap(material, directionalBake, { directional: true }), /glTF PBR models only/);
  assert.throws(() => applyLightmap(model, meshBake, { directional: true }), /bakeDirectionalLightmap result/);
  assert.throws(() => applyLightmap(model, directionalBake, { directional: 1 }), TypeError);
  assert.throws(
    () => applyLightmap(model, { ...directionalBake, directionMap: new Uint8Array(4) }),
    /malformed directional bake/,
  );
  assert.equal(material.lightMap, null);
});
