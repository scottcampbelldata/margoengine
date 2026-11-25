import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Geometry } from '@margoengine/core';
import { InteractionPrompt, center, float, resize, screenSizeScale, worldBounds } from '../dist/helpers.js';

const make = async () =>
  new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(16), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
// A box from (0,0,0) to (2,4,6) as three triangles' worth of corner vertices is enough for bounds.
const box = () =>
  new Geometry(
    [0, 0, 0, 2, 0, 0, 0, 4, 0, 2, 4, 6, 0, 0, 6, 2, 0, 6],
    [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    [0, 1, 2, 3, 4, 5],
  );
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${a} vs ${b}`));

test('worldBounds reads vertices through the world matrix; center, resize and float move the mesh', async () => {
  using e = await make();
  const root = e.createMesh();
  const child = e.createMesh(root).setGeometry(box());
  assert.equal(worldBounds(e.createMesh()), null, 'a mesh without geometry has no bounds');
  let b = worldBounds(root);
  near(b.min, [0, 0, 0]);
  near(b.max, [2, 4, 6]);
  child.position.set(1, 0, 0);
  root.scale.set(2, 2, 2);
  b = worldBounds(root);
  near(b.min, [2, 0, 0]);
  near(b.max, [6, 8, 12]);

  const moved = center(root);
  near(moved.min, [-2, -4, -6]);
  near(moved.max, [2, 4, 6]);
  center(root, { align: { y: 'min' }, target: [10, 0, 0] });
  near(worldBounds(root).min, [8, 0, -6]);
  assert.throws(() => center(root, { align: { x: 'left' } }), /min.*center.*max/);
  assert.equal(center(e.createMesh()), null);

  const factor = resize(root, 6);
  near([factor], [0.5], 'the longest side (12) goes to 6');
  near(
    [...worldBounds(root).max].map((v, i) => v - worldBounds(root).min[i]),
    [2, 4, 6],
  );
  assert.equal(resize(root, 4, { axis: 'y' }), 1);
  assert.throws(() => resize(root, 0), /positive/);
  assert.throws(() => resize(root, 1, { axis: 'w' }), /axis/);

  const m = e.createMesh();
  m.position.set(0, 5, 0);
  const floater = float(m, { floatIntensity: 2, offset: 1 });
  floater.update(3);
  assert.ok(Math.abs(m.position.y - 5) <= 0.2 + 1e-9 && m.position.y !== 5, 'bobs within the scaled range');
  assert.ok(m.rotation.x !== 0 || m.rotation.y !== 0);
  floater.update(3);
  const once = m.position.y;
  floater.update(3);
  assert.equal(m.position.y, once, 'a pure function of time');
  floater.dispose();
  assert.equal(m.position.y, 5);
  assert.equal(m.rotation.x, 0);
  floater.update(9);
  assert.equal(m.position.y, 5, 'a disposed floater writes nothing');
  assert.throws(() => float(m, { floatingRange: [1, 0] }), /floatingRange/);
});

test('screenSizeScale gives the world size of N pixels at a distance', () => {
  // fov 90 degrees: at distance d the view is 2d tall, so 360 of 720 pixels cover d world units.
  near([screenSizeScale({ distance: 10, fov: Math.PI / 2, viewportHeight: 720, pixels: 360 })], [10]);
  near([screenSizeScale({ distance: 5, fov: Math.PI / 2, viewportHeight: 100, pixels: 0 })], [0]);
  assert.throws(() => screenSizeScale({ distance: 0, fov: 1, viewportHeight: 10, pixels: 1 }), /positive/);
  assert.throws(() => screenSizeScale({ distance: 1, fov: 4, viewportHeight: 10, pixels: 1 }), /fov/);
});

test('InteractionPrompt shows after the threshold and hides at the first interaction', () => {
  const prompt = new InteractionPrompt({ threshold: 1000 });
  assert.equal(prompt.update(0), false);
  assert.equal(prompt.update(999), false);
  assert.equal(prompt.update(1000), true);
  prompt.interact(1200);
  assert.equal(prompt.visible, false);
  assert.equal(prompt.update(5000), false, 'once it has been used it stays hidden');
  const again = new InteractionPrompt({ threshold: 1000, repeat: true });
  again.update(0);
  again.update(1000);
  again.interact(1500);
  assert.equal(again.update(2499), false);
  assert.equal(again.update(2500), true, 'repeat waits a threshold after the last interaction');
  assert.throws(() => new InteractionPrompt({ threshold: -1 }), /threshold/);
  assert.throws(() => prompt.update(Number.NaN), /finite/);
});
