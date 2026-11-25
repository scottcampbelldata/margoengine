// KB-CABIN-FGTREE1: a spruce seen up close. Cabin Hearth's foreground pine, drawn as stacked plain cones in a needle
// colour of the page's own, read as one featureless near-black shape. The package's placed conifer now has branch
// whorls with gaps between the branches, the needles' measured colour as its default and a height option, so a page
// passes options only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { generateTreeMesh } from '../dist/index.js';
import { createTree, CONIFER_NEEDLES } from '../dist/tree.js';

// Share of vertical rays, on a ring at `ring` times the bottom whorl's reach, that pass through the bottom tier's band
// of the canopy without meeting it: the sky seen up through the crown's lowest branches.
function gapShare(canopy, ring) {
  const p = canopy.positions,
    I = canopy.indices,
    tris = [];
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]),
      cy = (v[0][1] + v[1][1] + v[2][1]) / 3;
    if (cy > 1.5 && cy < 3.0) tris.push(v);
  }
  const inside = (x, z, [a, b, c]) => {
    const s = (p1, p2) => (x - p2[0]) * (p1[2] - p2[2]) - (p1[0] - p2[0]) * (z - p2[2]);
    const d1 = s(a, b),
      d2 = s(b, c),
      d3 = s(c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let open = 0;
  const rays = 360,
    radius = 2.1 * ring;
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * 2 * Math.PI,
      x = 0.02 + Math.cos(a) * radius,
      z = Math.sin(a) * radius;
    if (!tris.some((t) => inside(x, z, t))) open++;
  }
  return open / rays;
}

test("a near spruce shows its branches: sky between the lowest whorl's branches, little through a skirt", () => {
  const skirt = gapShare(generateTreeMesh('conifer').canopy, 0.75),
    whorls = gapShare(generateTreeMesh('conifer', { branches: true }).canopy, 0.75);
  assert.ok(skirt < 0.1, `the skirt closes the crown but for its rim's notches: ${skirt.toFixed(3)}`);
  // Between a fifth and a half of the ring open: the branches part, and the crown still reads full.
  assert.ok(whorls > 0.2 && whorls < 0.5, `gaps between the branches: ${whorls.toFixed(3)}`);
  const mid = generateTreeMesh('conifer', { branches: true, detail: 1 });
  assert.ok(gapShare(mid.canopy, 0.75) > 0.2, 'detail 1 keeps the gaps');
  // Detail 0 is the far silhouette: branches do not apply.
  assert.deepEqual(
    generateTreeMesh('conifer', { branches: true, detail: 0 }),
    generateTreeMesh('conifer', { detail: 0 }),
  );
  // The broadleaf ignores the option.
  assert.deepEqual(generateTreeMesh('broadleaf', { branches: true }), generateTreeMesh('broadleaf'));
});

test('the sprays face up, lean out from the trunk and their normals vary from vertex to vertex (needle tilt)', () => {
  const { canopy } = generateTreeMesh('conifer', { branches: true }),
    n = canopy.normals;
  let up = 0,
    count = 0,
    turn = 0;
  for (let i = 0; i < n.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-5, 'unit normals');
    if (n[i + 1] > 0) up++;
    count++;
    if (i >= 3)
      turn += Math.acos(Math.max(-1, Math.min(1, n[i] * n[i - 3] + n[i + 1] * n[i - 2] + n[i + 2] * n[i - 1])));
  }
  assert.ok(up / count > 0.85, `most normals face the sky (${(up / count).toFixed(3)})`);
  // Neighbouring vertices of a spray differ by more than its surface's own bend: the needle tilt.
  assert.ok(turn / count > 0.12, `mean turn between neighbours ${(turn / count).toFixed(3)} rad`);
});

test('the needle colour follows the measured needle reflectance less the light a shoot recollides', () => {
  // Lukes et al. 2013: reflectance and transmittance of spruce and pine needles, red, green (550 nm) and blue; shoot
  // recollision probability p = 0.47 (Smolander and Stenberg 2003): shoot reflectance = r (1 - p) / (1 - p (r + t)).
  const needle = [
      [0.045, 0.01],
      [0.09, 0.05],
      [0.04, 0.005],
    ],
    p = 0.47,
    expected = needle.map(([r, t]) => (r * (1 - p)) / (1 - p * (r + t)));
  CONIFER_NEEDLES.forEach((c, i) =>
    assert.ok(Math.abs(c - expected[i]) < 0.0006, `channel ${i}: ${c} against ${expected[i].toFixed(4)}`),
  );
  const y = 0.2126 * CONIFER_NEEDLES[0] + 0.7152 * CONIFER_NEEDLES[1] + 0.0722 * CONIFER_NEEDLES[2];
  assert.ok(y > 0.04 && y < 0.05, `albedo ${y.toFixed(4)}`);
});

test('createTree places a conifer with branches, the needle colour and the height asked for', async () => {
  using engine = new Engine({ width: 10, height: 10 }, await TransformStore.create(64), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const tree = createTree(engine, 'conifer', { position: [1, 0, 2], height: 11.4 });
  // 3.6 m from the engine camera: the branches show their shoots (KB-CABIN-FGTREE2, conifer-shoots.test.js).
  assert.equal(
    tree.canopy.geometry.indices.length,
    generateTreeMesh('conifer', { branches: true, shoots: true }).canopy.indices.length,
  );
  assert.deepEqual([...tree.canopy.material.data.slice(0, 3)], [...CONIFER_NEEDLES].map(Math.fround));
  const data = generateTreeMesh('conifer', { branches: true });
  let top = 0;
  for (const part of [data.trunk, data.canopy])
    for (let i = 1; i < part.positions.length; i += 3) top = Math.max(top, part.positions[i]);
  engine.store.tick();
  const m = engine.store.matrices.subarray(tree.root.id * 16, tree.root.id * 16 + 16);
  assert.ok(Math.abs(m[5] * top - 11.4) < 1e-4, `the top stands 11.4 m up (${(m[5] * top).toFixed(4)})`);
  tree.dispose();
  const skirts = createTree(engine, 'conifer', { branches: false });
  assert.equal(skirts.canopy.geometry.indices.length, generateTreeMesh('conifer').canopy.indices.length);
  skirts.dispose();
  for (const height of [0, -1, NaN, 500, '8'])
    assert.throws(() => createTree(engine, 'conifer', { height }), { code: 'failed' });
  const own = new PbrMaterial({ color: '#204020' });
  using _ = createTree(engine, 'conifer', { canopyMaterial: own });
  assert.equal(engine.meshes.size, 3);
});
