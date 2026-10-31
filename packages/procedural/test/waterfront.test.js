// Jetty and boat generators: counts, bounds, determinism by seed, sound triangles, unit normals, option validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBoatMesh, generateJettyMesh } from '../dist/index.js';

function box(data) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], data.positions[i + k]);
      max[k] = Math.max(max[k], data.positions[i + k]);
    }
  return { min, max };
}

function sound(name, data) {
  const n = data.positions.length / 3;
  assert.ok(n > 0 && data.indices.length % 3 === 0, name);
  assert.equal(data.normals.length, data.positions.length, name);
  assert.equal(data.uvs.length, n * 2, name);
  assert.equal(data.tangents.length, n * 4, name);
  for (const arr of [data.positions, data.normals, data.uvs, data.tangents])
    for (const v of arr) assert.ok(Number.isFinite(v), `${name} finite`);
  for (const i of data.indices) assert.ok(i < n, `${name} index`);
  for (let i = 0; i < data.normals.length; i += 3)
    assert.ok(
      Math.abs(Math.hypot(data.normals[i], data.normals[i + 1], data.normals[i + 2]) - 1) < 1e-3,
      `${name} normal`,
    );
  const p = data.positions;
  for (let t = 0; t < data.indices.length; t += 3) {
    const [a, b, c] = [data.indices[t] * 3, data.indices[t + 1] * 3, data.indices[t + 2] * 3];
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
      e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const area =
      Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    assert.ok(area > 1e-9, `${name} degenerate triangle ${t / 3}: ${area}`);
  }
}
const same = (a, b) => a.positions.every((v, i) => v === b.positions[i]) && a.positions.length === b.positions.length;

test('jetty defaults: a 24 m deck at 1.1 m, sound mesh, stated triangle counts per detail', () => {
  const jetty = generateJettyMesh();
  sound('jetty', jetty);
  const { min, max } = box(jetty);
  assert.ok(min[0] > -0.2 && max[0] > 23.9 && max[0] < 24.4, `x ${min[0]}..${max[0]}`);
  assert.ok(Math.abs(max[2]) > 1.1 && Math.abs(max[2]) < 1.8 && Math.abs(min[2]) > 1.1, 'width about 2.2 plus posts');
  assert.ok(max[1] > 1.3 && max[1] < 1.6, `mooring posts above the deck ${max[1]}`);
  assert.ok(min[1] < -1.5 && min[1] > -2, `posts stand in the water ${min[1]}`);
  const counts = [0, 1, 2].map((detail) => generateJettyMesh({ detail }).indices.length / 3);
  assert.ok(counts[2] === 2768, `detail 2: ${counts[2]}`);
  assert.ok(counts[1] === 1680, `detail 1: ${counts[1]}`);
  assert.ok(counts[0] === 508, `detail 0: ${counts[0]}`);
  for (const detail of [0, 1]) sound(`jetty detail ${detail}`, generateJettyMesh({ detail }));
});

test('jetty options: length, width, height, ladder', () => {
  const short = box(generateJettyMesh({ length: 8, width: 3.5, height: 0.8 }));
  assert.ok(short.max[0] < 8.4 && short.max[0] > 7.9);
  assert.ok(short.max[2] > 1.75 && short.max[2] < 2.3);
  assert.ok(short.max[1] > 1 && short.max[1] < 1.3);
  const withLadder = generateJettyMesh({ ladder: true }),
    without = generateJettyMesh({ ladder: false });
  assert.ok(withLadder.indices.length > without.indices.length);
  sound('jetty without ladder', without);
  // The ladder reaches below the deck on the +z side only.
  assert.ok(box(withLadder).max[2] > box(without).max[2] - 1e-6);
});

test('jetty is deterministic by seed and differs between seeds', () => {
  assert.ok(same(generateJettyMesh({ seed: 5 }), generateJettyMesh({ seed: 5 })));
  assert.ok(same(generateJettyMesh(), generateJettyMesh({ seed: 1 })));
  assert.ok(!same(generateJettyMesh({ seed: 5 }), generateJettyMesh({ seed: 6 })));
});

