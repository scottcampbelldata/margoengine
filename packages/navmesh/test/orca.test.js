import test from 'node:test';
import assert from 'node:assert/strict';
import { avoid } from '../dist/index.js';

const agent = (id, position, velocity, preferred = velocity, radius = 0.5, maxSpeed = 2) => ({
  id,
  position,
  velocity,
  preferred,
  radius,
  maxSpeed,
});
const a = agent(1, [0, 0], [1, 0]);
// Recorded results (rounded to 1e-4) for cases with a unique ORCA optimum; [delta, horizon] = [1/60, 2] or [0.1, 0.5].
const UNIQUE = [
  ['headOn', a, [agent(2, [3, 0], [-1, 0])], [0.8889, -0.3143], [1, 0]],
  ['crossing', a, [agent(2, [2, -2], [0, 1])], [0.7721, -0.1029], [1, 0]],
  ['self', a, [agent(1, [0.1, 0], [1, 0])], [1, 0], [1, 0]],
  ['far', a, [agent(2, [50, 50], [0, 0])], [1, 0], [1, 0]],
  ['overspeed', agent(1, [0, 0], [0, 0], [10, 0]), [], [2, 0], [2, 0]],
  [
    'crowd',
    a,
    [agent(2, [2, 0.3], [-1, 0]), agent(3, [2, -0.3], [-1, 0]), agent(4, [1, 1.5], [0, -1])],
    [0.878, 0],
    [1, 0],
  ],
];

test('ORCA reproduces the recorded optima', () => {
  for (const [name, self, neighbors, long, short] of UNIQUE) {
    for (const [delta, horizon, expected] of [
      [1 / 60, 2, long],
      [0.1, 0.5, short],
    ]) {
      const v = avoid(self, neighbors, delta, horizon);
      assert.ok(Math.abs(v[0] - expected[0]) <= 1e-4 && Math.abs(v[1] - expected[1]) <= 1e-4, `${name}: ${[...v]}`);
    }
  }
});

test('ORCA head-on optimum lies on the half-plane through v + u/2 (exact value)', () => {
  // Relative position (3, 0), relative velocity (2, 0), combined radius 1, horizon 2: v - p/horizon = (0.5, 0) lies
  // in the leg region; the right leg is taken (cross product 0), so u is the projection onto that leg minus v.
  const p = 3,
    r = 1,
    leg = Math.sqrt(p * p - r * r),
    ex = leg / p,
    ez = -r / p,
    along = 2 * ex,
    ux = along * ex - 2,
    uz = along * ez,
    nx = ez,
    nz = -ex,
    c = nx * (1 + ux / 2) + nz * (uz / 2),
    t = -nz * 1;
  // Projection of preferred (1, 0) onto the line {c n + t d}, d = (-nz, nx).
  const expected = [c * nx + t * -nz, c * nz + t * nx];
  const v = avoid(a, [agent(2, [3, 0], [-1, 0])]);
  assert.ok(Math.abs(v[0] - expected[0]) < 1e-12 && Math.abs(v[1] - expected[1]) < 1e-12, `${[...v]} vs ${expected}`);
});

test('ORCA is symmetric between the two agents of a pair', () => {
  const b = agent(2, [3, 0], [-1, 0]);
  const va = [...avoid(a, [b])],
    vb = [...avoid(b, [a])];
  assert.ok(Math.abs(va[0] + vb[0]) < 1e-12 && Math.abs(va[1] + vb[1]) < 1e-12);
});

test('overlapping and coincident agents separate within the speed limit', () => {
  for (const [first, second] of [
    [agent(1, [0, 0], [0, 0], [1, 0]), agent(2, [0.5, 0], [0, 0], [-1, 0])],
    [agent(1, [0, 0], [0, 0], [1, 0]), agent(2, [0, 0], [0, 0], [1, 0])],
  ])
    for (const [delta, horizon] of [
      [1 / 60, 2],
      [0.1, 0.5],
    ]) {
      const va = [...avoid(first, [second], delta, horizon)],
        vb = [...avoid(second, [first], delta, horizon)];
      for (const v of [va, vb]) {
        assert.ok(v.every(Number.isFinite));
        assert.ok(Math.hypot(...v) <= 2 + 1e-9);
      }
      const before = Math.hypot(second.position[0] - first.position[0], second.position[1] - first.position[1]),
        after = Math.hypot(
          second.position[0] + vb[0] * delta - first.position[0] - va[0] * delta,
          second.position[1] + vb[1] * delta - first.position[1] - va[1] * delta,
        );
      assert.ok(after > before, `separation ${before} -> ${after}`);
    }
});

test('ORCA keeps every half-plane when feasible and reuses the output', () => {
  // Agents spread on a ring all heading for the centre: the result keeps clear of each for the horizon.
  const self = agent(0, [0, 0], [0.5, 0.2], [1.5, 0]),
    neighbors = [];
  for (let k = 0; k < 12; k++) {
    const angle = (k / 12) * 2 * Math.PI;
    neighbors.push(agent(k + 1, [6 * Math.cos(angle), 6 * Math.sin(angle)], [-Math.cos(angle), -Math.sin(angle)]));
  }
  const output = new Float64Array(2);
  assert.equal(avoid(self, neighbors, 1 / 60, 2, output), output);
  assert.ok(Math.hypot(output[0], output[1]) <= 2 + 1e-9);
  // Reciprocal check: if every neighbour kept its velocity and we took the new one, no pair would come closer than
  // the combined radius within half the horizon (each side takes half the avoidance).
  for (const other of neighbors) {
    const px = other.position[0],
      pz = other.position[1],
      vx = output[0] - other.velocity[0],
      vz = output[1] - other.velocity[1];
    const t = Math.max(0, Math.min(1, (px * vx + pz * vz) / (vx * vx + vz * vz)));
    assert.ok(Math.hypot(px - vx * t, pz - vz * t) > 0.99 - 1e-9 || t === 0);
  }
});

test('ORCA validation', () => {
  const b = agent(2, [3, 0], [-1, 0]);
  assert.throws(() => avoid({ ...a, id: 1.5 }, [b]), /Invalid ORCA agent/);
  assert.throws(() => avoid({ ...a, radius: -1 }, [b]), /Invalid ORCA agent/);
  assert.throws(() => avoid(a, [{ ...b, maxSpeed: Number.NaN }]), /Invalid ORCA agent/);
  // A neighbour with the agent's own id is still validated.
  assert.throws(() => avoid(a, [{ ...a, velocity: [1] }]), /Invalid ORCA agent/);
  assert.throws(() => avoid(a, [b], 0), /Invalid ORCA timestep or neighbor budget/);
  assert.throws(() => avoid(a, [b], 1 / 60, Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => avoid(a, [b], 1 / 60, 2, new Float64Array(3)), /neighbor budget/);
  assert.throws(() => avoid(a, new Array(4097).fill(b)), /neighbor budget/);
  // The agent is checked before the step arguments.
  assert.throws(() => avoid({ ...a, radius: -1 }, [b], 0), /Invalid ORCA agent/);
  const clamped = avoid(agent(1, [0, 0], [0, 0], [3, 4], 0.5, 1), []);
  assert.ok(Math.abs(clamped[0] - 0.6) < 1e-12 && Math.abs(clamped[1] - 0.8) < 1e-12);
});
