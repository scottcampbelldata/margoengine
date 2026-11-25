// A plugin marked `late` updates after every plugin without it, whatever order they were added in, and late plugins keep
// their own order: physics steps after the frame's animation (KB-PHYS-FRAMEORDER1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/index.js';
import { install } from './fake-gpu.js';

test('late plugins update after the others, whichever was added first, and in the order they were added among themselves', async () => {
  const gpu = install();
  try {
    const engine = await Engine.create(gpu.canvas, {
        capacity: 8,
        backend: 'webgl2',
        fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }),
      }),
      order = [],
      plugin = (name, late) => ({ name, late, setup() {}, onPreUpdate: () => order.push(name) });
    engine.use(plugin('physics', true));
    engine.use(plugin('animation', false));
    engine.use(plugin('soft', true));
    engine.use(plugin('ragdoll', false));
    engine.render();
    assert.deepEqual(order, ['animation', 'ragdoll', 'physics', 'soft']);
    order.length = 0;
    engine.removePlugin('animation');
    engine.use(plugin('animation', false));
    engine.render();
    assert.deepEqual(
      order,
      ['ragdoll', 'animation', 'physics', 'soft'],
      'a plugin added later still comes before the late ones',
    );
    engine.dispose();
  } finally {
    gpu.uninstall();
  }
});
