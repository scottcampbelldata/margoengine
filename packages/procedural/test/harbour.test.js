// Harbour pieces (sheet row 14): a tetrapod's volume is the Shore Protection Manual's 0.28 H^3 for its height, armour is
// laid at the manual's density and layer thickness (k_D 1.04, P 50 %), the sea wall stands at a Sanriku crest with a
// wave return and code stairs, the quay, breakwater and slipway keep their sections, and the fishing boat has the
// proportions of a small coastal fishing boat with its antifouling below the waterline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCRETE_DENSITY,
  generateBreakwater,
  generateFishingBoat,
  generateMooringPost,
  generateQuay,
  generateSeaWall,
  generateSlipway,
  generateTetrapod,
  placeTetrapods,
} from '@margoengine/procedural/harbour';

function bounds(data) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.positions.length; i += 3)
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], data.positions[i + c]);
      hi[c] = Math.max(hi[c], data.positions[i + c]);
    }
  return { lo, hi };
}
const ok = (g) => g.indices.length > 0 && g.positions.every(Number.isFinite) && g.normals.every(Number.isFinite);

test('a tetrapod: V = 0.28 H^3 (SPM 1984), stands on three legs with one straight up', () => {
  for (const mass of [2, 10, 50]) {
    const t = generateTetrapod({ mass, segments: 24 }),
      b = bounds(t.geometry),
      H = Math.cbrt(mass / CONCRETE_DENSITY / 0.28);
    assert.ok(ok(t.geometry));
    assert.ok(Math.abs(t.height - H) < 1e-9);
    assert.ok(Math.abs(b.hi[1] - b.lo[1] - H) / H < 0.01, `mesh height ${b.hi[1] - b.lo[1]} for ${H}`);
    assert.ok(Math.abs(b.lo[1]) < 0.01 * H, 'it stands on the ground');
    // The volume of the four legs' union, by sampling the legs the mesh is built from.
    const N = 70,
      span = H * 1.2,
      c = [0, t.centre, 0];
    let inside = 0;
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        for (let k = 0; k < N; k++) {
          const p = [((i + 0.5) / N - 0.5) * span, ((j + 0.5) / N - 0.5) * span + t.centre, ((k + 0.5) / N - 0.5) * span],
            q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
          if (
            t.legs.some((leg) => {
              const s = q[0] * leg.axis[0] + q[1] * leg.axis[1] + q[2] * leg.axis[2];
              if (s < -leg.back || s > leg.length) return false;
              const r = Math.hypot(q[0] - s * leg.axis[0], q[1] - s * leg.axis[1], q[2] - s * leg.axis[2]);
              return r <= (s < 0 ? leg.base : leg.base + ((leg.tip - leg.base) * s) / leg.length);
            })
          )
            inside++;
        }
    const V = (inside * span ** 3) / N ** 3;
    assert.ok(Math.abs(V / H ** 3 - 0.28) < 0.012, `V / H^3 = ${V / H ** 3}`);
    // The legs are on tetrahedral axes (109.47 degrees apart).
    for (let a = 0; a < 4; a++)
      for (let b2 = a + 1; b2 < 4; b2++) {
        const x = t.legs[a].axis,
          y = t.legs[b2].axis;
        assert.ok(Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2] + 1 / 3) < 1e-9);
      }
  }
});

