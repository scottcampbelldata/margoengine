// A hull on the sea (SEA-08): the water's pressure integrated over the wetted part of a hull mesh. A box floats at its
// draft (Archimedes, to f64 rounding), heeled it rights itself by the wall-sided righting arm, and in a small regular wave the
// load is the linear Froude-Krylov force of a box, all against closed forms.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GRAVITY, SEA_WATER, wettedLoads } from '../dist/seakeeping.js';

/**
 * A box of `size` (x, y, z) about its centre, each face a grid of `n` by `n` squares in two triangles, wound outward.
 */
function box(size, n = 1) {
  const [hx, hy, hz] = size.map((s) => s / 2),
    vertices = [],
    indices = [];
  // Each face: its normal axis, the sign, and the two axes it spans.
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const [u, v] = [0, 1, 2].filter((a) => a !== axis),
      h = [hx, hy, hz],
      first = vertices.length / 3;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        const p = [0, 0, 0];
        p[axis] = sign * h[axis];
        p[u] = -h[u] + (2 * h[u] * i) / n;
        p[v] = -h[v] + (2 * h[v] * j) / n;
        vertices.push(...p);
      }
    const at = (i, j) => first + i * (n + 1) + j;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (const t of [
          [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
          [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
        ]) {
          // Outward: the normal points away from the centre.
          const p = t.map((k) => vertices.slice(3 * k, 3 * k + 3)),
            e1 = [0, 1, 2].map((c) => p[1][c] - p[0][c]),
            e2 = [0, 1, 2].map((c) => p[2][c] - p[0][c]),
            nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          indices.push(...(nrm[axis] * sign > 0 ? t : [t[0], t[2], t[1]]));
        }
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

const still = { elevation: () => 0 };
const identity = [0, 0, 0, 1];

test('a box at its draft in still water is held up by the weight of the water it displaces, through its centre of buoyancy', () => {
  const [L, D, B, T] = [10, 3, 4, 1.2],
    hull = box([L, D, B], 4),
    // The keel at y = -T: the box's centre D / 2 above it.
    pose = { position: [0, D / 2 - T, 0], rotation: identity },
    loads = wettedLoads(hull, pose, still, 0, [0, -T / 2, 0]),
    weight = SEA_WATER * GRAVITY * L * B * T;
  assert.ok(Math.abs(loads.force[1] - weight) <= 1e-12 * weight, `buoyancy ${loads.force[1]} against ${weight}`);
  for (const k of [0, 2]) assert.ok(Math.abs(loads.force[k]) <= 1e-9 * weight, `no sideways force: ${loads.force}`);
  for (const k of [0, 1, 2])
    assert.ok(Math.abs(loads.torque[k]) <= 1e-9 * weight, `no moment about the centre of buoyancy: ${loads.torque}`);
  assert.ok(Math.abs(loads.area - (L * B + 2 * (L + B) * T)) < 1e-9, `the wetted area: ${loads.area}`);
});

test('heeled, a wall-sided box rights itself by GZ = sin(phi) (GM + BM tan^2(phi) / 2)', () => {
  // Beam 4, depth 3, draft 1.2, centre of gravity 1.5 above the keel; heeled about its waterplane's middle, its displaced
  // volume stays the same while the deck edge stays dry and the bilge wet (tan(phi) < 0.6 here), and the righting arm is the
  // wall-sided formula (exact for a box).
  const [L, D, B, T, KG] = [10, 3, 4, 1.2, 1.5],
    hull = box([L, D, B], 2),
    BM = (B * B) / (12 * T),
    GM = T / 2 + BM - KG,
    volume = L * B * T;
  for (const phi of [0.1, 0.25, 0.45]) {
    const rotation = [Math.sin(phi / 2), 0, 0, Math.cos(phi / 2)],
      // The waterplane's middle, (0, T - D / 2, 0) in the box, stays at the origin.
      offset = [0, T - D / 2, 0],
      turned = [0, offset[1] * Math.cos(phi), offset[1] * Math.sin(phi)],
      position = [0, -turned[1], -turned[2]],
      // G, KG over the keel, in the world.
      gLocal = KG - D / 2,
      G = [0, position[1] + gLocal * Math.cos(phi), position[2] + gLocal * Math.sin(phi)],
      loads = wettedLoads(hull, { position, rotation }, still, 0, G),
      weight = SEA_WATER * GRAVITY * volume,
      expected = Math.sin(phi) * (GM + (BM * Math.tan(phi) ** 2) / 2);
    assert.ok(
      Math.abs(loads.force[1] - weight) <= 1e-9 * weight,
      `heeled ${phi}: the same displacement, ${loads.force[1]}`,
    );
    // Heeled about +x, the buoyancy's moment about G turns it back, about -x.
    const gz = -loads.torque[0] / weight;
    assert.ok(Math.abs(gz - expected) <= 1e-9 * Math.abs(expected), `heeled ${phi}: GZ ${gz} against ${expected}`);
  }
});

test('in a small regular wave a box takes the Froude-Krylov load of linear theory', () => {
  // Deep water, a 40 m wave of amplitude 1 mm along x: eta = a cos(k x - w t), the pressure Wheeler-stretched to 0 at the
  // surface. Under the box's flat bottom (the only face that takes a vertical load) the dynamic pressure is
  // rho g a cos(k x) e^(-k T), so the heave load past the box's weight in still water is rho g a B e^(-k T) (2 / k) sin(k L / 2),
  // to first order in a (here a k is 1.6e-4).
  const [L, D, B, T] = [10, 3, 4, 1.2],
    a = 1e-3,
    k = (2 * Math.PI) / 40,
    rho = SEA_WATER,
    sea = {
      density: rho,
      elevation: (x) => a * Math.cos(k * x),
      pressure: (x, y) => {
        const eta = a * Math.cos(k * x);
        return -rho * GRAVITY * y + rho * GRAVITY * a * Math.cos(k * x) * Math.exp(k * (y - eta));
      },
    },
    hull = box([L, D, B], 16),
    loads = wettedLoads(hull, { position: [0, D / 2 - T, 0], rotation: identity }, sea, 0, [0, 0, 0]),
    extra = loads.force[1] - rho * GRAVITY * L * B * T,
    expected = ((rho * GRAVITY * a * B * Math.exp(-k * T) * 2) / k) * Math.sin((k * L) / 2);
  assert.ok(Math.abs(extra - expected) <= 2e-3 * Math.abs(expected), `heave load ${extra} against ${expected}`);
});
