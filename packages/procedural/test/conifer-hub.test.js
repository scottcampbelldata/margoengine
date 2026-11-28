// KB-LOOK-TV-SPECKLE: the timber-valley blowup showed sky through each near conifer's whorl beside the stem, single
// bright pixels the speckle check counts. A spray's band started 12 percent along its branch and narrow, so the sprays
// of a whorl never met round the stem. Each whorl's sprays now start at the stem, their inner rows at least as wide as
// the arc to the next spray.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateConiferMesh, coniferStemRadius } from '../dist/conifers.js';
import { CONIFER_SPECIES } from '../dist/conifer-species.js';

// Share of vertical rays on a ring round the stem, `out` metres outside it, that meet no canopy triangle within
// `band` metres of the whorl's height: sky seen through the whorl beside the stem.
function hubGap(mesh, h, ring, band) {
  const p = mesh.canopy.positions,
    I = mesh.canopy.indices,
    tris = [];
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    if (v.some((q) => Math.abs(q[1] - h) < band)) tris.push(v);
  }
  const inside = (x, z, [a, b, c]) => {
    const s = (p1, p2) => (x - p2[0]) * (p1[2] - p2[2]) - (p1[0] - p2[0]) * (z - p2[2]);
    const d1 = s(a, b),
      d2 = s(b, c),
      d3 = s(c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let open = 0;
  const n = 180;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2,
      x = Math.cos(a) * ring,
      z = Math.sin(a) * ring;
    if (!tris.some((t) => inside(x, z, t))) open++;
  }
  return open / n;
}

test('a near conifer`s whorl is closed round the stem: no sky between its sprays` bases (KB-LOOK-TV-SPECKLE)', () => {
  for (const species of ['douglas-fir', 'lodgepole-pine', 'engelmann-spruce']) {
    if (!CONIFER_SPECIES[species]?.whorled) continue;
    for (const detail of [2, 1]) {
      const mesh = generateConiferMesh(species, { age: 'mature', detail }),
        H = mesh.form.height,
        worst = Math.max(
          ...mesh.whorls.slice(0, -1).map((h) => {
            const r0 = coniferStemRadius(h, H, mesh.form.dbh, CONIFER_SPECIES[species].flare);
            return hubGap(mesh, h, r0 + 0.08, 0.6);
          }),
        );
      assert.equal(worst, 0, `${species} detail ${detail}: ${(worst * 100).toFixed(0)}% of the ring round the stem open`);
    }
  }
});
