// lineLights (@margoengine/clustered/line): a straight source as point lights at its Gauss-Legendre nodes. These tests
// replace the ones tests/cabin-hearth.test.js ran on the page's own two-point rig (read from main.ts as text).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gaussLegendre, lineLights, lineShadowRadius, DISC_PENUMBRA_10_90, MAX_LINE_SAMPLES } from '../dist/line.js';
import { Clustered } from '../dist/index.js';
import { animateFlicker } from '../dist/flicker.js';

// Abramowitz and Stegun, Table 25.4: nodes and weights of the 2-, 3- and 5-point rules.
const table = {
  2: [[0.5773502691896257], [1]],
  3: [[0, 0.7745966692414834], [0.8888888888888888, 0.5555555555555556]],
  5: [
    [0, 0.5384693101056831, 0.906179845938664],
    [0.5688888888888889, 0.4786286704993665, 0.2369268850561891],
  ],
};

test('gaussLegendre matches the tabulated rules and integrates polynomials up to degree 2n - 1 exactly', () => {
  for (const [n, [nodes, weights]] of Object.entries(table)) {
    const rule = gaussLegendre(Number(n));
    nodes.forEach((x, i) => {
      const hi = rule.nodes.length - 1 - (nodes.length - 1 - i);
      assert.ok(Math.abs(rule.nodes[hi] - x) < 1e-14, `n ${n} node ${x}: ${rule.nodes[hi]}`);
      assert.ok(Math.abs(rule.nodes[rule.nodes.length - 1 - hi] + x) < 1e-14, `n ${n} node -${x}`);
      assert.ok(Math.abs(rule.weights[hi] - weights[i]) < 1e-14, `n ${n} weight ${weights[i]}: ${rule.weights[hi]}`);
    });
  }
  for (let n = 1; n <= 16; n++) {
    const { nodes, weights } = gaussLegendre(n);
    assert.equal(nodes.length, n);
    for (let i = 1; i < n; i++) assert.ok(nodes[i] > nodes[i - 1], `n ${n}: nodes ascend`);
    // The integral of x^k over -1..1 is 2 / (k + 1) for even k, 0 for odd.
    for (let k = 0; k <= 2 * n - 1; k++) {
      const sum = nodes.reduce((s, x, i) => s + weights[i] * x ** k, 0),
        exact = k % 2 ? 0 : 2 / (k + 1);
      assert.ok(Math.abs(sum - exact) < 1e-13, `n ${n}, x^${k}: ${sum} vs ${exact}`);
    }
    // ...and no further: x^2n is not exact.
    const sum = nodes.reduce((s, x, i) => s + weights[i] * x ** (2 * n), 0);
    assert.ok(Math.abs(sum - 2 / (2 * n + 1)) > 1e-10, `n ${n}: degree 2n is not exact`);
  }
  assert.throws(() => gaussLegendre(0), RangeError);
  assert.throws(() => gaussLegendre(1.5), RangeError);
});

test('lineLights: a 0.62 m flame line is two points at +-L / (2 sqrt 3), half the power each, soft shadows that merge', () => {
  // The Cabin Hearth fire: flames along the logs, about 0.62 m end to end, 0.6 m up.
  const flame = 0.62,
    lights = lineLights({ start: [-0.31, 0.6, -2.15], end: [0.31, 0.6, -2.15], range: 6, intensity: 9, color: [1, 0.6, 0.3] });
  assert.equal(lights.length, 2, 'two points by default');
  const [a, b] = lights,
    spacing = Math.hypot(...a.position.map((v, i) => v - b.position[i]));
  assert.ok(Math.abs(spacing / 2 - flame / (2 * Math.sqrt(3))) < 1e-12, `node offset ${spacing / 2} m`);
  assert.deepEqual(a.position.map((v, i) => (v + b.position[i]) / 2), [0, 0.6, -2.15], 'centred on the line');
  for (const light of lights) {
    assert.ok(Math.abs(light.intensity - 4.5) < 1e-12, `half the power each: ${light.intensity}`);
    assert.deepEqual(light.color, [1, 0.6, 0.3]);
    assert.equal(light.range, 6);
    assert.equal(light.castShadow, true, 'they cast shadows by default');
    assert.equal(light.shadow.near, 0.05, 'near 0.05 m: the logs and grate sit close to the flames');
    const r = light.shadow.radius;
    assert.ok(Math.abs(r - flame / 4) < 1e-12, `radius ${r}: half the share of the flame each point stands for`);
    // Each point is a sphere light of the same radius, so a metal a hand away (the Cabin Hearth kettle's spout, 0.08
    // to 0.15 m off) reflects a bounded disc, F0 x I / (pi r^2), not a point light's spike (peak linear luminance 814
    // as points, 16.2 at radius 0.155: packages/clustered/test/sphere-lights.test.js and its GPU check).
    assert.equal(light.radius, r, 'the point is a sphere of its shadow radius');
    // Two hard points cast two copies of every shadow, spacing x (receiver - blocker) / blocker apart; a point of
    // radius r widens its 10-90% penumbra to 1.374 r x the same ratio, so the copies merge when 1.374 r covers half the
    // gap, at every distance.
    assert.ok(DISC_PENUMBRA_10_90 * r >= spacing / 2, `radius ${r} merges the shadows (needs ${spacing / 2 / 1.374})`);
    assert.ok(r <= flame / 4 + 1e-12, `radius ${r} is no larger than its half of the flame`);
  }
  // The lights go straight into Clustered.
  assert.equal(new Clustered().setLights(lights).list.length, 2);
});

