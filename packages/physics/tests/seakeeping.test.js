// A hull on the sea (SEA-08): the water's pressure integrated over the wetted part of a hull mesh. A box floats at its
// draft (Archimedes, to f64 rounding), heeled it rights itself by the wall-sided righting arm, and in a small regular wave the
// load is the linear Froude-Krylov force of a box, all against closed forms.
import assert from 'node:assert/strict';
import { freeSection } from './coupling/sections.js';
import test from 'node:test';
import {
  addedMassInfinite,
  eddyRollCoefficient,
  frictionGirth,
  GRAVITY,
  heaveAddedMassInfinite,
  heaveSection,
  lateralSection,
  hullSections,
  lewisForm,
  scatterSection,
  SEA_WATER,
  swayAddedMassRigidLid,
  wettedLoads,
} from '../dist/seakeeping.js';

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

test("a section's Lewis form: the book's container section, and a half circle, which maps to itself", () => {
  // Journee and Massie (Offshore Hydromechanics, 2001, the table after eq. 7.102): a container ship's midsection of breadth
  // 25.40 m and draft 9.00 m has the Lewis form M = 12.2400, a1 = 0.1511, a3 = -0.1136. Its area coefficient is the one
  // those coefficients give (eq. 7.91), so the map must return them.
  const [a1, a3] = [0.1511, -0.1136],
    sigma = ((Math.PI / 4) * (1 - a1 * a1 - 3 * a3 * a3)) / ((1 + a3) ** 2 - a1 * a1),
    form = lewisForm(25.4, 9, sigma * 25.4 * 9);
  assert.ok(Math.abs(form.a1 - a1) < 1e-4 && Math.abs(form.a3 - a3) < 1e-4, `a1 ${form.a1}, a3 ${form.a3}`);
  assert.ok(Math.abs(form.scale - 12.24) < 2e-3, `M ${form.scale}`);
  const circle = lewisForm(2, 1, Math.PI / 2);
  assert.ok(
    Math.abs(circle.a1) < 1e-12 && Math.abs(circle.a3) < 1e-12,
    `a half circle: a1 ${circle.a1}, a3 ${circle.a3}`,
  );
});

test('a section moves the water of half its mirrored double body: in heave at high frequency, in sway under a rigid lid', () => {
  // With the potential 0 on the free surface (high frequency) a heaving section's image moves with it: a half circle of
  // radius R heaves rho pi R^2 / 2 (half the unbounded circle's rho pi R^2) and a flat plate of breadth B on the surface
  // rho pi B^2 / 8 (half the unbounded plate's rho pi (B/2)^2). In sway the same holds with the surface a rigid lid (zero
  // frequency), where the image sways with it: rho pi R^2 / 2 for the half circle, rho pi T^2 / 2 for a vertical plate of draft
  // T. (At high frequency a swaying section's image moves the other way, so its sway limit is smaller: radiation.ts.)
  const rho = 1025,
    R = 1.5,
    circle = lewisForm(2 * R, R, (Math.PI * R * R) / 2);
  const close = (got, want, tol, what) =>
    assert.ok(Math.abs(got - want) <= tol * want, `${what}: ${got} against ${want}`);
  close(heaveAddedMassInfinite(2 * R, circle, rho), (rho * Math.PI * R * R) / 2, 1e-12, 'half circle in heave');
  close(swayAddedMassRigidLid(R, circle, rho), (rho * Math.PI * R * R) / 2, 1e-12, 'half circle in sway, rigid lid');
  // A plate is a section of breadth to draft 100 (or 1/100), the end of Lewis's range, of area coefficient pi/4: its
  // coefficient is within a few parts in a hundred of the plate's.
  const flat = lewisForm(200, 1, (Math.PI / 4) * 200);
  close(heaveAddedMassInfinite(200, flat, rho), (rho * Math.PI * 200 * 200) / 8, 0.03, 'flat plate in heave');
  const upright = lewisForm(1, 50, (Math.PI / 4) * 50);
  close(
    swayAddedMassRigidLid(50, upright, rho),
    (rho * Math.PI * 50 * 50) / 2,
    0.03,
    'vertical plate in sway, rigid lid',
  );
});

