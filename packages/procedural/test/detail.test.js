// Mesh detail levels (biome look round 2, item 1): detail 2 is today's mesh byte for byte, lower levels are far-ring
// meshes with fewer triangles and the same silhouette within 20 percent per axis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  generateAcaciaMesh,
  generateBirchMesh,
  generatePalmMesh,
  generateShrubMesh,
  generateTreeMesh,
  generateTundraShrubMesh,
} from '../dist/index.js';

const digest = (g) => {
  const hash = createHash('sha256');
  for (const key of ['positions', 'normals', 'uvs', 'tangents', 'indices'])
    if (g[key]) hash.update(Buffer.from(g[key].buffer, g[key].byteOffset, g[key].byteLength));
  return hash.digest('hex').slice(0, 16);
};
const triangles = (g) => g.indices.length / 3;
const extent = (g) => {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], g.positions[i + k]);
      hi[k] = Math.max(hi[k], g.positions[i + k]);
    }
  return lo.map((v, k) => hi[k] - v);
};
const pair = (mesh) => (mesh.canopy ? mesh : { canopy: mesh, trunk: null });

// Digests of the meshes on main before the detail option existed (sha256 of positions, normals, uvs, tangents, indices).
const MAIN = {
  'conifer.trunk': '04ab2a4b2f292c24',
  'conifer.canopy': '3e0725ca5b286b2c',
  'broadleaf.trunk': '48a2ce39f2ab7962',
  'broadleaf.canopy': 'e158a9ac0d934fd8',
  'palm.trunk': '816d38c027f410c1',
  'palm.canopy': '64f0392387ee3f2f',
  'birch.trunk': 'e5e71f7d16b4ccfe',
  'birch.canopy': '2477f80b9dac288e',
  'acacia.trunk': '1ae333a4a6b263bb',
  'acacia.canopy': '10dc5a0e4cb949db',
  shrub: '95a71c0db1e1bff0',
  tundra: '65ccbe3206104cd5',
};

const makers = {
  conifer: (o) => generateTreeMesh('conifer', o),
  broadleaf: (o) => generateTreeMesh('broadleaf', o),
  palm: generatePalmMesh,
  birch: generateBirchMesh,
  acacia: generateAcaciaMesh,
  shrub: generateShrubMesh,
  tundra: generateTundraShrubMesh,
};

test('the default and detail 2 are byte-identical to the meshes before the option', () => {
  for (const [name, make] of Object.entries(makers))
    for (const options of [undefined, {}, { detail: 2 }]) {
      const mesh = pair(make(options));
      if (mesh.trunk) assert.equal(digest(mesh.trunk), MAIN[`${name}.trunk`], `${name} trunk`);
      assert.equal(digest(mesh.canopy), MAIN[name === 'shrub' || name === 'tundra' ? name : `${name}.canopy`], name);
    }
});

test('each lower level has fewer canopy triangles and a valid mesh', () => {
  for (const [name, make] of Object.entries(makers)) {
    const counts = [2, 1, 0].map((detail) => {
      const mesh = pair(make({ detail })),
        g = mesh.canopy,
        n = g.positions.length / 3;
      for (const v of g.positions) assert.ok(Number.isFinite(v), `${name} ${detail} position`);
      for (const i of g.indices) assert.ok(i < n, `${name} ${detail} index`);
      for (let i = 0; i < g.normals.length; i += 3)
        assert.ok(Math.abs(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]) - 1) < 1e-3, `${name} normal`);
      return triangles(g);
    });
    assert.ok(counts[1] < counts[0] && counts[2] < counts[1], `${name} ${counts}`);
  }
});

test('broadleaf detail 0 is under 600 triangles and detail 1 under 60 percent of the full canopy', () => {
  const full = triangles(generateTreeMesh('broadleaf').canopy);
  assert.equal(full, 6240);
  assert.equal(triangles(generateTreeMesh('broadleaf', { detail: 0 }).canopy), 400);
  assert.equal(triangles(generateTreeMesh('broadleaf', { detail: 1 }).canopy), 3180);
});

test('lower levels keep the silhouette within 20 percent per axis', () => {
  for (const [name, make] of Object.entries(makers)) {
    const full = extent(pair(make({ detail: 2 })).canopy);
    for (const detail of [1, 0]) {
      const small = extent(pair(make({ detail })).canopy);
      for (let k = 0; k < 3; k++)
        assert.ok(
          Math.abs(small[k] / full[k] - 1) < 0.2,
          `${name} detail ${detail} axis ${k}: ${small[k]} vs ${full[k]}`,
        );
    }
  }
});

test('broadleaf levels 0 and 1 mix 40 percent of each lobe own direction into the canopy normals', () => {
  const full = generateTreeMesh('broadleaf'),
    low = generateTreeMesh('broadleaf', { detail: 0 });
  let differs = 0;
  for (let i = 0; i < low.canopy.positions.length; i += 3) {
    const v = [0, 1, 2].map((k) => low.canopy.positions[i + k] - low.center[k]),
      length = Math.hypot(...v);
    if (Math.abs(low.canopy.normals[i] - v[0] / length) > 1e-3) differs++;
  }
  assert.ok(differs > low.canopy.positions.length / 3 / 2, 'normals leave the pure canopy-centre direction');
  for (let i = 0; i < full.canopy.positions.length; i += 3) {
    const v = [0, 1, 2].map((k) => full.canopy.positions[i + k] - full.center[k]);
    assert.ok(Math.abs(full.canopy.normals[i] - v[0] / Math.hypot(...v)) < 1e-6, 'detail 2 stays purely radial');
  }
});

test('an invalid detail throws a RangeError that names the fix', () => {
  for (const make of Object.values(makers))
    for (const detail of [3, -1, 1.5, '2', null])
      assert.throws(() => make({ detail }), { name: 'RangeError', message: /Invalid mesh detail; pass 0, 1 or 2/ });
});