test('lineLights: the default radius merges neighbouring shadows for every sample count; weights share the power', () => {
  for (let n = 1; n <= MAX_LINE_SAMPLES; n++) {
    const length = 2,
      lights = lineLights({ start: [0, 0, 0], end: [length, 0, 0], range: 10, intensity: 3, samples: n }),
      r = lineShadowRadius(length, n);
    assert.equal(lights.length, n);
    assert.ok(Math.abs(lights.reduce((s, l) => s + l.intensity, 0) - 3) < 1e-12, `n ${n}: intensities sum to the line's`);
    assert.ok(r >= length / (2 * n) - 1e-12, `n ${n}: at least each point's share`);
    for (let i = 1; i < n; i++) {
      const gap = lights[i].position[0] - lights[i - 1].position[0];
      assert.ok(gap > 0, 'points run from start to end');
      assert.ok(DISC_PENUMBRA_10_90 * r >= gap / 2 - 1e-12, `n ${n}: radius ${r} merges the gap ${gap}`);
    }
    for (const light of lights) assert.equal(light.shadow.radius, r);
    // The points sit at the rule's nodes, inside the segment, symmetric about its middle.
    lights.forEach((l, i) => assert.ok(Math.abs(l.position[0] + lights[n - 1 - i].position[0] - length) < 1e-12));
  }
  // Where L / (2n) already merges (up to 5 samples) it is the radius; 6 needs more.
  for (const n of [1, 2, 3, 4, 5]) assert.equal(lineShadowRadius(1, n), 1 / (2 * n));
  assert.ok(lineShadowRadius(1, 6) > 1 / 12);
});

test('lineLights: options, one shared flicker, unshadowed and hard variants, and errors', () => {
  const plain = lineLights({ start: [0, 1, 0], end: [0, 1, 1], range: 4, castShadow: false, decay: 1.5, samples: 3 });
  for (const l of plain) {
    assert.equal(l.castShadow, undefined);
    assert.equal(l.shadow, undefined);
    assert.equal(l.color, undefined, 'color left to Clustered default');
    assert.equal(l.decay, 1.5);
  }
  assert.ok(Math.abs(plain.reduce((s, l) => s + l.intensity, 0) - 1) < 1e-12, 'intensity defaults to 1');
  const hard = lineLights({ start: [0, 1, 0], end: [1, 1, 0], range: 4, radius: 0, shadow: { near: 0.1, resolution: 256 } });
  for (const l of hard) {
    assert.deepEqual(l.shadow, { near: 0.1, resolution: 256, radius: 0 });
    assert.equal(l.radius, 0, 'radius 0: point lights, hard shadows');
  }
  // Unshadowed points are still spheres of the line's share: the highlight bound does not need a shadow.
  for (const l of plain) assert.equal(l.radius, lineShadowRadius(1, 3));
  const lit = lineLights({ start: [0, 1, 0], end: [1, 1, 0], range: 4, flicker: { curve: 'fire', speed: 1.5 } });
  for (const l of lit) assert.deepEqual(l.flicker, { seed: 0, curve: 'fire', speed: 1.5 }, 'one seed: one flicker');
  // animateFlicker keeps the points in step (it would give each its own seed, its place in the list, otherwise).
  let frame;
  const seen = [],
    engine = { onFrame: (f) => ((frame = f), () => (frame = undefined)) },
    stop = animateFlicker(engine, { setLights: (list) => seen.push(list.map((l) => l.intensity)) }, lit);
  for (let i = 0; i < 20; i++) frame(engine, 0.05);
  for (const [x, y] of seen) assert.equal(x, y, 'both points flicker together');
  stop();
  // A zero-length line is its points stacked at one place, with no shadow radius.
  const dot = lineLights({ start: [1, 2, 3], end: [1, 2, 3], range: 4 });
  for (const l of dot) assert.deepEqual([l.position, l.shadow.radius], [[1, 2, 3], 0]);
  // Each call returns new objects.
  assert.notEqual(lineLights({ start: [0, 0, 0], end: [1, 0, 0], range: 1 })[0], lineLights({ start: [0, 0, 0], end: [1, 0, 0], range: 1 })[0]);
  const base = { start: [0, 0, 0], end: [1, 0, 0], range: 4 };
  assert.throws(() => lineLights({ ...base, start: [0, 0] }), TypeError);
  assert.throws(() => lineLights({ ...base, end: [0, NaN, 0] }), TypeError);
  for (const samples of [0, 9, 2.5]) assert.throws(() => lineLights({ ...base, samples }), RangeError);
  assert.throws(() => lineLights({ ...base, intensity: -1 }), RangeError);
  assert.throws(() => lineLights({ ...base, range: -1 }), RangeError);
  assert.throws(() => lineLights({ ...base, radius: -0.1 }), RangeError);
  assert.throws(() => lineLights({ ...base, radius: Infinity }), RangeError);
  assert.throws(() => lineShadowRadius(-1), RangeError);
});