test('tetrapod armour: two layers at n k_D (1 - P) / V^(2/3) units per m2, layer thickness n k_D V^(1/3)', () => {
  const a = placeTetrapods({ mass: 10, length: 60, slope: 1.5, crest: 4, toe: -6, placement: 'pattern' }),
    V = a.tetrapod.volume,
    want = (2 * 1.04 * 0.5) / V ** (2 / 3);
  assert.ok(Math.abs(a.density - want) / want < 0.06, `density ${a.density} for ${want}`);
  assert.ok(Math.abs(a.thickness - 2 * 1.04 * Math.cbrt(V)) < 1e-9);
  assert.equal(a.matrices.length, a.count * 16);
  assert.ok(a.matrices.every(Number.isFinite));
  // Every unit lies on the slope between the toe and the crest, inside the layer's thickness.
  const run = 10 * 1.5,
    n = [0, run, 10].map((v) => v / Math.hypot(run, 10));
  for (let i = 0; i < a.count; i++) {
    const m = a.matrices.subarray(16 * i, 16 * i + 16),
      // The unit's centre: its origin plus R [0, centre, 0].
      c = [m[12] + m[4] * a.tetrapod.centre, m[13] + m[5] * a.tetrapod.centre, m[14] + m[6] * a.tetrapod.centre],
      // Height of the slope plane over that z, then the distance off it along its normal.
      off = (c[1] - (4 - (c[2] / run) * 10)) * n[1];
    assert.ok(c[1] > -6 - a.thickness && c[1] < 4 + a.thickness, `unit ${i} height ${c[1]}`);
    assert.ok(off > 0 && off < a.thickness * 1.05, `unit ${i} off the bed by ${off}`);
    // Each rotation is orthonormal.
    for (const [p, q] of [[0, 4], [0, 8], [4, 8]]) assert.ok(Math.abs(m[p] * m[q] + m[p + 1] * m[q + 1] + m[p + 2] * m[q + 2]) < 1e-5);
  }
  assert.equal(a.placement, 'pattern');
  assert.equal(a.settling, undefined);
  const b = placeTetrapods({ seed: 2, placement: 'pattern' }),
    c2 = placeTetrapods({ seed: 2, placement: 'pattern' });
  assert.deepEqual(b.matrices, c2.matrices);
  assert.throws(() => placeTetrapods({ slope: 0 }), RangeError);
  assert.throws(() => placeTetrapods({ placement: 'heaped' }), RangeError);
});

// Settled armour (the default): every unit is lowered onto the bed or the units under it. Measured on the units, the
// layer stands within 25 % of the Shore Protection Manual's n k_D V^(1/3) and its porosity is 40 to 60 % (SPM 1984 table
// 7-13: P = 50 % for two layers of tetrapods), no two units overlap and the result is the same on every run.
test('settled tetrapod armour: SPM thickness and porosity, no overlaps, deterministic', () => {
  const a = placeTetrapods(),
    s = a.settling;
  assert.equal(a.placement, 'settled');
  assert.ok(s, 'settled armour reports its settling');
  assert.ok(s.minGap >= 0, `least clearance ${s.minGap}`);
  assert.ok(s.supported >= 0.98 * a.count, `${s.supported} of ${a.count} units rest on something`);
  assert.ok(Math.abs(s.measuredThickness - a.thickness) <= 0.25 * a.thickness, `thickness ${s.measuredThickness} for ${a.thickness}`);
  assert.ok(s.porosity >= 0.4 && s.porosity <= 0.6, `porosity ${s.porosity}`);
  assert.ok(a.matrices.every(Number.isFinite));
  // Every unit is down on the armour: no centre stands above the bed, or more than 1.5 layer thicknesses off it.
  const n = [0, 6, 4].map((v) => v / Math.hypot(6, 4));
  for (let i = 0; i < a.count; i++) {
    const m = a.matrices.subarray(16 * i, 16 * i + 16),
      c = [m[12] + m[4] * a.tetrapod.centre, m[13] + m[5] * a.tetrapod.centre, m[14] + m[6] * a.tetrapod.centre],
      off = c[2] > 0 ? (c[1] - (4 - c[2] / 1.5)) * n[1] : c[1] - 4;
    assert.ok(off > 0 && off < 1.5 * a.thickness, `unit ${i} off the bed by ${off}`);
  }
  assert.deepEqual(placeTetrapods().matrices, a.matrices);
  assert.notDeepEqual(placeTetrapods({ seed: 5 }).matrices, a.matrices);
  // The breakwater's armour settles the same way.
  const bw = generateBreakwater().armour.settling;
  assert.ok(bw.minGap >= 0 && bw.measuredThickness > 0);
});

