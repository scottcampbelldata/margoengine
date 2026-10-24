import test from 'node:test';
import assert from 'node:assert/strict';
import { conveyorScene, ENTITY_COUNT } from '../examples/benchmark/conveyor-scene.js';
test('benchmark engines share exactly 12,014 entities with valid parents and 3,000 animated shafts', () => {
  const scene = conveyorScene();
  assert.equal(scene.nodes.length, ENTITY_COUNT);
  assert.equal(scene.shafts.length, 3000);
  for (let i = 0; i < scene.nodes.length; i++) assert.ok(scene.nodes[i].parent < i);
  assert.equal(scene.cylinder.normals.length, scene.cylinder.positions.length);
  assert.ok(scene.cylinder.indices.every((index) => index < scene.cylinder.positions.length / 3));
});