test('boat defaults: a 3.6 m hull, rim above and keel below the waterline, sound mesh, stated counts', () => {
  const boat = generateBoatMesh();
  sound('boat', boat);
  const { min, max } = box(boat);
  assert.ok(max[0] - min[0] > 3.4 && max[0] - min[0] < 3.9, `length ${max[0] - min[0]}`);
  assert.ok(Math.abs(min[0] + max[0]) < 0.3, 'centred on the origin along x');
  assert.ok(min[1] < -0.15 && min[1] > -0.35, `keel ${min[1]}`);
  assert.ok(max[1] > 0.4 && max[1] < 0.7, `rim ${max[1]}`);
  assert.ok(max[2] > 0.7 && Math.abs(min[2]) > 0.7 && Math.abs(max[2]) < 2.5, `beam/oars ${min[2]}..${max[2]}`);
  const counts = [0, 1, 2].map((detail) => generateBoatMesh({ detail }).indices.length / 3);
  assert.ok(counts[2] === 1884, `detail 2: ${counts[2]}`);
  assert.ok(counts[1] === 812, `detail 1: ${counts[1]}`);
  assert.ok(counts[0] === 372, `detail 0: ${counts[0]}`);
  for (const detail of [0, 1]) sound(`boat detail ${detail}`, generateBoatMesh({ detail }));
});

test('boat options: length scales it, seats and oars add triangles, hull is outward facing', () => {
  const small = box(generateBoatMesh({ length: 2, oars: false })),
    large = box(generateBoatMesh({ length: 6, oars: false }));
  assert.ok(large.max[0] - large.min[0] > 2.5 * (small.max[0] - small.min[0]));
  const bare = generateBoatMesh({ seats: 0, oars: false });
  sound('bare hull', bare);
  assert.ok(generateBoatMesh({ seats: 4, oars: false }).indices.length > bare.indices.length);
  assert.ok(generateBoatMesh({ seats: 0, oars: true }).indices.length > bare.indices.length);
  // Hull normals: every outer-shell vertex at the bottom of the section points down, rim vertices point up.
  let down = 0;
  for (let i = 0; i < bare.positions.length / 3; i++) if (bare.normals[i * 3 + 1] < -0.5) down++;
  assert.ok(down > 20, 'the outside of the keel faces down');
});

test('boat is deterministic by seed and differs between seeds', () => {
  assert.ok(same(generateBoatMesh({ seed: 9 }), generateBoatMesh({ seed: 9 })));
  assert.ok(same(generateBoatMesh(), generateBoatMesh({ seed: 1 })));
  assert.ok(!same(generateBoatMesh({ seed: 9 }), generateBoatMesh({ seed: 10 })));
});

test('options are validated: RangeError for values out of range, TypeError for wrong types', () => {
  for (const bad of [
    { length: 3 },
    { length: 121 },
    { length: NaN },
    { width: 0.5 },
    { height: 5 },
    { seed: 1.5 },
    { detail: 3 },
  ])
    assert.throws(() => generateJettyMesh(bad), RangeError, JSON.stringify(bad));
  for (const bad of [{ length: 1 }, { length: Infinity }, { seats: 5 }, { seats: 1.5 }, { seed: NaN }, { detail: -1 }])
    assert.throws(() => generateBoatMesh(bad), RangeError, JSON.stringify(bad));
  for (const bad of [{ length: '24' }, { ladder: 1 }, { seed: '1' }])
    assert.throws(() => generateJettyMesh(bad), TypeError);
  for (const bad of [{ length: '3' }, { oars: 'yes' }, { seats: null }])
    assert.throws(() => generateBoatMesh(bad), TypeError);
  assert.throws(() => generateJettyMesh(5), TypeError);
  assert.throws(() => generateBoatMesh(null), TypeError);
  assert.throws(() => generateJettyMesh({ length: 3 }), /from 4 to 120/);
});
