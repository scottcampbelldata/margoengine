// Northern Rockies conifers (@margoengine/procedural/conifers and /conifer-species): every bound below is measured on
// the built meshes and checked against the forestry references the species data cites, with the equations written out
// here from the published tables (Wykoff, Crookston and Stage 1982 and Crookston 2003, in the FVS Inland Empire variant
// overview, Tables 4.1.1 and 4.4.1), so a wrong coefficient or a mesh that drifts from its form fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONIFER_SPECIES_IDS,
  coniferForm,
  coniferHeightGrowth,
  coniferLevels,
  generateConiferImposter,
  generateConiferMesh,
  parseConiferKey,
} from '../dist/conifers.js';
import * as species from '../dist/conifer-species.js';

const FT = 0.3048,
  IN = 0.0254;
// IE Table 4.1.1 (B1, B2) and Table 4.4.1 (a1..a6), typed from the overview.
const WYKOFF = {
    'western-white-pine': [5.19988, -9.26718],
    'western-larch': [4.97407, -6.78347],
    'douglas-fir': [4.81519, -7.29306],
    'grand-fir': [5.00233, -8.19365],
    'western-red-cedar': [4.89564, -8.39057],
  },
  CROOKSTON = {
    'western-white-pine': [1.0405, 1.2799, 0.11941, 0.42745, 0, -0.07182],
    'western-larch': [1.02478, 0.99889, 0.19422, 0.59423, -0.09078, -0.02341],
    'douglas-fir': [1.01685, 1.48372, 0.27378, 0.49646, -0.18669, -0.01509],
    'grand-fir': [1.0303, 1.14079, 0.20904, 0.38787, 0, 0],
    'western-red-cedar': [1.03597, 1.46111, 0.26289, 0.18779, 0, 0],
  };
const wykoffHeight = (sp, dbh) => (4.5 + Math.exp(WYKOFF[sp][0] + WYKOFF[sp][1] / (dbh / IN + 1))) * FT;
const crookston = (sp, dbh, ht, cl, ba = 150) => {
  const [a1, a2, a3, a4, a5, a6] = CROOKSTON[sp];
  return a1 * Math.exp(a2 + a3 * Math.log(cl / FT) + a4 * Math.log(dbh / IN) + a5 * Math.log(ht / FT) + a6 * Math.log(ba)) * FT;
};

// Measures a mesh: total height, crown base (lowest needle vertex), crown width (widest needles, twice the largest
// horizontal reach) and stem diameter at breast height (mean of the stem ring nearest 1.37 m).
function measure(mesh) {
  const near = mesh.form.dbh;
  const t = mesh.trunk.positions,
    c = mesh.canopy.positions;
  let top = 0,
    base = Infinity,
    reach = 0;
  for (let k = 0; k < t.length; k += 3) top = Math.max(top, t[k + 1]);
  for (let k = 0; k < c.length; k += 3) {
    top = Math.max(top, c[k + 1]);
    base = Math.min(base, c[k + 1]);
    reach = Math.max(reach, Math.hypot(c[k], c[k + 2]));
  }
  let sum = 0,
    n = 0;
  // The stem's own ring vertices at 1.37 m: within one diameter of the axis (a sapling's lowest limbs reach that height).
  for (let k = 0; k < t.length; k += 3)
    if (Math.abs(t[k + 1] - 1.37) < 1e-3 && Math.hypot(t[k], t[k + 2]) < near) {
      sum += Math.hypot(t[k], t[k + 2]);
      n++;
    }
  return { top, base, width: 2 * reach, dbh: (2 * sum) / n };
}

test('height and diameter follow the Wykoff height-diameter equation on the built stem, slender when young', () => {
  for (const sp of CONIFER_SPECIES_IDS)
    for (const age of ['sapling', 'pole', 'mature', 'old']) {
      const mesh = generateConiferMesh(sp, { age }),
        m = measure(mesh),
        f = mesh.form;
      assert.ok(Math.abs(m.top - f.height) / f.height < 0.03, `${sp} ${age}: mesh height ${m.top} vs ${f.height}`);
      // The stem's ring radius carries the bark ridges (mean below 1): within 8 percent of the form's diameter.
      assert.ok(Math.abs(m.dbh - f.dbh) / f.dbh < 0.08, `${sp} ${age}: stem ${m.dbh} m at 1.37 m vs ${f.dbh}`);
      assert.ok(Math.abs(wykoffHeight(sp, f.dbh) - f.height) < 0.01, `${sp} ${age}: Wykoff height of ${f.dbh} m`);
      const slenderness = f.height / f.dbh;
      // Height over diameter (m/m): young stand-grown stems 70 to 130, mature 45 to 80, old growth 20 to 45.
      const [lo, hi] = age === 'old' ? [20, 45] : age === 'mature' ? [45, 80] : [70, 130];
      assert.ok(slenderness > lo && slenderness < hi, `${sp} ${age}: H/D ${slenderness.toFixed(0)} outside ${lo}..${hi}`);
    }
});

