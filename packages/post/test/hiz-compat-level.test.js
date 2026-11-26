import test from 'node:test';
import assert from 'node:assert/strict';
import { PostStack, SSR, SSGI } from '../dist/index.js';
import { harness } from './support.js';

// A dispatch or draw at WebGPU's compatibility level may not bind two views of one texture. SSR and SSGI built their
// Hi-Z pyramid by reading mip i-1 and writing mip i of one r32float texture in each dispatch, so on such a device every
// frame failed validation (Chrome: "must not have different views in a single draw/dispatch command"). At that level each
// Hi-Z level now reduces into a texture of its own and is copied into its mip of the pyramid; at the full level the
// reduction stays in place. Real devices: rt-gi-browser.mjs and rt-reflections-browser.mjs --mode=compatibility.
function tracked(features) {
  const h = harness({ samples: 1 }),
    device = h.gpu.device,
    parent = new WeakMap(),
    groups = [];
  device.features = features;
  const createTexture = device.createTexture;
  device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor),
      createView = texture.createView;
    texture.createView = (d) => {
      const view = createView(d);
      parent.set(view, texture);
      return view;
    };
    return texture;
  };
  const createBindGroup = device.createBindGroup;
  device.createBindGroup = (descriptor) => {
    groups.push(descriptor.entries.map((entry) => parent.get(entry.resource)).filter(Boolean));
    return createBindGroup(descriptor);
  };
  return { h, groups };
}

for (const [name, Effect] of [
  ['SSR', SSR],
  ['SSGI', SSGI],
]) {
  test(`${name} binds no texture twice in one group at the compatibility level, and copies its Hi-Z levels`, () => {
    const { h, groups } = tracked(new Set());
    h.engine.use(new PostStack([new Effect()]));
    const log = h.gpu.record(() => h.frame());
    assert.ok(groups.length > 0);
    for (const textures of groups) assert.equal(new Set(textures).size, textures.length, 'one view per texture');
    const copies = log.filter((e) => e[0] === 'copyTextureToTexture');
    assert.ok(copies.length > 0, 'the levels are copied into the pyramid');
    assert.deepEqual(
      copies.map((e) => e[2].mipLevel),
      copies.map((_, i) => i),
      'one copy per level, in order',
    );
    h.engine.removePlugin('post:stack');
  });

  test(`${name} at the full level reduces the Hi-Z in place, with no copies`, () => {
    const { h } = tracked(new Set(['core-features-and-limits']));
    h.engine.use(new PostStack([new Effect()]));
    const log = h.gpu.record(() => h.frame());
    assert.equal(log.filter((e) => e[0] === 'copyTextureToTexture').length, 0);
    assert.ok(log.some((e) => e[0] === 'pass.dispatchWorkgroups'));
    h.engine.removePlugin('post:stack');
  });
}
