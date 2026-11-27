// Wind scour and shadow dunes (KB-SCENES-SCOUR1): a moat on a building's windward side, a deposit horseshoe 0.65
// heights upwind with two tails sized by B = w^(2/3) h^(1/3), nothing at the walls or below the threshold, pyramidal
// shadow dunes of Hesp's height, and a refined heightfield with no cracks that lies on the coarse one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heightfieldGeometry } from '@margoengine/terrain';
import { refinedHeightfieldGeometry, scourScale, shadowDuneLength, windScour } from '@margoengine/terrain/scour';

// A 12 by 5 m, 3 m high building across a wind toward +z: the front wall at z = -2.5.
const shed = { center: [0, 0], size: [12, 5], height: 3 };

test('the length scales are those of the papers', () => {
  assert.ok(Math.abs(scourScale(12, 3) - Math.cbrt(432)) < 1e-12);
  for (const [speed, metres] of [
    [5, 5.6],
    [7.5, 5.6],
    [10, 2.9],
    [12.5, 2.25],
    [15, 1.6],
    [20, 1.3],
    [30, 1.3],
  ])
    assert.ok(Math.abs(shadowDuneLength(1, speed) - metres) < 1e-9, `${speed} m/s`);
  assert.equal(shadowDuneLength(0.5, 10), shadowDuneLength(1, 10) / 2);
});

test('a building scours a moat at its windward wall and lays the horseshoe 0.65 heights upwind', () => {
  const { change } = windScour({ buildings: [shed] });
  // Straight upwind of the middle: z runs from the wall outwards.
  const profile = Array.from({ length: 600 }, (_, k) => change(0, -2.5 - k * 0.01));
  const low = profile.indexOf(Math.min(...profile)) * 0.01,
    high = profile.indexOf(Math.max(...profile)) * 0.01;
  assert.ok(profile[low * 100] < -0.1 && low > 0.3 && low < 0.9, `moat ${profile[Math.round(low * 100)]} at ${low} m`);
  assert.ok(Math.abs(high - 0.65 * 3) < 0.15, `crest at ${high} m`);
  assert.ok(Math.max(...profile) > 0.15 && Math.max(...profile) <= 0.07 * 3 + 1e-9);
  // Steep toward the wall, gentle upwind: half the crest's height is nearer on the wall side.
  const peak = Math.round(high * 100),
    half = profile[peak] / 2;
  let inner = peak,
    outer = peak;
  while (profile[inner] > half) inner--;
  while (profile[outer] > half) outer++;
  assert.ok(outer - peak > peak - inner, `inner ${peak - inner} cm, outer ${outer - peak} cm`);
  // Deeper at the windward corners than at the front's middle.
  const least = (x, z, dx, dz) =>
    Math.min(...Array.from({ length: 200 }, (_, k) => change(x + dx * k * 0.01, z + dz * k * 0.01)));
  assert.ok(least(6, -2.5, 0.7071, -0.7071) < least(0, -2.5, 0, -1) - 0.02);
});

test('two tails run past the flanks over a length that follows B, with calm sand straight behind', () => {
  const tail = 3,
    B = scourScale(12, 3),
    { change } = windScour({ buildings: [shed], tail });
  const crestAt = (z) => {
    let best = [0, 0];
    for (let x = 0; x < 30; x += 0.05) if (change(x, z) > best[1]) best = [x, change(x, z)];
    return best;
  };
  const near = crestAt(4),
    farther = crestAt(2.5 + B);
  assert.ok(near[0] > 6 && near[1] > 0.15, `tail at x ${near[0]}, ${near[1]} m`);
  assert.ok(farther[0] > near[0], 'the tails widen downwind');
  assert.ok(Math.abs(change(near[0], 4) - change(-near[0], 4)) < 1e-9, 'both flanks alike');
  assert.ok(Math.abs(change(0, 4)) < 1e-3, 'no deposit straight behind');
  assert.equal(crestAt(2.5 + tail * B + 0.1)[1], 0);
  assert.ok(crestAt(2.5 + 0.7 * tail * B)[1] > 0.02);
});

