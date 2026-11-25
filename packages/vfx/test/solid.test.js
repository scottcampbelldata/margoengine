import test from 'node:test';
import assert from 'node:assert/strict';
import { SolidParticleSystem, MAX_SOLID_VERTICES } from '../dist/solid.js';

// A triangle in the z = 0 plane, counter-clockwise seen from +z, and a 12-triangle box.
const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] };
const box = (() => {
  const p = [],
    idx = [];
  for (const [ax, sg] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const u = (ax + 1) % 3,
      v = (ax + 2) % 3,
      base = p.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const q = [0, 0, 0];
      q[ax] = sg * 0.5;
      q[u] = a * 0.5;
      q[v] = b * 0.5;
      p.push(...q);
    }
    idx.push(
      ...(sg > 0
        ? [base, base + 1, base + 2, base, base + 2, base + 3]
        : [base, base + 2, base + 1, base, base + 3, base + 2]),
    );
  }
  return { positions: p, indices: idx };
})();
const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-5, `${x} vs ${y}`);

test('transforms land in the merged buffer: scale, then rotation, then position', () => {
  const s = new SolidParticleSystem();
  s.addShape(tri, 2);
  const g = s.build();
  assert.equal(g.positions.length, 18, 'one buffer for both particles');
  assert.deepEqual([...g.indices], [0, 1, 2, 3, 4, 5]);
  const [a, b] = s.particles;
  a.position = [10, 0, 0];
  a.scaling = [2, 2, 2];
  a.rotation = [0, 0, Math.PI / 2]; // roll 90 degrees: (1,0,0) -> (0,1,0)
  b.rotationQuaternion = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
  b.color = [1, 0.5, 0.25, 1];
  b.uvs = [0.5, 0, 1, 0.5];
  s.setParticles(0, 1, false);
  [10, 2, 0].forEach((v, k) => near(g.positions[3 + k], v));
  [0, 1, 0].forEach((v, k) => near(g.positions[12 + k], v));
  assert.deepEqual([...g.colors.subarray(12, 16)], [1, 0.5, 0.25, 1]);
  assert.deepEqual([...g.colors.subarray(0, 4)], [1, 1, 1, 1]);
  // the shape had no uvs (all 0), so every vertex lands on the rectangle's corner
  assert.deepEqual([...g.uvs.subarray(6, 8)], [0.5, 0]);
  [0, 0, 1].forEach((v, k) => near(g.normals[k], v));
  assert.deepEqual(
    a.boundingBox.min.map((v) => +v.toFixed(5)),
    [8, 0, 0],
  );
});

test('uvs map the shape into the rectangle', () => {
  const s = new SolidParticleSystem();
  s.addShape({ ...tri, uvs: [0, 0, 1, 0, 0, 1] }, 1);
  const g = s.build();
  s.particles[0].uvs = [0.5, 0, 1, 0.5];
  s.setParticles(0, 0, false);
  assert.deepEqual([...g.uvs], [0.5, 0, 1, 0, 0.5, 0.5]);
});

test('setParticles writes only its range and reports the dirty vertices', () => {
  const s = new SolidParticleSystem();
  s.addShape(tri, 4);
  s.build();
  s.takeDirty();
  s.particles[2].position = [5, 5, 5];
  s.particles[0].position = [7, 7, 7];
  s.setParticles(2, 2, false);
  assert.deepEqual(s.takeDirty(), { start: 6, count: 3 });
  assert.equal(s.takeDirty(), null);
  assert.equal(s.geometry.positions[0], 0, 'particle 0 was outside the range');
  s.setParticles(1, 2, false);
  s.setParticles(3, 3, false);
  assert.deepEqual(s.takeDirty(), { start: 3, count: 9 });
});

test('updateParticle runs for alive particles only; hidden ones are updated but collapsed', () => {
  const seen = [];
  const s = new SolidParticleSystem({ updateParticle: (p) => seen.push(p.idx) });
  s.addShape(tri, 3);
  s.build();
  s.particles[1].alive = false;
  s.particles[2].isVisible = false;
  s.particles[2].position = [4, 4, 4];
  s.setParticles();
  assert.deepEqual(seen, [0, 2], 'dead particle 1 is skipped');
  assert.deepEqual([...s.geometry.positions.subarray(18, 27)], [4, 4, 4, 4, 4, 4, 4, 4, 4], 'hidden: a point');
  assert.deepEqual(s.getBounds().max, [1, 1, 0], 'bounds hold drawn particles only');
  s.setParticles(0, 2, false);
  assert.equal(seen.length, 2, 'update false skips the callback');
});

test('digest splits a shape into facets', () => {
  const s = new SolidParticleSystem();
  s.digest(box);
  assert.equal(s.particles.length, 12, 'a triangle each');
  const t = new SolidParticleSystem();
  t.digest(box, { number: 4 });
  assert.equal(t.particles.length, 4);
  const u = new SolidParticleSystem();
  u.digest(box, { facetNb: 5 });
  assert.equal(u.particles.length, 3, '5 + 5 + 2 triangles');
  const g = u.build();
  assert.equal(g.indices.length, 36, 'every triangle is kept');
  const b = u.getBounds();
  assert.deepEqual(
    b.min.map((v) => +v.toFixed(5)),
    [-0.5, -0.5, -0.5],
  );
  assert.deepEqual(
    b.max.map((v) => +v.toFixed(5)),
    [0.5, 0.5, 0.5],
  );
  u.particles[0].position = [10, 0, 0];
  u.setParticles(0, 0, false);
  assert.ok(u.getBounds().max[0] > 9, 'a piece flies off');
});

