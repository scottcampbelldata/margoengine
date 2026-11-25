// KB-RESTORE-BORROWED1 for the post effects that take a caller's texture (Lens dirt, LensFlare element texture,
// MaterialDecals atlas; Decals is in decals.test.js): a plain texture belongs to the device that made it, so after a
// device restore nothing of it is bound, `engine.onError` hears of it once ('state', #borrowed-lost) and the effect
// draws what it draws without the image; a new texture, or a `(device) => texture` function (made once per device),
// brings it back with no report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lens } from '@margoengine/post/lens';
import { MaterialDecals } from '@margoengine/post/material-decals';
import { LensFlare, PostStack } from '../dist/index.js';
import { harness, modules, written } from './support.js';

const usage = 4;
const watched = (device, viewed, name) => {
  const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage }),
    createView = texture.createView;
  texture.createView = (d) => (viewed.push(name), createView(d));
  return texture;
};
const lost = (errors) => errors.filter((e) => /borrowed-lost/.test(e.message));

test('Lens dirt across a device restore: a plain image is dropped and reported once, a function image is remade', () => {
  const viewed = [],
    h = harness(),
    errors = [],
    plain = watched(h.gpu.device, viewed, 'plain'),
    effect = new Lens({ dirt: plain });
  h.engine.onError = (e) => errors.push(e);
  h.engine.use(new PostStack([effect]));
  const custom = (log) => written(log, 1024)[3 * 64 + 7];
  assert.equal(custom(h.gpu.record(() => h.frame())), 1, 'custom dirt before the loss');
  assert.deepEqual(viewed, ['plain']);
  const g1 = h.lose();
  assert.equal(custom(g1.record(() => h.frame())), 0, 'the built-in smudges draw, as with no dirt');
  h.frame();
  assert.deepEqual(viewed, ['plain'], 'nothing of the lost image is bound');
  assert.equal(lost(errors).length, 1, 'reported once');
  assert.equal(errors[0].code, 'state');
  assert.match(errors[0].message, /Lens dirt lost with the device; pass a function or call set options\.dirt/);
  assert.equal(plain.destroyed, undefined, 'borrowed, never destroyed');
  effect.options.dirt = watched(g1.device, viewed, 'again');
  assert.equal(custom(g1.record(() => h.frame())), 1, 'a new image brings it back');
  const made = [];
  effect.options.dirt = (device) => (made.push(device), watched(device, viewed, 'made' + made.length));
  assert.equal(custom(g1.record(() => h.frame())), 1);
  h.frame();
  assert.equal(made.length, 1, 'made once per device');
  const g2 = h.lose();
  assert.equal(custom(g2.record(() => h.frame())), 1, 'the function image is back after the second restore');
  assert.deepEqual(made, [g1.device, g2.device]);
  assert.equal(lost(errors).length, 1, 'no report for the function form');
  assert.throws(() => new Lens({ dirt: {} }), /GPUTexture of the engine device or \(device\)/);
});

test('LensFlare element textures across a device restore: a plain image draws nothing and is reported once, a function image is remade', () => {
  const viewed = [],
    h = harness(),
    errors = [],
    plain = watched(h.gpu.device, viewed, 'plain'),
    elements = [
      { texture: plain, size: 100 },
      { size: 60, distance: 0.6 },
    ],
    flare = new LensFlare({ position: () => [0, 6, 0], elements });
  h.engine.onError = (e) => errors.push(e);
  h.engine.use(new PostStack([flare]));
  const images = (log) =>
    modules(log)
      .find((m) => m.includes('var<storage,read> elements'))
      ?.includes('image0');
  assert.equal(images(h.gpu.record(() => h.frame())), true);
  assert.deepEqual(viewed, ['plain']);
  const g1 = h.lose();
  let log = g1.record(() => h.frame());
  assert.equal(images(log), false, 'no image binding for the lost texture');
  assert.deepEqual([...written(log, 64).subarray(4, 7)], [0, 0, 0], 'its glow carries no light');
  assert.deepEqual([...written(log, 64).subarray(12, 15)], [1, 1, 1], 'the other element is untouched');
  h.frame();
  assert.deepEqual(viewed, ['plain'], 'nothing of the lost image is bound');
  assert.equal(lost(errors).length, 1, 'reported once');
  assert.match(errors[0].message, /LensFlare element texture lost with the device/);
  // A new texture on the element brings it back (elements rebuilt every frame keep their device).
  const again = watched(g1.device, viewed, 'again');
  elements[0] = { texture: again, size: 100 };
  log = g1.record(() => h.frame());
  assert.equal(images(log), true);
  assert.deepEqual(viewed.slice(-1), ['again']);
  const made = [];
  const fn = (device) => (made.push(device), watched(device, viewed, 'made' + made.length));
  elements[0] = { texture: fn, size: 100 };
  g1.record(() => h.frame());
  h.frame();
  assert.equal(made.length, 1, 'made once per device');
  const g2 = h.lose();
  assert.equal(images(g2.record(() => h.frame())), true);
  assert.deepEqual(made, [g1.device, g2.device]);
  assert.equal(lost(errors).length, 1, 'no report for the function form');
  assert.throws(() => new LensFlare({ elements: [{ size: 10, texture: {} }] }), RangeError);
});