test('nothing changes at the walls, inside the footprint, below the threshold or far away', () => {
  const { change, bounds } = windScour({ buildings: [{ ...shed, yaw: 0.6 }], wind: 25 });
  const c = Math.cos(0.6),
    s = Math.sin(0.6);
  for (let t = -1; t <= 1; t += 0.1)
    for (const [lx, lz] of [
      [6 * t, 2.5],
      [6 * t, -2.5],
      [6, 2.5 * t],
      [-6, 2.5 * t],
    ]) {
      // The footprint turned as a mesh turns it about +y.
      assert.ok(Math.abs(change(c * lx + s * lz, -s * lx + c * lz)) < 1e-9);
      assert.equal(change((c * lx + s * lz) * 0.9, (-s * lx + c * lz) * 0.9), 0);
    }
  const calm = windScour({ buildings: [shed], speed: 6.6 });
  const [x0, z0, x1, z1] = bounds[0];
  let steep = 0,
    outside = 0,
    most = 0;
  for (let x = x0 - 2; x <= x1 + 2; x += 0.1)
    for (let z = z0 - 2; z <= z1 + 2; z += 0.1) {
      const y = change(x, z);
      assert.equal(calm.change(x, z), 0);
      if (x < x0 || x > x1 || z < z0 || z > z1) outside = Math.max(outside, Math.abs(y));
      most = Math.max(most, Math.abs(y));
      steep = Math.max(steep, Math.abs(change(x + 0.01, z) - y), Math.abs(change(x, z + 0.01) - y));
    }
  assert.equal(outside, 0);
  assert.ok(most > 0.15, `most ${most}`);
  // No cliff anywhere: under the repose angle of dry sand with a margin (tan 35 degrees).
  assert.ok(steep / 0.01 < 0.7, `steepest ${steep / 0.01}`);
});

test('a plant grows a pyramidal shadow dune in its lee, and dunes that meet do not add up', () => {
  const plant = { center: [0, 0], width: 1 },
    { change } = windScour({ plants: [plant], speed: 10, slope: 25 }),
    crest = Math.tan((25 * Math.PI) / 180) / 2;
  assert.ok(Math.abs(change(0, 0) - crest) < 1e-9, 'height half the width times the slope');
  assert.ok(Math.abs(change(0, 1.45) - crest / 2) < 1e-9, 'falling straight to the end');
  assert.equal(change(0, 2.91), 0);
  assert.ok(change(0, 2.8) > 0);
  assert.ok(Math.abs(change(0.2, 0) - Math.tan((25 * Math.PI) / 180) * 0.3) < 1e-9);
  assert.equal(change(0, -0.51), 0);
  const twice = windScour({ plants: [plant, plant], speed: 10, slope: 25 });
  assert.equal(twice.change(0, 0), change(0, 0));
});

test('bad options throw', () => {
  for (const options of [
    { scour: 0.2 },
    { slope: 40 },
    { buildings: [{ ...shed, height: 0 }] },
    { buildings: [{ ...shed, size: [1] }] },
    { plants: [{ center: [0, 0], width: -1 }] },
    { speed: -1 },
  ])
    assert.throws(() => windScour(options), RangeError, JSON.stringify(options));
  assert.throws(() => refinedHeightfieldGeometry(() => 0, { size: [4, 4], regions: [[1, 1, 0, 0]] }), RangeError);
  assert.throws(() => refinedHeightfieldGeometry(() => 0, { size: [4, 4], regions: [], subdivide: 17 }), RangeError);
});

const wavy = (x, z) => Math.sin(x * 0.7) * 0.8 + Math.cos(z * 0.45 + x * 0.2);
const grid = { size: [24, 18], origin: [-10, -7], resolution: 12 };

/** Total plan area, and how many edges belong to one triangle only (the rim of the whole ground). */
function surface({ positions: p, indices: t }) {
  const edges = new Map();
  let area = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]],
      up =
        (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]) - (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]);
    assert.ok(up > 0, 'every triangle faces up');
    area += up / 2;
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const open = [...edges].filter(([, n]) => n === 1).map(([key]) => key.split(',').map(Number));
  assert.ok([...edges.values()].every((n) => n <= 2));
  return { area, open };
}

