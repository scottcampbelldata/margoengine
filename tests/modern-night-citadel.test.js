import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCitadel,
  moonDirection,
  moonShadowMatrix,
} from '../apps/showcase-night-citadel/src/scene.js';

test('citadel produces deterministic instanced six-float geometry with finite unit normals', () => {
  const scene = createCitadel(),
    again = createCitadel();
  assert.equal(scene.length, 7);
  assert(scene.reduce((count, b) => count + b.count, 0) > 350);
  for (let i = 0; i < scene.length; i++) {
    const { geometry, instances, count } = scene[i];
    assert.equal(instances.length, count * 24);
    assert.equal(geometry.vertices.length % 6, 0);
    assert.deepEqual(instances, again[i].instances);
    assert.deepEqual(geometry.vertices, again[i].geometry.vertices);
    assert(instances.every(Number.isFinite));
    assert(geometry.vertices.every(Number.isFinite));
    for (let j = 0; j < geometry.vertices.length; j += 6)
      assert(
        Math.abs(Math.hypot(...geometry.vertices.subarray(j + 3, j + 6)) - 1) <
          1e-6,
      );
    for (const index of geometry.indices)
      assert(index < geometry.vertices.length / 6);
    for (let j = 0; j < count; j++) assert.equal(instances[j * 24 + 15], 1);
  }
  assert(
    scene[3].geometry.indices.length > 100,
    'buttresses have open curved ribs',
  );
  assert(scene[4].geometry.bounds[1] < -15, 'cliff descends into the haze');
  const lanterns = scene[6],
    masonry = scene[0].instances;
  assert.equal(
    lanterns.count,
    Array.from(
      { length: scene[0].count },
      (_, i) => masonry[i * 24 + 20],
    ).filter((value) => value > 0).length,
  );
  assert(lanterns.glow && scene.slice(0, 6).every((batch) => !batch.glow));
  assert.equal(lanterns.geometry.indices.length, 6, 'one quad per lit window');
});

test('moon angles produce matching finite Reversed-Z shadow projections at both elevation limits', () => {
  const direction = [0, 0, 0],
    matrix = new Float32Array(16);
  for (const elevation of [5, 24, 85])
    for (const azimuth of [0, 90, 180, 270, 360]) {
      moonDirection(direction, azimuth, elevation);
      assert(Math.abs(Math.hypot(...direction) - 1) < 1e-12);
      assert(
        Math.abs(direction[1] - Math.sin((elevation * Math.PI) / 180)) < 1e-12,
      );
      moonShadowMatrix(matrix, direction);
      assert(matrix.every(Number.isFinite));
      const centerDepth = 10 * matrix[6] + matrix[14];
      assert(centerDepth > 0 && centerDepth < 1);
      const towardMoon =
        matrix[2] * direction[0] +
        matrix[6] * direction[1] +
        matrix[10] * direction[2];
      assert(towardMoon > 0, 'closer lunar surfaces have greater depth');
      assert(
        Math.abs(10 * matrix[5] + matrix[13]) < 1e-6,
        'light frustum remains centered on the keep',
      );
    }
  assert.throws(() => moonDirection(direction, 0, 0), /Invalid moon angles/);
  assert.throws(() => moonDirection(direction, NaN, 45), /Invalid moon angles/);
});