test("a hull's sections are its cuts under the waterline, and a half cylinder carries rho pi R^2 L / 2 in heave", () => {
  // A box 10 by 3 by 4 floating 1.2 deep: every station is a rectangle 4 wide and 1.2 deep.
  const sections = hullSections(box([10, 3, 4], 4), -1.5 + 1.2, 10);
  assert.equal(sections.length, 10);
  for (const s of sections) {
    assert.ok(
      Math.abs(s.breadth - 4) < 1e-9 && Math.abs(s.draft - 1.2) < 1e-9,
      `section ${s.x}: ${s.breadth} by ${s.draft}`,
    );
    assert.ok(Math.abs(s.area - 4 * 1.2) < 1e-9, `section ${s.x}: area ${s.area}`);
  }
  // A half cylinder of radius 1 and length 8, its flat deck at the waterline, sections of 64-sided half polygons: each a
  // Lewis half circle, so its heave added mass is rho pi R^2 L / 2 within the polygon's area defect (0.16 percent).
  const [R, L, n] = [1, 8, 64],
    vertices = [],
    indices = [];
  for (const x of [-L / 2, L / 2])
    for (let i = 0; i <= n; i++) {
      const a = (Math.PI * i) / n;
      vertices.push(x, -R * Math.sin(a), R * Math.cos(a));
    }
  const at = (end, i) => end * (n + 1) + i;
  for (let i = 0; i < n; i++) indices.push(at(0, i), at(1, i + 1), at(1, i), at(0, i), at(0, i + 1), at(1, i + 1));
  // The deck (y = 0) and the two ends, as fans.
  indices.push(at(0, 0), at(1, 0), at(1, n), at(0, 0), at(1, n), at(0, n));
  for (let i = 1; i < n - 1; i++) {
    indices.push(at(0, 0), at(0, i + 1), at(0, i));
    indices.push(at(1, 0), at(1, i), at(1, i + 1));
  }
  const strips = hullSections({ vertices, indices }, 0, 16),
    a = addedMassInfinite(strips, [0, 0, 0], 1025),
    expected = (1025 * Math.PI * R * R * L) / 2;
  assert.ok(Math.abs(a[1 * 6 + 1] - expected) <= 5e-3 * expected, `heave added mass ${a[7]} against ${expected}`);
  assert.ok(Math.abs(a[1 * 6 + 5]) <= 1e-9 * expected, 'no heave-pitch coupling for a hull symmetric fore and aft');
});