test('crown ratio: the built crown base matches the form, falls with age and follows shade tolerance', () => {
  const mature = {};
  for (const sp of CONIFER_SPECIES_IDS) {
    let last = 1;
    for (const age of ['sapling', 'pole', 'mature', 'old']) {
      const mesh = generateConiferMesh(sp, { age }),
        m = measure(mesh),
        f = mesh.form,
        built = (f.height - m.base) / f.height;
      // The lowest spray droops below its whorl: the built ratio sits at or a little above the form's.
      assert.ok(built >= f.crownRatio - 0.01 && built < f.crownRatio + 0.08, `${sp} ${age}: crown ratio ${built} vs ${f.crownRatio}`);
      assert.ok(f.crownRatio < last, `${sp}: crown ratio falls with age`);
      last = f.crownRatio;
      if (age === 'mature') mature[sp] = f.crownRatio;
    }
  }
  // Minore 1979: larch very intolerant (shortest crown), white pine and Douglas-fir intermediate, grand fir and cedar
  // tolerant (longest); Silvics gives live crowns of a third of the height in mature larch stands.
  assert.ok(mature['western-larch'] < mature['douglas-fir'] && mature['western-larch'] < mature['western-white-pine']);
  assert.ok(mature['douglas-fir'] < mature['grand-fir'] && mature['western-white-pine'] < mature['grand-fir']);
  assert.ok(mature['grand-fir'] < mature['western-red-cedar']);
  for (const [sp, cr] of Object.entries(mature)) assert.ok(cr > 0.25 && cr < 0.75, `${sp}: mature crown ratio ${cr}`);
});

test('crown width: the built crown is the Crookston 2003 width for its diameter, height and crown length', () => {
  for (const sp of CONIFER_SPECIES_IDS)
    for (const age of ['pole', 'mature', 'old']) {
      const mesh = generateConiferMesh(sp, { age }),
        f = mesh.form,
        cw = crookston(sp, f.dbh, f.height, f.crownLength),
        m = measure(mesh);
      assert.ok(Math.abs(f.crownWidth - cw) / cw < 0.01, `${sp} ${age}: form width ${f.crownWidth} vs Crookston ${cw}`);
      // Branch reach varies 0 to 15 percent per branch and sprays add their half width: within 25 percent.
      assert.ok(Math.abs(m.width - cw) / cw < 0.25, `${sp} ${age}: built crown ${m.width} m vs ${cw} m`);
      // Crown width over height: narrow spires, 0.1 to 0.45 (white pine and grand fir narrowest when mature).
      assert.ok(cw / f.height > 0.1 && cw / f.height < 0.45, `${sp} ${age}: width/height ${cw / f.height}`);
    }
});

test('branch whorls: one per year of height growth, wide apart low on a young tree and closer at the top', () => {
  for (const sp of CONIFER_SPECIES_IDS) {
    const young = generateConiferMesh(sp, { age: 'sapling' }),
      // From the first annual whorl up: the lowest whorl is the crown base itself, where shading pruned the stem.
      gaps = young.whorls.slice(2).map((h, k) => h - young.whorls[k + 1]);
    assert.ok(gaps.length >= 4, `${sp}: ${gaps.length} whorl gaps`);
    for (let k = 0; k < gaps.length; k++) {
      // Annual leader growth of young northern Rockies conifers on good sites: 0.15 to 0.9 m a year (Silvics).
      assert.ok(gaps[k] > 0.15 && gaps[k] < 0.9, `${sp}: sapling whorl gap ${gaps[k]}`);
    }
    // Each gap is the growth curve's increment over that year (within the step's own curvature).
    const f = young.form,
      top = coniferHeightGrowth(sp, f.age - 1.5);
    assert.ok(Math.abs(gaps[gaps.length - 1] - top) / top < 0.15, `${sp}: top gap ${gaps[gaps.length - 1]} vs ${top}`);
    const old = generateConiferMesh(sp, { age: 'mature' }),
      w = old.whorls,
      low = w[2] - w[1],
      high = w[w.length - 1] - w[w.length - 2];
    assert.ok(high < low, `${sp}: mature top whorls ${high} closer than the lowest ${low}`);
    assert.ok(old.form.whorlSpacing < f.whorlSpacing, `${sp}: height growth slows with age`);
  }
});

