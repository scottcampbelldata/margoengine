// Temperate broadleaves (@margoengine/procedural/broadleaves and /broadleaf-species), KB-PROCEDURAL-OAKBLOB1: the
// generated oak has limbs, leaf clusters and sky through its crown, where the old lobe mesh (generateTreeMesh
// 'broadleaf') was one closed green blob. Every bound is measured on the built mesh from orthographic views, with the
// crown width line written out here from Hemery's published table, so a mesh that drifts from its form fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROADLEAF_SPECIES_IDS,
  broadleafCrownWidth,
  broadleafForm,
  broadleafLevels,
  generateBroadleafImposter,
  generateBroadleafMesh,
  parseBroadleafKey,
} from '../dist/broadleaves.js';
import * as species from '../dist/broadleaf-species.js';
import { generateTreeMesh } from '../dist/index.js';
import { AZIMUTHS, crownMeasures, view } from './fixtures/crown-view.js';

const extentOf = (f) => Math.max(f.height / 2, f.crownWidth / 2) * 1.05;
const partsOf = (m) => [{ geometry: m.trunk }, { geometry: m.canopy, atlas: m.atlas }];
const triangles = (...g) => g.reduce((s, x) => s + x.indices.length / 3, 0);

test('crown width follows the Hemery table of open-grown trees', () => {
  // https://gabrielhemery.com/blog/2011/06/15/how-big-will-this-tree-grow/ : crown diameter (m) at 0.1 and 0.7 m dbh.
  const table = {
    'english-oak': [2.5, 13.14],
    'european-beech': [2.52, 11.96],
  };
  for (const [sp, [small, large]] of Object.entries(table)) {
    assert.ok(Math.abs(broadleafCrownWidth(sp, 0.1) - small) < 0.02, `${sp} at 0.1 m`);
    assert.ok(Math.abs(broadleafCrownWidth(sp, 0.7) - large) < 0.02, `${sp} at 0.7 m`);
  }
  for (const sp of BROADLEAF_SPECIES_IDS)
    for (const age of ['sapling', 'pole', 'mature', 'old']) {
      const f = broadleafForm(sp, { age });
      assert.ok(Math.abs(f.crownWidth - broadleafCrownWidth(sp, f.dbh)) < 1e-9);
      assert.ok(f.crownBase > 1 && f.crownBase < f.height * 0.5, `${sp} ${age}: crown base ${f.crownBase}`);
    }
});

// The old lobe crown measured the same way (8 azimuths by elevations 0, 10 and 30 degrees, mean of the views): hull gap
// 0.151, inner transparency 0.026 and bark 0.013 of the crown pixels. Closed lobes: it fails every bar of the next test,
// which is the defect.
const oldCrown = () => {
  const old = generateTreeMesh('broadleaf');
  let top = 0,
    base = Infinity,
    reach = 0;
  for (const g of [old.trunk, old.canopy])
    for (let k = 0; k < g.positions.length; k += 3) {
      top = Math.max(top, g.positions[k + 1]);
      reach = Math.max(reach, Math.hypot(g.positions[k], g.positions[k + 2]));
    }
  for (let k = 1; k < old.canopy.positions.length; k += 3) base = Math.min(base, old.canopy.positions[k]);
  return crownMeasures(
    [{ geometry: old.trunk }, { geometry: old.canopy, leaf: true }],
    Math.max(top / 2, reach) * 1.05,
    top / 2,
    base,
  );
};

test('an oak crown has sky inside its hull and shows its limbs; the old lobe crown shows neither', () => {
  for (const seed of [1, 2, 3]) {
    const m = generateBroadleafMesh('english-oak', { seed }),
      c = crownMeasures(partsOf(m), extentOf(m.form), m.form.height / 2, m.form.crownBase);
    // Sky inside the silhouette's convex hull, and inside that hull shrunk to 0.8.
    assert.ok(c.gap >= 0.25 && c.gap <= 0.45, `seed ${seed}: hull gap ${c.gap}`);
    assert.ok(c.inner >= 0.1 && c.inner <= 0.25, `seed ${seed}: inner transparency ${c.inner}`);
    assert.ok(c.bark >= 0.02, `seed ${seed}: bark share ${c.bark}`);
  }
  const old = oldCrown();
  assert.ok(old.gap < 0.25, `old hull gap ${old.gap}`);
  assert.ok(old.inner < 0.1, `old inner transparency ${old.inner}`);
  assert.ok(old.bark < 0.02, `old bark share ${old.bark}`);
});

