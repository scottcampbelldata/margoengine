// The probes-gpu box projection check's truth (examples/package-benchmarks/parts/probe-truth.mjs, KB-A3c ruling: option a).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materialRoughness, output } from '../examples/package-benchmarks/parts/display.mjs';
import {
  ggxPrefiltered,
  mirrorWallTruth,
  splitSum,
  wallAt,
} from '../examples/package-benchmarks/parts/probe-truth.mjs';

const colors = {
  px: [0.8, 0.1, 0.1],
  nx: [0.1, 0.7, 0.1],
  py: [0.9, 0.9, 0.9],
  ny: [0.5, 0.5, 0.5],
  pz: [0.1, 0.2, 0.8],
  nz: [0.8, 0.7, 0.1],
};
const norm = (a) => {
  const l = Math.hypot(...a);
  return a.map((v) => v / l);
};

// Check 4 compared the "roughness 0" mirror floor with a perfect mirror of the walls, but core draws that floor at its
// 0.045 roughness floor (split-sum weight 0.975), a gap b4675ba36's PBR Neutral showed as p95 4/255 on every GPU.
test('probes-gpu judges the mirror floor against the walls at the floor material real roughness', () => {
  const source = readFileSync(new URL('../examples/package-benchmarks/probes-gpu.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /const truth = mirrorWallTruth\(colors, h\.p, \[d\[0\], -d\[1\], d\[2\]\], dot\(h\.n, v\), materialRoughness\(rough\)\);/,
  );
  assert.doesNotMatch(source, /output\.core\(colors\[wall\]\)/);
  assert.match(source, /floor === 'mirror' \? 0 : 0\.5/);
});

test('the split-sum weight is the analytic branch of probeShade', () => {
  const probes = readFileSync(new URL('../packages/environment/src/probes.ts', import.meta.url), 'utf8');
  assert.ok(
    probes.includes(
      'let c=rough*vec4f(-1,-0.0275,-0.572,0.022)+vec4f(1,0.0425,1.04,-0.04);let a=min(c.x*c.x,exp2(-9.28*nv))*c.x+c.y;let sw=f0*(c.z-1.04*a)+f90*(c.w+1.04*a);',
    ),
  );
  // White metal (f0 = f90 = 1): 1 - 0.55 roughness at every angle.
  for (const nv of [1e-4, 0.25, 0.7, 1])
    for (const rough of [0, materialRoughness(0), 0.5, 1])
      for (const w of splitSum([1, 1, 1], nv, rough))
        assert.ok(Math.abs(w - (1 - 0.55 * rough)) < 1e-12, `${nv} ${rough}`);
});

test('the GGX prefilter matches a brute-force convolution of the room', () => {
  const p = [0.3, 0, 0.2],
    radiance = (d) => colors[wallAt(p, d).wall];
  assert.deepEqual(
    ggxPrefiltered(() => [0.25, 0.5, 0.75], norm([0.2, 0.5, -1]), 0.3).map((v) => +v.toFixed(12)),
    [0.25, 0.5, 0.75],
  );
  // Brute force: a fine cube-face sphere grid weighted by D(n.h) n.l over solid angle, as the level 1 to 5 checks do.
  const brute = (r, rough, N = 160) => {
    const a2 = rough ** 4,
      sum = [0, 0, 0, 0];
    for (let f = 0; f < 6; f++)
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const a = ((x + 0.5) / N) * 2 - 1,
            b = ((y + 0.5) / N) * 2 - 1,
            k = f >> 1,
            c = [0, 0, 0];
          c[k] = f & 1 ? -1 : 1;
          c[(k + 1) % 3] = a;
          c[(k + 2) % 3] = b;
          const d = norm(c),
            nl = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
          if (nl <= 0) continue;
          const h = norm(d.map((v, i) => v + r[i])),
            nh = h[0] * r[0] + h[1] * r[1] + h[2] * r[2],
            q = nh * nh * (a2 - 1) + 1,
            w = (a2 / (q * q)) * nl * (1 + a * a + b * b) ** -1.5,
            L = radiance(d);
          for (let ch = 0; ch < 3; ch++) sum[ch] += L[ch] * w;
          sum[3] += w;
        }
    return sum.slice(0, 3).map((v) => v / sum[3]);
  };
  // A lobe across the floor and two walls (from p, toward the room's -x, -z corner).
  const r = norm([-1, 0.3, -1]);
  for (const rough of [0.5, 0.8]) {
    const got = ggxPrefiltered(radiance, r, rough),
      want = brute(r, rough);
    assert.ok(
      got.every((v, k) => Math.abs(v - want[k]) < 0.01),
      `${rough}: ${got} vs ${want}`,
    );
  }
});

test('the wall truth is the room seen at 0.045 roughness times the split-sum weight', () => {
  const rough = materialRoughness(0),
    p = [0, 0, 0.5],
    d = norm([0, -0.5, -1]),
    r = [d[0], -d[1], d[2]];
  assert.equal(wallAt(p, r).wall, 'nz');
  const truth = mirrorWallTruth(colors, p, r, -d[1], rough);
  assert.deepEqual(truth, output.core(colors.nz.map((c) => c * (1 - 0.55 * rough))));
  // The old truth, a perfect mirror, is 3/255 brighter on the yellow wall.
  assert.deepEqual(output.core(colors.nz), [226, 212, 69]);
  assert.deepEqual(truth, [223, 210, 68]);
});
