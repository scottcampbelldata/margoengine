// FG-04: breaking fronts over a flood and the overturning crest mesh. A bore of 3 m into 1 m of water is found as one
// line across the flow; it spills on a flat bed and plunges on a beach slope by the Iribarren number (Battjes 1974); the
// plunging jet falls freely to the water ahead at full phase and overhangs the face (a tube); the mesh is the sections
// joined along the front, with unit normals and the crest facing up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKING_WAVE_LOOK,
  SECTION_POINTS,
  breakerCurl,
  breakingFronts,
  breakingSection,
  breakingWaveGeometry,
} from '../dist/breaking.js';

// 40 x 8 cells of 2 m: water 4 m deep (surface 4) up to column 20, a bore running +x at 5 m/s, 1 m deep water ahead.
const W = 40,
  H = 8,
  place = { origin: [100, 50], size: [80, 16] };
const bore = ({ slope = 0, breaker = 1 } = {}) => {
  const depth = new Float32Array(W * H),
    bed = new Float32Array(W * H),
    velocity = new Float32Array(2 * W * H),
    br = new Float32Array(W * H);
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++) {
      const k = z * W + x,
        b = slope * 2 * (x - 20);
      bed[k] = b;
      depth[k] = x <= 20 ? 4 - b : Math.max(0, 1 - b);
      velocity[2 * k] = x <= 20 ? 5 : 0;
      br[k] = x >= 18 && x <= 20 ? breaker : 0;
    }
  return { time: 0, width: W, height: H, depth, bed, velocity, foam: new Float32Array(W * H), breaker: br };
};

test('a bore is one front line across the flow, at the last high cell', () => {
  const [line, ...rest] = breakingFronts(bore(), { place });
  assert.equal(rest.length, 0);
  assert.equal(line.count, H);
  for (let i = 0; i < H; i++) {
    assert.equal(line.cell[i] % W, 20);
    assert.ok(Math.abs(line.height[i] - 3) < 1e-6);
    assert.equal(line.depth[i], 1);
    assert.deepEqual([...line.direction.subarray(2 * i, 2 * i + 2)], [1, 0]);
    assert.ok(Math.abs(line.position[3 * i] - (100 + 41)) < 1e-4);
    assert.ok(Math.abs(line.position[3 * i + 1] - 4) < 1e-6);
  }
  // Ordered along the front.
  const zs = Array.from({ length: H }, (_, i) => line.position[3 * i + 2]);
  assert.ok(zs.every((z, i) => !i || Math.abs(z - zs[i - 1]) === 2));
});

test('no breaker or too low a drop makes no front', () => {
  assert.equal(breakingFronts(bore({ breaker: 0.2 }), { place }).length, 0);
  assert.equal(breakingFronts(bore(), { place, minHeight: 3.5 }).length, 0);
});

test('spilling on a flat bed, plunging on a beach slope (Battjes 1974)', () => {
  const flat = breakingFronts(bore(), { place })[0];
  assert.equal(flat.iribarren[0], 0);
  assert.equal(flat.curl[0], 0);
  // tan beta = 0.1, H = 3, T = 10 s: xi = 0.1 / sqrt(3 / 156.1) = 0.72, plunging.
  const beach = breakingFronts(bore({ slope: 0.1 }), { place })[0];
  const L0 = (9.81 * 100) / (2 * Math.PI);
  assert.ok(Math.abs(beach.iribarren[0] - 0.1 / Math.sqrt(beach.height[0] / L0)) < 1e-5);
  assert.ok(beach.curl[0] > 0.9);
  assert.equal(breakingFronts(bore(), { place, plunge: 0.7 })[0].curl[0], Math.fround(0.7));
  assert.equal(breakerCurl(0.3), 0);
  assert.equal(breakerCurl(1), 1);
  assert.equal(breakerCurl(4.5), 0);
  assert.ok(breakerCurl(3.6) > 0 && breakerCurl(3.6) < 1);
});

test('the jet falls freely to the water ahead at full phase and overhangs the face', () => {
  const H0 = 3,
    sec = breakingSection(4, H0, 1, 1, 1, 1);
  assert.equal(sec.s.length, SECTION_POINTS);
  const tip = 13; // back 4, crest, 8 on the jet top: the tip
  // Reach sqrt(2 H (h + H)) = sqrt(24); the jet top ends H below the crest.
  assert.ok(Math.abs(sec.s[12] - Math.sqrt(24)) < 1e-5);
  assert.ok(Math.abs(sec.y[12] - 1) < 1e-5);
  assert.ok(sec.s[tip] > sec.s[12]);
  // The face's toe lies behind the tip: a tube under the jet.
  const toe = SECTION_POINTS - 1;
  assert.ok(Math.abs(sec.y[toe] - 1) < 1e-6);
  assert.ok(sec.s[toe] < sec.s[tip] - 1);
  // Halfway out, the jet's underside is above the face below it.
  assert.ok(sec.y[18] > 1.5);
  // The lip thins toward the tip; white on the tip, not on the back.
  assert.ok(sec.thickness[12] < sec.thickness[5]);
  assert.equal(sec.white[tip], 1);
  assert.equal(sec.white[0], 0);
  // Half the phase: the tip is a quarter of H down.
  const half = breakingSection(4, H0, 1, 1, 0.5, 1);
  assert.ok(Math.abs(half.y[12] - (4 - 0.75)) < 1e-5);
  // Spilling: no jet, the face leans forward 1.2 H.
  const spill = breakingSection(4, H0, 1, 1, 1, 0);
  assert.equal(spill.s[12], 0);
  assert.ok(Math.abs(spill.s[toe] - 3.6) < 1e-5);
});

test('the mesh: sections joined along the front, unit normals, crest up, deterministic', () => {
  const fronts = breakingFronts(bore(), { place, plunge: 1 }),
    g = breakingWaveGeometry(fronts),
    rows = H + 2;
  assert.equal(g.positions.length, rows * SECTION_POINTS * 3);
  assert.equal(g.indices.length, (rows - 1) * (SECTION_POINTS - 1) * 6);
  for (let v = 0; v < g.normals.length; v += 3)
    assert.ok(Math.abs(Math.hypot(g.normals[v], g.normals[v + 1], g.normals[v + 2]) - 1) < 1e-4);
  const crest = 3 * (5 * SECTION_POINTS + 4);
  assert.ok(g.normals[crest + 1] > 0.9);
  // Triangles wound with the normals: the crest triangle's face normal points up.
  for (const i of g.indices) assert.ok(i < rows * SECTION_POINTS);
  const t = 6 * (5 * (SECTION_POINTS - 1) + 4),
    [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]].map((i) => g.positions.subarray(3 * i, 3 * i + 3)),
    e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  assert.ok(e1[2] * e2[0] - e1[0] * e2[2] > 0);
  // The tapers sit half a cell past the ends.
  assert.ok(Math.abs(g.positions[2] - 50) < 1e-4);
  assert.deepEqual(breakingWaveGeometry(breakingFronts(bore(), { place, plunge: 1 })), g);
  assert.equal(breakingWaveGeometry([]).positions.length, 0);
});

test('bad input is refused', () => {
  assert.throws(() => breakingFronts(null, { place }), TypeError);
  assert.throws(() => breakingFronts(bore(), {}), TypeError);
  assert.throws(() => breakingFronts(bore(), { place, threshold: 1 }), RangeError);
  assert.throws(() => breakingFronts(bore(), { place, plunge: 2 }), RangeError);
  assert.equal(Object.isFrozen(BREAKING_WAVE_LOOK), true);
});