test('a heaving half circle: the pressure and the waves give the same damping, and the added mass and damping meet their limits', () => {
  // Ursell-Tasai (radiation.ts). The damping from the pressure on the hull must equal the energy the waves carry away,
  // rho g^2 Abar^2 / w^3 (two independent results of one solution; their gap is the least-squares fit's), at every frequency.
  // Coefficients a = A / (rho pi R^2 / 2) and b = B / ((rho pi R^2 / 2) w), xi = w^2 R / g: at high frequency a -> 1 (the
  // free surface holds the potential at 0) and b -> 0; at low frequency b -> 8 / pi (the waves' amplitude ratio tends to
  // k B: b = 2 Abar^2 / (pi xi^2) -> 8 / pi) and a grows without bound (a two-dimensional section's).
  const rho = 1025,
    g = 9.81,
    R = 1,
    circle = lewisForm(2 * R, R, (Math.PI * R * R) / 2),
    norm = (rho * Math.PI * R * R) / 2,
    at = (xi) => {
      const w = Math.sqrt((xi * g) / R),
        s = heaveSection(circle, w, rho, g);
      return {
        a: s.addedMass / norm,
        b: s.damping / (norm * w),
        waves: s.dampingFromWaves / (norm * w),
        ratio: s.waveRatio,
      };
    };
  for (const xi of [0.01, 0.2, 1, 2, 4]) {
    const c = at(xi);
    assert.ok(
      Math.abs(c.b - c.waves) <= 2e-3 * c.waves,
      `xi ${xi}: damping ${c.b} from the pressure, ${c.waves} from the waves`,
    );
    assert.ok(c.b > 0 && c.a > 0, `xi ${xi}: positive coefficients`);
  }
  // The gap is the fit's: it shrinks as the multipoles and the points grow (here at xi = 8, where the damping is small).
  const w8 = Math.sqrt((8 * g) / R),
    gap = (terms, points) => {
      const s = heaveSection(circle, w8, rho, g, terms, points);
      return Math.abs(s.damping - s.dampingFromWaves) / s.dampingFromWaves;
    };
  assert.ok(gap(24, 96) < gap(16, 64) && gap(16, 64) < gap(10, 40), 'the gap shrinks as the fit grows');
  assert.ok(gap(24, 96) < 3e-3, `at 24 terms: ${gap(24, 96)}`);
  const high = at(40);
  assert.ok(Math.abs(high.a - 1) < 0.02 && high.b < 1e-3, `at high frequency a ${high.a}, b ${high.b}`);
  const low = at(1e-4);
  assert.ok(Math.abs(low.b - 8 / Math.PI) < 0.01 * (8 / Math.PI), `at low frequency b ${low.b} against 8 / pi`);
  assert.ok(low.a > at(0.01).a && at(0.01).a > at(0.2).a, 'and a grows as the frequency falls');
});

test('a swaying and rolling section: its waves give its damping again, its couplings are reciprocal, a half circle rolls freely', () => {
  // Journee and Massie eqs. 7.70-7.112, the antisymmetric problem (radiation.ts, lateralSection). For each motion the damping
  // from the pressure equals the energy its waves carry away, rho g^2 / (w^3 |motion / wave|^2); the roll moment of a sway
  // equals the sway force of a roll (Green's reciprocity: two independent solutions); a half circle rolling about its centre
  // moves no water normal to itself and makes no waves (section 7.6.2). A box section rolls about a point 0.2 m above its
  // waterline (its centre of gravity); the checks use 24 multipoles on 96 points.
  const rho = 1025,
    g = 9.81,
    box = lewisForm(2, 0.5, 1);
  for (const xi of [0.5, 1, 2]) {
    const w = Math.sqrt((xi * g) / box.scale),
      s = lateralSection(box, w, rho, -0.2, g, 24, 96);
    for (const [name, mode] of [
      ['sway', s.sway],
      ['roll', s.roll],
    ])
      assert.ok(
        Math.abs(mode.damping - mode.dampingFromWaves) <= 1e-2 * mode.dampingFromWaves,
        `xi ${xi}: ${name} damping ${mode.damping} from the pressure, ${mode.dampingFromWaves} from the waves`,
      );
    const scale = Math.abs(s.swayOfRoll.addedMass) + Math.abs(s.swayOfRoll.damping) / w;
    assert.ok(
      Math.abs(s.swayOfRoll.addedMass - s.rollOfSway.addedMass) <= 1e-2 * scale,
      `xi ${xi}: reciprocal added mass`,
    );
    assert.ok(
      Math.abs(s.swayOfRoll.damping - s.rollOfSway.damping) <= 1e-2 * scale * w,
      `xi ${xi}: reciprocal damping`,
    );
  }
  // The gap is the fit's: largest where a motion makes few waves (this roll, near a node at xi = 0.5), it shrinks as the fit
  // grows (1.1, 0.52 and 0.30 percent at 16, 24 and 32 terms).
  const w = Math.sqrt((0.5 * g) / box.scale),
    gap = (terms) => {
      const r = lateralSection(box, w, rho, -0.2, g, terms, 4 * terms).roll;
      return Math.abs(r.damping - r.dampingFromWaves) / r.dampingFromWaves;
    };
  assert.ok(gap(32) < gap(24) && gap(24) < gap(16), 'the roll gap shrinks as the fit grows');
  const circle = lateralSection(lewisForm(2, 1, Math.PI / 2), 3, rho, 0, g);
  assert.deepEqual(
    [circle.roll.addedMass, circle.roll.damping, circle.swayOfRoll.addedMass],
    [0, 0, 0],
    'a half circle rolls freely',
  );
  assert.ok(circle.sway.damping > 0 && circle.sway.addedMass > 0, 'and sways against the water');
});

