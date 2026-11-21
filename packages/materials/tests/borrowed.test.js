// The borrowed-object rule (docs/conventions.md, KB-RESTORE-BORROWED1) on the CPU: the options of this package that
// take a caller's GPU object also take `(device) => object`. The device restore itself is pinned on a real GPU by
// test/borrowed-restore-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial, Texture, transmission } from '../dist/index.js';

const fake = (extra = {}) => ({
  createView: () => ({}),
  mipLevelCount: 1,
  depthOrArrayLayers: 1,
  dimension: '2d',
  width: 4,
  height: 4,
  format: 'rgba8unorm',
  ...extra,
});

test('a Texture takes a function source, sizes unknown until a device has made one', () => {
  const texture = new Texture(() => fake(), { dimension: '2d' });
  assert.equal(texture.dimension, '2d');
  assert.equal(texture.width, 0);
  assert.equal(new Texture(fake()).width, 4);
  assert.equal(new Texture(() => fake({ depthOrArrayLayers: 6 }), { dimension: 'cube' }).dimension, 'cube');
});

test('Texture.setSource replaces a GPU source and refuses other textures', () => {
  const texture = new Texture(fake());
  texture.setSource(() => fake({ width: 8 }));
  texture.setSource(fake({ width: 16 }));
  assert.equal(texture.width, 16);
  assert.throws(() => new Texture({ data: new Uint8Array(16), width: 2, height: 2 }).setSource(fake()), TypeError);
  assert.throws(() => texture.setSource({}), TypeError);
});

test('Material.envMap takes a function, a plain target and a GPUTexture, and refuses a bare object', () => {
  const material = new PbrMaterial();
  const cube = fake({ depthOrArrayLayers: 6 });
  const read = (value) => ((material.envMap = value), material.envMap);
  const target = { texture: cube, view: {} };
  const make = () => target;
  assert.equal(read(make), make);
  assert.equal(read(target), target);
  assert.equal(read(cube), cube);
  assert.equal(read(null), null);
  assert.throws(() => read({}), /Material envMap must be/);
});

test('transmission keeps an opaqueColor function for gltf/pbr to call once per device', () => {
  const view = () => ({});
  const extension = transmission({ factor: 1, opaqueColor: view });
  assert.equal(extension.textures[0].view, view);
});
