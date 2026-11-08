import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { mesh, meshCorners, MAX_PARTICLE_MESH_TRIANGLES } from '../dist/mesh.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};
// A right-angled triangle in the z = 0 plane, counter-clockwise seen from +z.
const triangle = () => ({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0] });

test('mesh corners are scaled so the farthest vertex is 1 and carry face or given normals', () => {
  const flat = meshCorners(triangle());
  assert.equal(flat.length, 3 * 8);
  assert.deepEqual([...flat.subarray(8, 11)], [1, 0, 0], 'the vertex at 2 lands at 1');
  for (let k = 0; k < 3; k++) assert.deepEqual([...flat.subarray(k * 8 + 4, k * 8 + 7)], [0, 0, 1], 'face normal');
  const indexed = meshCorners({ positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3] });
  assert.equal(indexed.length, 6 * 8, 'one corner per index');
  assert.deepEqual([...indexed.subarray(5 * 8, 5 * 8 + 3)], [0, 0, 0.25]);
  // The first triangle, counter-clockwise from +z, faces +z.
  assert.deepEqual([...indexed.subarray(4, 7)], [0, 0, 1]);
  const given = meshCorners({ ...triangle(), normals: [0, 3, 0, 0, 3, 0, 0, 3, 0] });
  assert.deepEqual([...given.subarray(4, 7)], [0, 1, 0], 'given normals are normalised');
});

test('mesh particles draw one indirect instance per listed particle and no billboards', () => {
  const { h, effect } = attach({
    capacity: 300,
    initialCount: 300,
    mesh: { ...triangle(), light: [0, 2, 0], ambient: 0.5 },
  });
  h.frame();
  assert.equal(h.counts.indirect, 1, 'the mesh draw only: billboards are hidden');
  const visible = effect.gpuState.visible;
  new Uint32Array(visible.data)[1] = 123;
  h.frame();
  const args = h.resources.find((r) => r.size === 16 && new Uint32Array(r.data)[0] === 3 && !r.destroyed);
  assert.ok(args, 'draw arguments: 3 corners');
  assert.equal(new Uint32Array(args.data)[1], 123, "the draw takes the listed particles' count each frame");
  const light = h.resources.find((r) => r.size === 32 && !r.destroyed && new Float32Array(r.data)[1] === 1);
  assert.deepEqual([...new Float32Array(light.data)], [0, 1, 0, 0.5, 1, 1, 1, 0], 'unit light, ambient, light colour');
  effect.options.mesh.ambient = 0.1;
  effect.options.mesh.lightColor = [2, 1, 0];
  h.frame();
  assert.deepEqual(
    [...new Float32Array(light.data)].map((v) => +v.toFixed(5)),
    [0, 1, 0, 0.1, 2, 1, 0, 0],
  );
  const code = h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
  assert.ok(code.includes('meshCorners') && code.includes('fn turn('), 'mesh shader with the random tumble');
  assert.ok(!code.includes('let speed=length(vs.xyz)'), "'random' leaves the velocity frame out");
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test("align 'velocity' compiles the velocity frame; effects without mesh compile no mesh code", () => {
  const { h, effect } = attach({ capacity: 8, mesh: { ...triangle(), align: 'velocity' } }, { mesh });
  h.frame();
  const code = h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
  assert.ok(code.includes('let speed=length(vs.xyz)') && !code.includes('meshHash(bitcast'));
  effect.dispose();
  const plain = attach({ capacity: 8 });
  plain.h.frame();
  assert.ok(!plain.h.pipelines.some((p) => (p.compute ?? p.vertex).module.code.includes('meshCorners')));
  assert.equal(plain.h.counts.indirect, 1, 'the billboards still draw');
  plain.effect.dispose();
});

test('mesh is validated, needs the feature and is fixed at attach', () => {
  assert.throws(() => new Base({ mesh: triangle() }), /VFX mesh needs mesh from @margoengine\/vfx\/mesh/);
  for (const bad of [
    { positions: [0, 0, 0, 1, 0] },
    { positions: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { positions: [0, 0, 0, 1, 0, 0, 0, 1, NaN] },
    { ...triangle(), indices: [0, 1] },
    { ...triangle(), indices: [0, 1, 3] },
    { ...triangle(), indices: [0, 1, 1.5] },
    { ...triangle(), normals: [0, 0, 1] },
    { ...triangle(), light: [0, 0, 0] },
    { ...triangle(), lightColor: [1, 1, 17] },
    { ...triangle(), ambient: 2 },
    { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Uint32Array((MAX_PARTICLE_MESH_TRIANGLES + 1) * 3) },
  ])
    assert.throws(() => new VFX({ capacity: 4, mesh: bad }), RangeError, JSON.stringify(bad).slice(0, 80));
  assert.throws(() => new VFX({ mesh: 3 }), TypeError);
  assert.throws(() => new VFX({ mesh: { ...triangle(), align: 'up' } }), TypeError);
  assert.doesNotThrow(
    () => new VFX({ capacity: 4, mesh: { ...triangle(), indices: new Uint32Array(MAX_PARTICLE_MESH_TRIANGLES * 3) } }),
  );
  // Geometry changed between construction and attach is checked again when it is read.
  const changed = triangle();
  const later = new VFX({ capacity: 4, mesh: changed });
  changed.positions = [0, 0, 0, 1, 0, 0, 0, 1, Infinity];
  assert.throws(() => optionalGPU().engine.use(later), RangeError);
  const { h, effect } = attach({ capacity: 4, mesh: triangle() });
  h.frame();
  effect.options.mesh = triangle();
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
});

test('an order-independent pass takes only the billboards: meshes and ribbons still draw, hidden billboards stay out', () => {
  // Regression: draw() returned at once when a transparency hook was set, so meshes and ribbons vanished under OIT.
  const { h, effect } = attach({ capacity: 8, initialCount: 8, mesh: triangle(), ribbons: { points: 4 } });
  effect.setTransparency({ surface: () => '', targets: [] });
  h.frame();
  assert.equal(h.counts.indirect, 1, 'the mesh draw');
  assert.equal(h.counts.draws, 1, 'the ribbon draw');
  effect.drawTransparent(h.context, { surface: () => '', targets: [] });
  assert.equal(h.counts.indirect, 1, 'no billboards in the pass while the mesh hides them');
  effect.dispose();
});