test("a rolling section's viscous damping: a box sheds eddies at its corners, a half circle about its centre none", () => {
  // Ikeda's eddy coefficient (ITTC 7.5-02-07-04.5 eqs. 43-44) comes from the pressure of the flow separating where the hull
  // turns: a half circle rolling about its centre moves no water at all and separates nowhere, while a box's sharp corners
  // shed the most. Kato's skin friction takes the girth S and its mean distance r from the axis: a half circle of radius R
  // about its centre has S r^2 = pi R^3.
  const circle = lewisForm(2, 1, Math.PI / 2),
    box = lewisForm(0.3, 0.05, 0.015),
    shed = eddyRollCoefficient(box, 0.3, 0.05, -0.0125);
  assert.ok(shed > 50, `a box sheds: C_R ${shed}`);
  assert.ok(eddyRollCoefficient(circle, 2, 1, 0) < 1e-4 * shed, 'a half circle about its centre sheds none');
  // The deeper the roll axis, the more of the bilge moves across the flow.
  assert.ok(eddyRollCoefficient(box, 0.3, 0.05, 0.025) > eddyRollCoefficient(box, 0.3, 0.05, -0.0125));
  const girth = frictionGirth(circle, 0);
  assert.ok(Math.abs(girth - Math.PI) <= 2e-3 * Math.PI, `S r^2 ${girth} against pi`);
});

test('a section in a beam wave sends some back and lets the rest through, and a free one moved by it loses no energy', () => {
  // The scattering derived from the radiation solution (scatterSection): held still, a section loses no energy, so
  // |R|^2 + |T|^2 = 1; long waves pass (R -> 0) and short ones are sent back as from a wall (R -> 1). Free, moved by the
  // wave's load on it held still and its own radiation, it loses none either: that holds only with the loads' and the
  // motions' signs and phases all right (a heave or a quarter period turned round breaks it by up to a factor of 4).
  for (const [B, T, D] of [
    [2, 0.5, 1.5],
    [4, 2, 3],
  ]) {
    const form = lewisForm(B, T, B * T);
    for (const xi of [0.05, 0.3, 1, 2, 4]) {
      const w = Math.sqrt((xi * GRAVITY) / form.scale),
        held = scatterSection(form, w, T - D / 2),
        r = Math.hypot(...held.reflected),
        t = Math.hypot(...held.transmitted);
      assert.ok(Math.abs(r * r + t * t - 1) <= 1e-4, `held, xi ${xi}: |R|^2 + |T|^2 = ${r * r + t * t}`);
      if (xi === 0.05) assert.ok(r < 0.15, `a long wave passes: R ${r}`);
      if (xi === 4) assert.ok(r > 0.999, `a short wave comes back: R ${r}`);
    }
    for (const w of [0.5, 1.5, 2.5, 3.2, 4.5, 6]) {
      const { scattered } = freeSection([B, T, D], w),
        energy = Math.hypot(...scattered.reflected) ** 2 + Math.hypot(...scattered.transmitted) ** 2;
      assert.ok(Math.abs(energy - 1) <= 1e-3, `free, ${w} rad/s: |R|^2 + |T|^2 = ${energy}`);
    }
  }
});