test('without regions the refined heightfield has the coarse surface', () => {
  const plain = heightfieldGeometry(wavy, grid),
    same = refinedHeightfieldGeometry(wavy, { ...grid, regions: [] });
  const key = (d) => {
    const out = [];
    for (let k = 0; k < d.indices.length; k += 3)
      out.push(
        [0, 1, 2]
          .map((c) =>
            Array.from(d.positions.slice(d.indices[k + c] * 3, d.indices[k + c] * 3 + 3), (v) => v.toFixed(4)),
          )
          .sort()
          .join(';'),
      );
    return out.sort();
  };
  assert.deepEqual(key(same), key(plain));
});

test('split cells lie on the coarse triangles, with no cracks or hanging vertices', () => {
  const regions = [
      [-5.5, -3.5, 1.5, 2.2],
      [0.5, 1.5, 6.1, 5.4],
      [10, 7, 30, 30],
    ],
    plain = refinedHeightfieldGeometry(wavy, { ...grid, regions: [] }),
    fine = refinedHeightfieldGeometry(wavy, { ...grid, regions, subdivide: 4 });
  assert.ok(fine.indices.length > plain.indices.length * 2);
  const { area, open } = surface(fine);
  assert.ok(Math.abs(area - 24 * 18) < 1e-3, `area ${area}`);
  // The only open edges are on the ground's rim: a crack or a T-junction would leave one inside.
  for (const [a, b] of open)
    for (const axis of [0, 2]) {
      const p = [fine.positions[a * 3 + axis], fine.positions[b * 3 + axis]],
        low = grid.origin[axis / 2],
        high = low + grid.size[axis / 2];
      if (Math.abs(p[0] - p[1]) < 1e-5) assert.ok(Math.abs(p[0] - low) < 1e-4 || Math.abs(p[0] - high) < 1e-4);
    }
  // Every vertex is on the coarse triangle under it.
  const { positions: c, indices: t } = plain;
  for (let v = 0; v < fine.positions.length; v += 3) {
    const [x, y, z] = fine.positions.slice(v, v + 3);
    let found = false;
    for (let k = 0; k < t.length && !found; k += 3) {
      const [a, b, d] = [t[k] * 3, t[k + 1] * 3, t[k + 2] * 3],
        det = (c[b + 2] - c[d + 2]) * (c[a] - c[d]) + (c[d] - c[b]) * (c[a + 2] - c[d + 2]),
        u = ((c[b + 2] - c[d + 2]) * (x - c[d]) + (c[d] - c[b]) * (z - c[d + 2])) / det,
        w = ((c[d + 2] - c[a + 2]) * (x - c[d]) + (c[a] - c[d]) * (z - c[d + 2])) / det;
      if (u < -1e-5 || w < -1e-5 || u + w > 1 + 1e-5) continue;
      found = true;
      assert.ok(Math.abs(u * c[a + 1] + w * c[b + 1] + (1 - u - w) * c[d + 1] - y) < 1e-4, `at ${x}, ${z}`);
    }
    assert.ok(found, `no coarse triangle at ${x}, ${z}`);
  }
});

test('add moves the vertices, small forms included', () => {
  const { change, bounds } = windScour({ plants: [{ center: [0, 0], width: 1 }], speed: 10 });
  const data = refinedHeightfieldGeometry(() => 1, { ...grid, regions: bounds, subdivide: 8, add: change });
  let top = 0;
  for (let v = 0; v < data.positions.length; v += 3) {
    const [x, y, z] = data.positions.slice(v, v + 3);
    assert.ok(Math.abs(y - 1 - change(x, z)) < 1e-5);
    top = Math.max(top, y - 1);
  }
  assert.ok(top > 0.12, `the 2 m grid alone would miss the 0.18 m dune; got ${top}`);
});
