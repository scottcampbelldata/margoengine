import test from 'node:test';
import assert from 'node:assert/strict';
import { GPUParticles } from '../dist/particles.js';
import { VFX } from '@margoengine/vfx';

test('GPUParticles is a VFX preset: a wrapping 6 m leaf field with the old option names', () => {
  const obstacles = [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }];
  const leaves = new GPUParticles({
    count: 200,
    gravity: [0, -1, 0],
    wind: [0.5, 0, 0.25],
    size: 0.05,
    curl: 0.2,
    sort: true,
    obstacles,
  });
  assert.ok(leaves instanceof VFX);
  assert.equal(leaves.name, 'gpu-particles');
  assert.equal(leaves.count, 200);
  const o = leaves.options;
  assert.deepEqual(
    [o.capacity, o.initialCount, o.rate, o.wrap, o.sort, o.obstacles],
    [200, 200, 0, true, true, obstacles],
  );
  assert.deepEqual(o.gravity, [0.5, -1, 0.25], 'wind folds into the constant acceleration');
  assert.deepEqual([o.size, o.turbulence], [0.1, 0.2], 'size is the old half-width');
  assert.throws(() => new GPUParticles({ curl: 11 }), /options/);
  assert.throws(() => new GPUParticles({ count: 0 }), /options/);
});