test('an oak forks into 4 to 7 limbs that stay single and thick to half the crown radius', () => {
  const counts = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const m = generateBroadleafMesh('english-oak', { seed }),
      sk = m.skeleton,
      half = m.form.crownWidth / 4,
      rho = (i) => Math.hypot(sk.positions[i * 3], sk.positions[i * 3 + 2]),
      // The limb a node belongs to: the ancestor whose parent is on the trunk.
      limbOf = (i) => {
        while (sk.levels[sk.parents[i]] !== 0) i = sk.parents[i];
        return i;
      },
      crossing = new Set();
    for (let i = 1; i < sk.parents.length; i++) {
      const p = sk.parents[i];
      // Branches over 4 cm radius crossing the cylinder at half the crown radius, outward.
      if ((sk.radii[i] + sk.radii[p]) / 2 > 0.04 && rho(p) < half && rho(i) >= half && sk.levels[i] >= 1)
        crossing.add(limbOf(i));
    }
    assert.ok(m.limbs >= 4 && m.limbs <= 7, `seed ${seed}: ${m.limbs} limbs`);
    assert.equal(crossing.size, m.limbs, `seed ${seed}: ${crossing.size} limbs cross the cylinder`);
    counts.add(m.limbs);
  }
  assert.ok(counts.size >= 3, 'the seeds give different limb counts');
});

test('radii follow the pipe model at every fork, and the stem has its diameter at breast height', () => {
  for (const sp of BROADLEAF_SPECIES_IDS)
    for (const age of ['pole', 'mature', 'old']) {
      const m = generateBroadleafMesh(sp, { age }),
        sk = m.skeleton,
        n = sk.parents.length,
        sum = new Float64Array(n),
        kids = new Int32Array(n);
      for (let i = 1; i < n; i++) {
        sum[sk.parents[i]] += sk.radii[i] ** 2.4;
        kids[sk.parents[i]]++;
      }
      let forks = 0;
      for (let i = 0; i < n; i++)
        if (kids[i] > 1 && sk.radii[i] > 0.02) {
          forks++;
          // r^n of the parent is the sum of its children's (n 2.4), within the small extra each section adds.
          assert.ok(Math.abs(sk.radii[i] ** 2.4 / sum[i] - 1) < 0.02, `${sp} ${age}: fork ${i}`);
        }
      assert.ok(forks > 10, `${sp} ${age}: ${forks} forks`);
      let breast = -1;
      for (let i = 0; i < n && (i === 0 || sk.levels[i] === 0); i++)
        if (Math.abs(sk.positions[i * 3 + 1] - 1.37) < 1e-6) breast = i;
      assert.ok(breast >= 0, `${sp} ${age}: a node at breast height`);
      assert.ok(Math.abs(2 * sk.radii[breast] - m.form.dbh) / m.form.dbh < 0.01, `${sp} ${age}: stem diameter`);
      // Orders only rise toward the twigs.
      for (let i = 1; i < n; i++) assert.ok(sk.levels[i] >= sk.levels[sk.parents[i]]);
    }
});