test('levels: near, middle and far fall in triangles; the far ring is an imposter that matches the near silhouette', () => {
  for (const sp of CONIFER_SPECIES_IDS) {
    const l = coniferLevels(sp, { age: 'pole' }),
      tris = l.canopy.map((g, i) => (g.indices.length + l.trunk[i].indices.length) / 3);
    assert.ok(tris[0] > tris[1] * 3 && tris[1] > tris[2] * 3, `${sp}: triangles ${tris}`);
    assert.ok(tris[0] < 12000, `${sp}: near tree ${tris[0]} triangles`);
    assert.equal(l.textures.uvs[2], l.canopy[2].uvs);
    for (let r = 0; r < 3; r++) assert.equal(l.textures.uvs[r].length, (l.canopy[r].positions.length / 3) * 2);
    const near = generateConiferMesh(sp, { age: 'pole' }),
      imp = generateConiferImposter(near, { size: 128 }),
      m = measure(near);
    let top = 0;
    for (let k = 1; k < imp.geometry.positions.length; k += 3) top = Math.max(top, imp.geometry.positions[k]);
    assert.ok(Math.abs(top - m.top) < 1e-3, `${sp}: cards as tall as the tree`);
    assert.ok(imp.coverage > 0.05 && imp.coverage < 0.6, `${sp}: imposter coverage ${imp.coverage}`);
    // The solid half is opaque needle colour; the cut-out has both covered and empty texels.
    const d = imp.image.data,
      at = (x, y) => d[(y * 128 + x) * 4 + 3];
    assert.equal(at(100, 64), 255);
    assert.equal(at(1, 1), 0, 'the corner above the crown is cut out');
    assert.equal(at(32, 127), 255, 'the stem at the ground is drawn');
  }
});

test('snags and burnt trees: no needles; a snag is broken off below the live height, a burnt tree keeps bare limbs', () => {
  for (const sp of CONIFER_SPECIES_IDS) {
    const live = generateConiferMesh(sp),
      snag = generateConiferMesh(sp, { condition: 'snag' }),
      burnt = generateConiferMesh(sp, { condition: 'burnt' });
    assert.equal(snag.canopy.indices.length, 0);
    assert.equal(burnt.canopy.indices.length, 0);
    const top = (g) => {
      let y = 0;
      for (let k = 1; k < g.positions.length; k += 3) y = Math.max(y, g.positions[k]);
      return y;
    };
    assert.ok(top(snag.trunk) < live.form.height * 0.85, `${sp}: snag top ${top(snag.trunk)}`);
    assert.ok(Math.abs(top(burnt.trunk) - live.form.height) < live.form.height * 0.05, `${sp}: a burnt tree keeps its top`);
    assert.ok(burnt.trunk.indices.length > snag.trunk.indices.length, `${sp}: burnt limbs outnumber snag stubs`);
    const lv = coniferLevels(sp, { condition: 'burnt' });
    assert.equal(lv.textures, undefined, 'dead trees draw no imposter');
  }
});

test('keys, forms and errors', () => {
  assert.deepEqual(parseConiferKey('procedural:western-larch/old'), { species: 'western-larch', age: 'old', condition: 'live' });
  assert.deepEqual(parseConiferKey('grand-fir'), { species: 'grand-fir', age: 'mature', condition: 'live' });
  assert.deepEqual(parseConiferKey('procedural:douglas-fir/burnt'), { species: 'douglas-fir', age: 'mature', condition: 'burnt' });
  assert.equal(parseConiferKey('procedural:burnt-trunk').condition, 'burnt');
  assert.equal(parseConiferKey('procedural:conifer-snag').condition, 'snag');
  for (const k of ['procedural:conifer', 'douglas-fir/young', 'douglas-fir/old/x', 'toString', 'constructor/old'])
    assert.equal(parseConiferKey(k), undefined, k);
  assert.equal(coniferForm('douglas-fir', { height: 20 }).height, 20);
  assert.equal(species.CONIFER_AGES.mature, 100);
  assert.throws(() => coniferForm('spruce'), RangeError);
  assert.throws(() => coniferForm('douglas-fir', { age: 0 }), RangeError);
  assert.throws(() => coniferForm('douglas-fir', { height: 60 }), RangeError);
  assert.throws(() => coniferForm('douglas-fir', { basalArea: 0 }), RangeError);
  assert.throws(() => generateConiferMesh('douglas-fir', { detail: 3 }), RangeError);
  assert.throws(() => generateConiferMesh('douglas-fir', { condition: 'dead' }), RangeError);
  assert.throws(() => generateConiferMesh('toString'), RangeError);
  assert.throws(() => generateConiferImposter(generateConiferMesh('grand-fir'), { size: 100 }), RangeError);
  // Same options, same bytes.
  const a = generateConiferMesh('western-red-cedar', { seed: 5 }),
    b = generateConiferMesh('western-red-cedar', { seed: 5 });
  assert.deepEqual(a.canopy.positions, b.canopy.positions);
});
