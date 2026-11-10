// ./apply without a GPU: a bake becomes a linear lightmap texture with its decode scale, Material targets get and give
// back their lightMap settings, and bad input is refused before anything changes. Drawing is in tests/gpu.browser.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LambertMaterial, PbrMaterial, UnlitMaterial } from '@margoengine/materials';
import { applyLightmap, lightmapTexture } from '../dist/apply.js';
import { bakeLightmap } from '../dist/index.js';
import { bakeMeshLightmap } from '../dist/mesh.js';

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
  assert.equal(material.lightMap, first.texture, 'the second gives back what it found');
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
  assert.throws(() => applyLightmap({}, atlas), /Material, a materials or glTF-pro mesh or a core Mesh/);
  assert.throws(() => applyLightmap(null, atlas), TypeError);
  assert.equal(lit.lightMap, null);
});
