import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('initial population is emitted once at attachment and again after device restoration', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = new VFX({ capacity: 32, initialCount: 17, rate: 0 });
  h.engine.use(effect);
  const budget = () => new Uint32Array(h.resources.findLast((r) => r.size === 224 && !r.destroyed).data)[53];
  h.frame();
  assert.equal(budget(), 17);
  h.frame();
  assert.equal(budget(), 0);
  const old = effect.gpuState.particles;
  effect.onDeviceRestored(h.engine);
  assert.ok(old.destroyed);
  h.frame();
  assert.equal(budget(), 17);
  h.frame();
  assert.equal(budget(), 0);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  for (const initialCount of [-1, 1.5, 33, NaN])
    assert.throws(() => new VFX({ capacity: 32, initialCount }), /initial/);
});

test('one current 64-byte particle buffer survives frames and is retired once on restoration/disposal', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const destroyed = new Map(),
    create = h.engine.gpu.createBuffer;
  h.engine.gpu.createBuffer = (descriptor) => {
    const buffer = create(descriptor),
      destroy = buffer.destroy.bind(buffer);
    buffer.destroy = () => {
      destroyed.set(buffer, (destroyed.get(buffer) ?? 0) + 1);
      destroy();
    };
    return buffer;
  };
  const effect = new VFX({ capacity: 32, initialCount: 17, rate: 0 });
  h.engine.use(effect);
  const first = effect.gpuState,
    owned = h.resources.slice();
  assert.equal(owned.filter((buffer) => buffer.size === 32 * 64).length, 1);
  assert.equal(first.particles.size, 32 * 64);
  assert.equal(first.indirect.size, 20);
  for (let frame = 0; frame < 4; frame++) {
    h.frame();
    assert.equal(effect.gpuState.particles, first.particles);
    assert.equal(effect.gpuState.indirect, first.indirect);
  }
  effect.onDeviceRestored(h.engine);
  assert.ok(owned.every((buffer) => buffer.destroyed && destroyed.get(buffer) === 1));
  assert.notEqual(effect.gpuState.particles, first.particles);
  assert.notEqual(effect.gpuState.indirect, first.indirect);
  h.frame();
  const current = h.resources.filter((buffer) => !buffer.destroyed);
  effect.dispose();
  effect.dispose();
  assert.ok(current.every((buffer) => buffer.destroyed && destroyed.get(buffer) === 1));
  assert.ok(!h.engine.hasPlugin(effect.name));
  assert.throws(() => effect.gpuState, /not attached/);
});

test('optional obstacles, wrap, sort and texture patch shaders only when enabled and release every resource', () => {
  const plain = optionalGPU();
  plain.engine.stats = { drawCalls: 0 };
  const effect = new VFX({ capacity: 32 });
  plain.engine.use(effect);
  plain.frame();
  const code = plain.pipelines.map((p) => (p.compute ?? p.vertex).module.code);
  assert.ok(!code.some((c) => c.includes('obstacle(') || c.includes('textureSample') || c.includes('extra:Extra')));
  effect.dispose();
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const obstacles = [
    { kind: 'sphere', center: [0, 1, 0], radius: 0.5 },
    { kind: 'box', center: [2, 0, 0], halfSize: [1, 2, 3] },
  ];
  const texture = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]) };
  const vfx = new VFX({
    capacity: 100,
    initialCount: 100,
    emissionExtent: [3, 3, 3],
    wrap: true,
    sort: true,
    obstacles,
    texture,
  });
  texture.data[0] = 0;
  h.engine.use(vfx);
  h.frame();
  const shaders = h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
  for (const marker of ['obstacle(i,', 'floor(q/span)', 'fn clear', 'textureSample(sprite'])
    assert.ok(shaders.includes(marker), marker);
  assert.equal(h.counts.uploads, 1);
  assert.equal(h.resources.filter((r) => r.size === 128 * 4).length, 1, 'sorted live list is padded to a power of two');
  const extra = h.resources.find((r) => r.size === 2096),
    f = new Float32Array(extra.data),
    u = new Uint32Array(extra.data);
  assert.equal(u[8], 2);
  assert.deepEqual([...f.slice(12, 20)], [0, 1, 0, 0, 0.5, 0.5, 0.5, 0]);
  assert.deepEqual([...f.slice(20, 27)], [2, 0, 0, 1, 1, 2, 3]);
  obstacles[0].center = [0, 5, 0];
  h.frame();
  assert.equal(new Float32Array(extra.data)[13], 5, 'obstacles are read every frame');
  obstacles.push({ kind: 'cone', center: [0, 0, 0], radius: 1 });
  assert.throws(() => h.frame(), /Invalid obstacle/);
  obstacles.pop();
  vfx.onDeviceRestored(h.engine);
  h.frame();
  vfx.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(() => new VFX({ wrap: true }), /wrap/);
  assert.throws(() => new VFX({ emissionExtent: [1, 0, 1], wrap: true }), /wrap/);
  assert.throws(() => new VFX({ sort: 1 }), /sort/);
  assert.throws(() => new VFX({ texture: { width: 2, height: 2, data: new Uint8Array(4) } }), /texture/);
  assert.throws(() => new VFX({ obstacles: Array(65).fill(obstacles[0]) }), /64/);
});
