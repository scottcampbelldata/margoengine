import assert from 'node:assert/strict';
import test from 'node:test';
import { cosineRays, traceOcclusion, sphereOcclusion, groundAt, CONTACT_SCENE } from '../scripts/contact-reference.mjs';

test('cosine ray tracer agrees with the projected solid angle of a sphere', () => {
  const rays = cosineRays(65536),
    center = [0, 0.5, 0],
    radius = 0.5;
  for (const p of [
    [0, 0, 0],
    [0.6, 0, 0],
    [1, 0, 0],
    [0, 0, -1],
    [2, 0, 1],
  ]) {
    const truth = sphereOcclusion(p, center, radius);
    assert.ok(Math.abs(traceOcclusion(p, center, radius, rays) - truth) < 0.001);
  }
  assert.equal(traceOcclusion([0, 0, 0], [0, -2, 0], 0.5, rays), 0);
});

test('reference pixels are centered in the world-space shadow plane', () => {
  assert.deepEqual(groundAt(CONTACT_SCENE, 0, 0), [-1.984375, 0, -1.984375]);
  for (const ray of cosineRays(256)) {
    assert.ok(ray[1] > 0);
    assert.ok(Math.abs(Math.hypot(...ray) - 1) < 1e-12);
  }
});