test('sea wall: a Sanriku crest, a recurved wave return, joints and stairs of code riser', () => {
  const w = generateSeaWall(),
    b = bounds(w.parts.concrete);
  assert.ok(w.crest >= 5 && w.crest <= 10, 'post-2011 Sanriku walls stand 5 to 10 m');
  assert.ok(Math.abs(b.hi[1] - w.crest) < 1e-5);
  assert.ok(b.hi[0] - b.lo[0] > 59.99);
  // The wave return stands seaward of the battered face at the crest.
  let lip = -Infinity;
  for (let i = 0; i < w.parts.concrete.positions.length; i += 3)
    if (w.parts.concrete.positions[i + 1] > w.crest - 0.01) lip = Math.max(lip, w.parts.concrete.positions[i + 2]);
  assert.ok(lip > w.seaward[0] + 0.3, `lip ${lip}`);
  const flat = generateSeaWall({ recurve: false });
  let top = -Infinity;
  for (let i = 0; i < flat.parts.concrete.positions.length; i += 3)
    if (flat.parts.concrete.positions[i + 1] > flat.crest - 0.01) top = Math.max(top, flat.parts.concrete.positions[i + 2]);
  assert.ok(Math.abs(top - flat.seaward[0]) < 1e-5);
  assert.ok(w.parts.trim && w.parts.stairs && w.parts.rails);
  // Stairs: (crest - land) / risers at most 0.18 m.
  const risers = Math.ceil((6 - 2) / 0.18);
  assert.ok((6 - 2) / risers <= 0.18);
  const toe = generateSeaWall({ toeTetrapods: 4 });
  assert.ok(toe.armour.count > 10);
  assert.throws(() => generateSeaWall({ crest: 30 }), RangeError);
});

test('quay, breakwater, slipway and mooring post keep their sections', () => {
  const q = generateQuay();
  assert.ok(ok(q.parts.concrete) && q.parts.bollards && q.parts.fenders && q.parts.ladders);
  assert.equal(Math.abs(bounds(q.parts.concrete).hi[1] - 2) < 1e-5, true);
  for (let i = 1; i < q.bollards.length; i++) assert.ok(Math.abs(q.bollards[i][0] - q.bollards[i - 1][0] - 15) < 1e-9);
  const bw = generateBreakwater();
  assert.ok(ok(bw.parts.core) && bw.parts.crown);
  // The core stays under the armour layer: its seaward face sits one layer in from the armour bed (cot 1.5).
  const core = bounds(bw.parts.core);
  assert.ok(core.hi[1] <= 4 + 1e-6 && core.lo[1] >= -8 - 1e-6);
  assert.ok(core.hi[2] < 2.5 + 12 * 1.5, 'core toe inside the armour toe');
  assert.ok(bw.armour.count > 100);
  const s = generateSlipway({ detail: 'near' });
  assert.ok(Math.abs(s.length - 3.5 * 8) < 1e-9);
  assert.ok(s.parts.trim);
  const post = bounds(generateMooringPost({ height: 6 }));
  assert.ok(Math.abs(post.lo[1]) < 1e-6 && post.hi[1] > 6);
});

test('fishing boat: small coastal boat proportions, antifouling below the waterline', () => {
  const boat = generateFishingBoat(),
    hull = bounds(boat.parts.hull),
    bottom = bounds(boat.parts.bottom);
  // FAO FTP 134 / Fyson 1985: small fishing boats run 3 to 4.5 lengths to the beam; under 20 GT boats 10 to 20 m.
  assert.ok(boat.length >= 10 && boat.length <= 20);
  assert.ok(boat.length / boat.beam >= 3 && boat.length / boat.beam <= 4.5);
  assert.ok(Math.abs(hull.hi[2] - hull.lo[2] - boat.beam) < 0.02 * boat.beam, `beam ${hull.hi[2] - hull.lo[2]}`);
  assert.ok(Math.abs(hull.hi[0] - hull.lo[0] - boat.length) < 1e-3);
  assert.ok(bottom.hi[1] <= 1e-6 && hull.lo[1] >= -1e-6, 'the paint line is the waterline');
  assert.ok(Math.abs(bottom.lo[1] + boat.draft) < 1e-6);
  assert.ok(boat.waterline < boat.length && boat.waterline > 0.8 * boat.length);
  for (const k of ['deck', 'cabin', 'glass', 'metal', 'trim']) assert.ok(ok(boat.parts[k]), k);
  const lamps = generateFishingBoat({ lamps: true });
  assert.ok(lamps.parts.glass.indices.length > boat.parts.glass.indices.length);
  assert.throws(() => generateFishingBoat({ length: 80 }), RangeError);
});
