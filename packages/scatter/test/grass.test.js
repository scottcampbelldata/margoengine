import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { GrassScatter, grassPoseCode, grassRings, grassShape } from '../dist/grass.js';
import { Scatter } from '../dist/index.js';

const bounds = (g) => {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.vertices.length; i += 6)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], g.vertices[i + a]);
      max[a] = Math.max(max[a], g.vertices[i + a]);
    }
  return { min, max };
};

test('grassRings: a clump of strips per ring, fewer segments further out', () => {
  const rings = grassRings({ blades: 4, segments: [6, 2, 1] });
  // A blade of s segments has two vertices a step and a tip, and 2s - 1 triangles.
  assert.deepEqual(
    rings.map((g) => [g.vertices.length / 6, g.indices.length / 3]),
    [6, 2, 1].map((s) => [4 * (2 * s + 1), 4 * (2 * s - 1)]),
  );
  for (const g of rings)
    for (let i = 3; i < g.vertices.length; i += 6) assert.deepEqual([...g.vertices.subarray(i, i + 3)], [0, 0, 1]);
});

test('grassRings: the mesh box holds every blade the GPU builds', () => {
  const shape = { height: 0.8, width: 0.1, radius: 0.3, lean: 0.5 },
    reach = 0.3 + 0.5 * 0.8 + 0.05;
  const { min, max } = bounds(grassRings(shape)[0]);
  assert.ok(Math.abs(max[1] - 0.8) < 1e-6 && min[1] === 0, 'root at 0, top at the tallest blade');
  for (const a of [0, 2]) {
    assert.ok(Math.abs(max[a] - reach) < 1e-6 && Math.abs(min[a] + reach) < 1e-6, `axis ${a}: ${min[a]} to ${max[a]}`);
  }
  // A clump of one blade still spans its reach across x and z: the GPU turns it to any heading, so a box flat in z
  // culled clumps whose blade leaned out of it (the GPU check drew fewer instances for 1 blade than for 16).
  for (const ring of grassRings({ ...shape, blades: 1 })) {
    const single = bounds(ring);
    for (const a of [0, 2])
      assert.ok(Math.abs(single.max[a] - reach) < 1e-6 && Math.abs(single.min[a] + reach) < 1e-6, `one blade, axis ${a}`);
  }
});

test('grassShape: defaults and refusals that say how to fix it', () => {
  assert.deepEqual(grassShape(), {
    height: 0.6,
    heightVariance: 0.4,
    width: 0.04,
    blades: 8,
    radius: 0.15,
    lean: 0.35,
    round: 0.3,
    segments: [5, 3, 1],
  });
  for (const bad of [
    { height: 0 },
    { width: -1 },
    { blades: 0 },
    { blades: 2.5 },
    { blades: 65 },
    { lean: 1 },
    { heightVariance: 0.99 },
    { round: 2 },
    { radius: Number.NaN },
    { segments: [1, 3, 5] },
    { segments: [5, 3] },
    { segments: [17, 3, 1] },
  ])
    assert.throws(
      () => grassShape(bad),
      (e) => e instanceof RangeError && /non-increasing integer segments/.test(e.message),
      JSON.stringify(bad),
    );
  assert.throws(
    () => grassShape(null),
    (e) => e instanceof TypeError && /omit it for the defaults/.test(e.message),
  );
});

test('grassPoseCode: wraps scatterPose once with the shape compiled in', () => {
  const stage =
    'struct ScatterPose {world:vec3f}\nfn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f)->ScatterPose {}\n';
  const code = grassPoseCode(stage, { height: 2, blades: 3, width: 0.05 });
  assert.equal(code.split('fn scatterPose(').length, 2);
  assert.equal(code.split('fn scatterPoseBase(').length, 2);
  // Whole numbers are written as f32 literals.
  assert.match(code, /p\.y\/2\.0;/);
  assert.match(code, /0\.5\*2\.0\)\);/);
  assert.match(code, /0\.5\*0\.05\*/);
  assert.throws(
    () => grassPoseCode('fn main(){}'),
    (e) => e instanceof TypeError && /scatter vertex stage/.test(e.message),
  );
});

test('GrassScatter: a Scatter with no mesh input, blades shading on', () => {
  const grass = new GrassScatter({ count: 64, grass: { blades: 3 } });
  assert.ok(grass instanceof Scatter);
  assert.equal(grass.grass.blades, 3);
  assert.ok(Object.isFrozen(grass.grass) && Object.isFrozen(grass.grass.segments));
  assert.throws(() => new GrassScatter({ grass: { blades: 0 } }), RangeError);
  assert.throws(() => new GrassScatter({ lod: [3, 2, 1] }), /rules/);
  assert.throws(
    () => GrassScatter.attach({}, box()),
    (e) => e instanceof TypeError && /without meshes/.test(e.message),
  );
  assert.throws(() => new GrassScatter(null), TypeError);
});
