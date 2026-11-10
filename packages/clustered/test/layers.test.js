import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { LightLayers } from '../dist/layers.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// A receiver that keeps the lighting it is given, as gltf-pro models do.
const receiver = () => {
  const r = {
    effects: new Set(),
    addLighting(effect) {
      r.effects.add(effect);
      return () => r.effects.delete(effect);
    },
  };
  return r;
};
const one = (r) => [...r.effects][0];

// The WGSL clusterLayer, mirrored: light index -> 1 when the light's mask (1 past the list) shares a bit with the receiver's.
const layer = (words, index, receiverMask) => {
  const count = words[0],
    m = index < count ? words[4 + Math.min(index, Math.max(count, 1) - 1)] : 1;
  return (m & receiverMask) >>> 0 !== 0 ? 1 : 0;
};

test('a light shades a receiver exactly when their masks share a bit; lights past the list are on layer 0', () => {
  const layers = new LightLayers({ lights: { setLights() {}, add() {} } });
  layers.setLayers([2, null, 0, 0xffffffff, 5]);
  const words = layers['words'];
  assert.deepEqual([...words.subarray(0, 1)], [5]);
  const cases = [
    // [light, receiver mask, lit]
    [0, 1, 0], // rim light on layer 1 does not light the set (core meshes and default receivers, mask 1)
    [0, 3, 1], // the hero on layers 0 and 1 sees it
    [1, 1, 1], // null: layer 0
    [2, 0xffffffff, 0], // mask 0 lights nothing
    [3, 0x80000000, 1], // bit 31
    [4, 4, 1],
    [4, 2, 0],
    [9, 1, 1], // past the list: layer 0
    [9, 2, 0],
  ];
  for (const [index, mask, lit] of cases)
    assert.equal(layer(words, index, mask), lit, `light ${index} receiver ${mask}`);
});

test('LightLayers validates masks and receivers before changing anything', () => {
  const layers = new LightLayers({ lights: { setLights() {}, add: () => () => {} } });
  layers.setLayers([2]);
  const before = layers['words'].slice();
  for (const bad of [[-1], [1.5], [2 ** 32], ['2'], new Array(1025).fill(1)])
    assert.throws(() => layers.setLayers(bad), RangeError);
  assert.deepEqual(layers['words'], before);
  const r = receiver();
  assert.throws(() => layers.add(r, { layers: -1 }), RangeError);
  assert.throws(() => layers.add({}), TypeError);
  layers.add(r, { layers: 2 });
  assert.throws(() => layers.add(r), TypeError, 'duplicate');
  assert.throws(() => new LightLayers({}), TypeError);
});

test('LightLayers add clusterLayer, binding 154 and the receiver mask only while masks change what is lit', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([
    { position: [0, 2, 1], range: 6 },
    { position: [1, 2, 0], range: 6 },
  ]);
  h.engine.use(lights);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return { shader: h.context.shader, bindings: h.context.bindings.map((b) => b.binding) };
  };
  try {
    const plain = frame(),
      buffers = h.counts.buffers;
    const layers = new LightLayers({ lights });
    h.engine.use(layers);
    layers.setLayers([1, null]);
    const set = receiver(),
      removeSet = layers.add(set);
    assert.deepEqual(frame(), plain, 'every mask 1: nothing changes');
    assert.equal(h.counts.buffers, buffers);
    assert.equal(one(set).pbr(2).light, lights.pbr(2).light, 'a layer-0 receiver gets the plain call');
    layers.setLayers([1, 2]);
    const lit = frame();
    assert.match(lit.shader, /@binding\(154\) var<storage,read> clusterLayerData/);
    assert.ok(lit.shader.includes('*clusterLayer(index)'));
    assert.deepEqual(lit.bindings, [...plain.bindings, 154]);
    const buffer = layers.bindings()[0].resource.buffer;
    assert.deepEqual([...new Uint32Array(buffer.data, 0, 6)], [2, 0, 0, 0, 1, 2]);
    // Receivers: the set on layer 0 calls the masked loop with 1, the hero on layers 0 and 1 with 3.
    const hero = receiver(),
      removeHero = layers.add(hero, { layers: 3 });
    assert.ok(one(set).pbr(2).light.startsWith('clusterLightingLayers(1u,i.clip.xy,'));
    assert.ok(one(hero).pbr(2).light.startsWith('clusterLightingLayers(3u,i.clip.xy,'));
    assert.equal(one(hero).pbr(2), one(hero).pbr(2), 'the masked hook is cached');
    assert.deepEqual(one(hero).bindings(), lights.bindings());
    const patched = one(hero).shader(wgsl, 0);
    assert.ok(patched.includes('clusterLightingLayers(3u,i.clip.xy,'));
    assert.ok(patched.includes('fn clusterLighting(pixel'), 'the definition is kept');
    // Core meshes (the frame's own shader) stay on layer 0: the private mask's default.
    assert.ok(lit.shader.includes('var<private> clusterLayerMask=1u;'));
    layers.setLayers([]);
    assert.notDeepEqual(frame(), plain, 'a receiver off layer 0 alone keeps the masks');
    removeHero();
    assert.equal(hero.effects.size, 0);
    assert.deepEqual(frame(), plain, 'no masks and only layer-0 receivers');
    assert.equal(one(set).pbr(2).light, lights.pbr(2).light);
    layers.setLayers([2]);
    layers.dispose();
    assert.ok(buffer.destroyed);
    assert.equal(lights.layers, undefined);
    assert.equal(set.effects.size, 0, 'dispose removes the receivers');
    removeSet();
    assert.deepEqual(frame(), plain, 'disposed');
  } finally {
    lights.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

// Regression: layers first took binding 155 (the shadow atlas) and then 152 (cube cookies), both in the same lit-shader group.
test('the layer mask binding is used by no other clustered source', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../src/', import.meta.url),
    users = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) =>
        /BINDING = 154\b|binding\(154\)|binding: ?154\b/.test(readFileSync(new URL(name, dir), 'utf8')),
      );
  assert.deepEqual(users, ['layers.ts']);
});