test('pick hits the right particle and face, and misses a hidden or dead one', () => {
  const s = new SolidParticleSystem();
  s.addShape(box, 3);
  s.build();
  s.particles.forEach((p, i) => (p.position = [i * 3, 0, 0]));
  s.setParticles(0, 2, false);
  const ray = (x) => ({ origin: [x, 0, 10], direction: [0, 0, -1] });
  const hit = s.pick(ray(3));
  assert.equal(hit.particleIndex, 1);
  assert.equal(hit.shapeId, 0);
  near(hit.distance, 9.5);
  assert.deepEqual(hit.point, [3, 0, 0.5]);
  assert.equal(hit.localFaceId >> 1, 4, 'the +z face is the 5th pair of triangles');
  assert.equal(hit.faceId, 12 + hit.localFaceId, 'faceId counts the merged buffer');
  assert.equal(s.pick(ray(1.5)), null, 'between particles');
  near(s.pick({ origin: [3, 0, 10], direction: [0, 0, -2] }).distance, hit.distance);
  assert.equal(s.pick(ray(3), { maxDistance: 5 }), null);
  s.particles[1].isVisible = false;
  s.setParticles(1, 1, false);
  assert.equal(s.pick(ray(3)), null, 'hidden');
  s.particles[1].isVisible = true;
  s.particles[1].alive = false;
  s.setParticles(1, 1, false);
  assert.equal(s.pick(ray(3)), null, 'dead');
  s.particles[1].alive = true;
  s.particles[1].position = [0, 0, 0.25];
  s.setParticles(1, 1, false);
  assert.equal(s.pick(ray(0)).particleIndex, 1, 'the nearer of two overlapping particles wins');
});

test('back faces can be ignored', () => {
  const s = new SolidParticleSystem();
  s.addShape(box, 1);
  s.build();
  const inside = { origin: [0, 0, 0], direction: [0, 0, -1] };
  assert.ok(s.pick(inside));
  assert.equal(s.pick(inside, { backFaces: false }), null);
  assert.ok(s.pick({ origin: [0, 0, 5], direction: [0, 0, -1] }, { backFaces: false }));
});

test('pick follows rotation and scale of the written buffer', () => {
  const s = new SolidParticleSystem();
  s.addShape(box, 1);
  s.build();
  s.particles[0].scaling = [4, 1, 1];
  s.setParticles(0, 0, false);
  assert.ok(s.pick({ origin: [1.9, 0, 5], direction: [0, 0, -1] }), 'scaled box reaches x = 2');
  s.particles[0].rotation = [0, Math.PI / 2, 0];
  s.setParticles(0, 0, false);
  assert.equal(s.pick({ origin: [1.9, 0, 5], direction: [0, 0, -1] }), null, 'turned: now 4 deep, 1 wide');
  assert.ok(s.pick({ origin: [0, 0, 5], direction: [0, 0, -1] }));
});

test('positionFunction and vertexFunction run at creation', () => {
  const s = new SolidParticleSystem();
  s.addShape(tri, 3, {
    positionFunction: (p, i) => (p.position = [i, 0, 0]),
    vertexFunction: (p, v) => (v[1] *= 2),
    color: [1, 0, 0, 1],
  });
  const g = s.build();
  assert.deepEqual([...g.positions.subarray(9, 18)], [1, 0, 0, 2, 0, 0, 1, 2, 0]);
  assert.deepEqual([...g.colors.subarray(0, 4)], [1, 0, 0, 1]);
});

test('errors are coded and name the fix', () => {
  const s = new SolidParticleSystem();
  assert.throws(() => s.setParticles(), { name: 'MargoError', code: 'state' });
  assert.throws(() => s.pick({ origin: [0, 0, 0], direction: [0, 0, 1] }), { code: 'state' });
  assert.throws(() => s.build(), { code: 'state' }, 'empty');
  assert.throws(() => s.addShape({ positions: [0, 0, 0] }, 1), RangeError);
  assert.throws(() => s.addShape({ positions: [0, 0, NaN, 1, 0, 0, 0, 1, 0] }, 1), RangeError);
  assert.throws(() => s.addShape({ positions: tri.positions, indices: [0, 1, 9] }, 1), RangeError);
  assert.throws(() => s.addShape(tri, 0), RangeError);
  assert.throws(() => s.addShape(tri, MAX_SOLID_VERTICES), RangeError, 'too many vertices');
  assert.throws(() => s.digest(tri, { facetNb: 2 }), RangeError);
  assert.throws(() => new SolidParticleSystem({ updateParticle: 3 }), TypeError);
  s.addShape(tri, 1);
  s.build();
  assert.throws(() => s.addShape(tri, 1), { code: 'state' });
  assert.throws(() => s.build(), { code: 'state' });
  assert.throws(() => s.setParticles(1, 1), RangeError);
  assert.throws(() => s.pick({ origin: [0, 0, 0], direction: [0, 0, 0] }), RangeError);
  s.particles[0].position[0] = NaN;
  assert.throws(() => s.setParticles(), /Solid particle 0 position/);
  s.particles[0].position[0] = 0;
  s.updateParticle = () => s.setParticles();
  assert.throws(() => s.setParticles(), { code: 'state' }, 're-entrant');
  s.dispose();
  s.dispose();
  assert.throws(() => s.setParticles(), { code: 'disposed' });
});