test('the built crown is the Hemery width, and the leaf area is a closed canopy leaf area index', () => {
  for (const seed of [1, 2, 3]) {
    const m = generateBroadleafMesh('english-oak', { seed }),
      f = m.form,
      ext = extentOf(f);
    let width = 0;
    for (const az of AZIMUTHS) {
      const image = view(partsOf(m), az, 0, ext, f.height / 2),
        cut = image.rowOf(f.crownBase);
      let lo = image.W,
        hi = -1;
      for (let y = 0; y < Math.min(cut, image.H); y++)
        for (let x = 0; x < image.W; x++)
          if (image.kind[y * image.W + x]) {
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
      width += ((hi - lo + 1) * ext) / 200;
    }
    width /= AZIMUTHS.length;
    assert.ok(
      Math.abs(width - f.crownWidth) / f.crownWidth < 0.1,
      `seed ${seed}: crown ${width} m vs Hemery ${f.crownWidth}`,
    );
    // Leaf area over the ground area under the crown: Breda 2003's 4 to 6 for closed temperate canopies.
    const lai = m.leafArea / (Math.PI * (f.crownWidth / 2) ** 2);
    assert.ok(lai >= 4 && lai <= 6, `seed ${seed}: leaf area index ${lai}`);
    let top = 0;
    for (const g of [m.trunk, m.canopy])
      for (let k = 1; k < g.positions.length; k += 3) top = Math.max(top, g.positions[k]);
    assert.ok(Math.abs(top - f.height) < f.height * 0.08, `seed ${seed}: top ${top} vs ${f.height}`);
  }
});

test('levels: triangle budgets fall at least threefold a ring, with a bounded work count', () => {
  const m = generateBroadleafMesh('english-oak'),
    l = broadleafLevels('english-oak'),
    tris = l.trunk.map((g, i) => triangles(g, l.canopy[i]));
  assert.equal(triangles(m.trunk, m.canopy), tris[0]);
  assert.ok(tris[0] <= 30000, `near ${tris[0]} triangles`);
  assert.ok(tris[1] <= 4000, `middle ${tris[1]} triangles`);
  assert.equal(triangles(l.canopy[2]), 72);
  assert.ok(tris[0] > tris[1] * 3 && tris[1] > tris[2] * 3, `triangles ${tris}`);
  // Distance tests of the growth (point against node), no clock: a fixed bound for a mature oak.
  assert.ok(m.distanceTests > 1000 && m.distanceTests <= 5_000_000, `${m.distanceTests} distance tests`);
  assert.equal(l.textures.uvs[2], l.canopy[2].uvs);
  for (let r = 0; r < 3; r++) assert.equal(l.textures.uvs[r].length, (l.canopy[r].positions.length / 3) * 2);
  assert.deepEqual([l.textures.baseColor.width, l.textures.baseColor.height], [512, 1024]);
  assert.equal(l.textures.alphaCutoff, 0.5);
});

test('every species builds, at every age, leafed and bare', () => {
  for (const sp of BROADLEAF_SPECIES_IDS)
    for (const age of ['sapling', 'pole', 'mature', 'old']) {
      const live = generateBroadleafMesh(sp, { age }),
        f = live.form;
      assert.ok(live.canopy.indices.length > 0 && live.trunk.indices.length > 0, `${sp} ${age}`);
      assert.ok(f.height > 1.4 && f.dbh > 0 && f.crownWidth > 0);
      const lai = live.leafArea / (Math.PI * (f.crownWidth / 2) ** 2);
      assert.ok(lai >= 4 && lai <= 6, `${sp} ${age}: leaf area index ${lai}`);
      const bare = generateBroadleafMesh(sp, { age, condition: 'bare' });
      assert.equal(bare.canopy.indices.length, 0);
      assert.ok(bare.trunk.indices.length > 0);
      for (const g of [live.trunk, live.canopy]) assert.ok(g.positions.every(Number.isFinite));
    }
  assert.equal(broadleafLevels('european-beech', { condition: 'bare' }).textures, undefined);
  assert.equal(broadleafForm('english-oak', { height: 20 }).height, 20);
  const stout = broadleafForm('english-oak', { age: 100, open: 1 }),
    slim = broadleafForm('english-oak', { age: 100, open: 0 });
  assert.ok(stout.dbh > slim.dbh && stout.crownBase < slim.crownBase, 'open-grown oaks are stouter with lower limbs');
});

test('keys, forms and errors', () => {
  assert.deepEqual(parseBroadleafKey('procedural:european-beech/old'), {
    species: 'european-beech',
    age: 'old',
    condition: 'live',
  });
  assert.deepEqual(parseBroadleafKey('black-alder'), { species: 'black-alder', age: 'mature', condition: 'live' });
  assert.deepEqual(parseBroadleafKey('procedural:english-oak/bare'), {
    species: 'english-oak',
    age: 'mature',
    condition: 'bare',
  });
  assert.deepEqual(parseBroadleafKey('procedural:broadleaf'), {
    species: 'english-oak',
    age: 'mature',
    condition: 'live',
  });
  for (const k of [
    'procedural:oak',
    'english-oak/young',
    'english-oak/old/x',
    'toString',
    'constructor/old',
    'conifer',
  ])
    assert.equal(parseBroadleafKey(k), undefined, k);
  assert.equal(species.BROADLEAF_AGES.mature, 120);
  assert.throws(() => broadleafForm('maple'), RangeError);
  assert.throws(() => broadleafForm('english-oak', { age: 0 }), RangeError);
  assert.throws(() => broadleafForm('english-oak', { age: 'ancient' }), RangeError);
  assert.throws(() => broadleafForm('english-oak', { height: 60 }), RangeError);
  assert.throws(() => broadleafForm('english-oak', { open: 2 }), RangeError);
  assert.throws(() => generateBroadleafMesh('english-oak', { detail: 3 }), RangeError);
  assert.throws(() => generateBroadleafMesh('english-oak', { condition: 'dead' }), RangeError);
  assert.throws(() => generateBroadleafMesh('english-oak', { seed: -1 }), RangeError);
  assert.throws(() => generateBroadleafMesh('english-oak', { atlasSize: 100 }), RangeError);
  assert.throws(() => generateBroadleafMesh('toString'), RangeError);
  assert.throws(() => generateBroadleafImposter(generateBroadleafMesh('english-oak'), { cards: 9 }), RangeError);
});

test('the same options give the same bytes, another seed another tree', () => {
  const a = generateBroadleafMesh('english-oak', { seed: 5 }),
    b = generateBroadleafMesh('english-oak', { seed: 5 }),
    c = generateBroadleafMesh('english-oak', { seed: 6 });
  assert.deepEqual(a.canopy.positions, b.canopy.positions);
  assert.deepEqual(a.trunk.positions, b.trunk.positions);
  assert.deepEqual(a.atlas.data, b.atlas.data);
  assert.deepEqual(a.skeleton.radii, b.skeleton.radii);
  assert.notDeepEqual(a.canopy.positions, c.canopy.positions);
  const l = broadleafLevels('english-oak', { seed: 5 }),
    k = broadleafLevels('english-oak', { seed: 5 });
  assert.deepEqual(l.textures.baseColor.data, k.textures.baseColor.data);
});