test('MaterialDecals atlas across a device restore: a plain one applies no decal and is reported once, a function one is remade', () => {
  const viewed = [],
    h = harness(),
    errors = [],
    surface = () => h.gpu.device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage }),
    layers = { albedo: surface(), normal: surface(), material: surface() },
    plain = watched(h.gpu.device, viewed, 'plain'),
    effect = new MaterialDecals({ targets: () => layers, atlas: plain });
  h.engine.onError = (e) => errors.push(e);
  h.engine.use(new PostStack([effect]));
  effect.setDecals([{ position: [0, 0, 0], direction: [0, -1, 0], width: 1, height: 1 }]);
  const count = (log) => written(log, (36 + 24) * 4)[32];
  assert.equal(count(h.gpu.record(() => h.frame())), 1);
  assert.deepEqual(viewed, ['plain']);
  const g1 = h.lose();
  assert.equal(count(g1.record(() => h.frame())), 0, 'no decal applies without its atlas');
  h.frame();
  assert.deepEqual(viewed, ['plain'], 'nothing of the lost atlas is bound');
  assert.equal(lost(errors).length, 1, 'reported once');
  assert.match(
    errors[0].message,
    /MaterialDecals atlas lost with the device; pass a function or call set options\.atlas/,
  );
  effect.options.atlas = watched(g1.device, viewed, 'again');
  assert.equal(count(g1.record(() => h.frame())), 1, 'a new atlas brings the decals back');
  const made = [];
  effect.options.atlas = (device) => (made.push(device), watched(device, viewed, 'made' + made.length));
  assert.equal(count(g1.record(() => h.frame())), 1);
  h.frame();
  assert.equal(made.length, 1, 'made once per device');
  const g2 = h.lose();
  assert.equal(count(g2.record(() => h.frame())), 1);
  assert.deepEqual(made, [g1.device, g2.device]);
  assert.equal(lost(errors).length, 1, 'no report for the function form');
  effect.options.atlas = undefined;
  assert.equal(count(g2.record(() => h.frame())), 1, 'the flat default atlas');
});

test('TextureOverlay source across a device restore: a plain texture is not bound and is reported once, setSource brings it back', async () => {
  const { TextureOverlay } = await import('@margoengine/post/overlays');
  const viewed = [],
    h = harness(),
    errors = [],
    plain = watched(h.gpu.device, viewed, 'plain'),
    effect = TextureOverlay.attach(h.engine, { source: plain });
  h.engine.onError = (e) => errors.push(e);
  const opacity = (log) => written(log, 256)[0];
  assert.equal(opacity(h.gpu.record(() => h.frame())), 1, 'the texture draws before the loss');
  assert.deepEqual(viewed, ['plain']);
  const g1 = h.lose();
  assert.equal(opacity(g1.record(() => h.frame())), 0, 'the frame passes through');
  h.frame();
  assert.deepEqual(viewed, ['plain'], 'nothing of the lost texture is bound');
  assert.equal(lost(errors).length, 1, 'reported once');
  assert.equal(errors[0].code, 'state');
  assert.match(errors[0].message, /TextureOverlay source lost with the device; pass a function or call setSource/);
  assert.equal(plain.destroyed, undefined, 'borrowed, never destroyed');
  assert.equal(effect.setSource(watched(g1.device, viewed, 'again')), effect);
  assert.equal(opacity(g1.record(() => h.frame())), 1, 'a new texture brings it back');
  assert.deepEqual(viewed.slice(-1), ['again']);
  effect.options.source = watched(g1.device, viewed, 'assigned');
  assert.equal(opacity(g1.record(() => h.frame())), 1, 'a texture assigned onto the options is taken too');
  assert.deepEqual(viewed.slice(-1), ['assigned']);
  let current = watched(g1.device, viewed, 'getter');
  effect.setSource(() => current);
  const g2 = h.lose();
  current = watched(g2.device, viewed, 'getter2');
  assert.equal(opacity(g2.record(() => h.frame())), 1, 'a function source is read every frame');
  assert.equal(lost(errors).length, 1, 'no report for the function form');
  assert.throws(() => effect.setSource({}), TypeError);
  effect.dispose();
});
