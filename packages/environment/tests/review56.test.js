import test from 'node:test';
import assert from 'node:assert/strict';
import { engine, calls, scissors } from '../../../tests/support/review56-engine.js';
import { Reflector } from '../dist/reflector.js';
import { studio } from '../dist/studio.js';
test('review: mirror draw applies independent viewport and scissor', async (t) => {
  const e = await engine(t),
    floor = Reflector.attach(e, { width: 8, height: 8, roughness: 0.4, autoUpdate: false });
  floor.update();
  e.gpu.createBindGroupLayout = () => ({});
  e.gpu.createPipelineLayout = () => ({});
  calls.length = 0;
  scissors.length = 0;
  e.render({ views: [{ camera: e.camera, viewport: [0, 0, 200, 200], pixels: true, scissor: [0, 0, 100, 200] }] });
  const row = {
    viewport: calls.filter((c) => c.label === floor.name),
    scissor: scissors.filter((c) => c.label === floor.name),
  };
  console.log('MIRROR_RECT', JSON.stringify(row));
  assert.deepEqual(
    row.viewport.map((v) => v.args),
    [[0, 0, 200, 200, 0, 1]],
  );
  assert.deepEqual(
    row.scissor.map((v) => v.args),
    [[0, 0, 100, 200]],
  );
});
test('review: finite overflowed studio direction preserves the softbox', () => {
  const base = { width: 16, floor: [0, 0, 0], walls: [0, 0, 0], ceiling: [0, 0, 0] },
    light = { direction: [1, 1, 0], width: 1, height: 1, intensity: 1 };
  const peak = (direction) =>
    Math.max(...studio({ ...base, lights: [{ ...light, direction }] }).data.filter((v, i) => i % 4 !== 3));
  const row = { normal: peak([1, 1, 0]), extreme: peak([Number.MAX_VALUE, Number.MAX_VALUE, 0]) };
  assert.equal(row.normal, 1);
  assert.equal(row.extreme, 1);
  console.log('STUDIO_DIRECTION', JSON.stringify(row));
});
