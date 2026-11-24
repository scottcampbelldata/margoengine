import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/base.js';
import { overLife } from '../dist/over-life.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('over-life validates growth, signed spin, zero speed and animated limits', () => {
  assert.throws(() => new VFX({ overLife: { size: [1, 2] } }), /overLife/);
  for (const v of [
    {},
    { size: [1] },
    { size: [1, -1] },
    { speed: [0, Infinity] },
    { spin: [-1001, 0] },
    { velocityLimit: -1 },
  ])
    assert.throws(() => new VFX({ overLife: v }, { overLife }), /overLife/);
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = new VFX(
    { capacity: 32, overLife: { size: [0, 4], speed: [0, 2], spin: [-2, 4], velocityLimit: [2, 0] } },
    { overLife },
  );
  h.engine.use(effect);
  h.frame();
  const curve = h.resources.find((r) => r.size === 528),
    counts = new Uint32Array(curve.data, 0, 4),
    values = new Float32Array(curve.data);
  assert.deepEqual([...counts], [2, 2, 2, 2]);
  assert.deepEqual([...values.slice(68, 70)], [0, 4]);
  assert.equal(h.resources.filter((r) => r.size === 512).length, 1);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  h.cleanup();
});

test('the spin curve turns the drawn billboard and mesh, and the simulation leaves the birth angle alone', async () => {
  const { mesh } = await import('../dist/mesh.js');
  const draw = (options, features) => {
    const h = optionalGPU();
    h.engine.stats = { drawCalls: 0 };
    const effect = new VFX({ capacity: 8, initialCount: 8, overLife: { spin: [0, 4] }, ...options }, features);
    h.engine.use(effect);
    h.frame();
    const vertex = h.pipelines.filter((p) => p.vertex).map((p) => p.vertex.module.code),
      simulation = h.pipelines.filter((p) => p.compute).map((p) => p.compute.module.code),
      bound = h.groups.map((g) => g.entries.map((e) => e.binding));
    effect.dispose();
    h.cleanup();
    return { vertex, simulation, bound };
  };
  const billboard = draw({}, { overLife });
  // Ribbons (the record stamp), random atlas frames and mesh tumble axes key on rotation.x, the birth angle.
  assert.ok(billboard.simulation.every((c) => !/particles\[cold\+1\]=vec4f\(rotation\.x\+/.test(c)));
  assert.ok(
    billboard.vertex.some((c) =>
      c.includes('let angle=p.rotation.x+p.rotation.y*(p.rotation.z-p.positionLife.w)+drawnSpin(p.rotation.z,p.positionLife.w);'),
    ),
  );
  assert.ok(billboard.bound.some((b) => b.includes(27) && !b.includes(26)), 'the billboard group binds the curves');
  const meshed = draw({ mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, { overLife, mesh });
  assert.ok(meshed.vertex.some((c) => c.includes('meshCorners') && c.includes('let angle=r.x+r.y*(r.z-p.w)+drawnSpin(r.z,p.w);')));
  assert.ok(meshed.bound.some((b) => b.includes(15) && b.includes(27)), 'the mesh group binds the curves');
});
