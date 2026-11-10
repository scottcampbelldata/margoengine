import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '../dist/index.js';

// Batch 132 audit: the CPU ray test was Moller-Trumbore in float64, and about 7% of rays aimed at a random shared edge
// of two non-coplanar triangles missed both (barycentrics of -1e-16 on each side). The watertight test of Woop,
// Benthin and Wald (JCGT 2013) gives the shared edge exactly opposite values in the two triangles.
test('a ray through the shared edge of two triangles hits at least one of them', () => {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const point = () => [0, 1, 2].map(() => Math.fround(random() * 20 - 10));
  let fans = 0;
  for (let i = 0; i < 4000; i++) {
    const a = point(),
      b = point(),
      c = point(),
      d = point(),
      s = random(),
      edge = [0, 1, 2].map((k) => b[k] + (c[k] - b[k]) * s),
      origin = [random() * 40 - 20, random() * 40 - 20, random() * 40 + 10],
      toward = (p, k) => [0, 1, 2].map((j) => edge[j] + k * (p[j] - edge[j]) - origin[j]),
      bvh = MeshBVH.build({
        positions: Float32Array.from([...a, ...b, ...c, ...d]),
        indices: Uint32Array.of(0, 1, 2, 2, 1, 3),
      });
    // Only fans whose two triangles lie on opposite sides of the edge as seen from the origin.
    const nearA = bvh.raycast({ origin, direction: toward(a, 1e-4) }),
      nearD = bvh.raycast({ origin, direction: toward(d, 1e-4) });
    if (nearA.length !== 1 || nearA[0].faceIndex !== 0 || nearD.length !== 1 || nearD[0].faceIndex !== 1) continue;
    fans++;
    const direction = [0, 1, 2].map((k) => edge[k] - origin[k]);
    assert.ok(bvh.raycastFirst({ origin, direction }), `ray ${i} through the shared edge missed both triangles`);
  }
  assert.ok(fans > 1000, `only ${fans} fans tested`);
});
