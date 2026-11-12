// Reflection probe level blend (packages/environment/src/probes.ts probeRadiance, KB-A3c): two levels bracketing a
// roughness are mixed by GGX alpha, not by roughness, so a low-roughness lobe is not widened by the rougher level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materialRoughness, output } from '../examples/package-benchmarks/parts/display.mjs';
import {
  mirrorWallTruth,
  probeLevelBlend,
  room,
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
  },
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// The bake's octahedral decode (unnormalised: its length gives the texel solid angle) and the shader's encode.
const octRaw = (u, v) => {
  const f = [u * 2 - 1, v * 2 - 1],
    n = [f[0], 1 - Math.abs(f[0]) - Math.abs(f[1]), f[1]],
    t = Math.max(-n[1], 0);
  n[0] += n[0] >= 0 ? -t : t;
  n[2] += n[2] >= 0 ? -t : t;
  return n;
};
const octEncode = (d) => {
  const s = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]),
    a = d.map((v) => v / s);
  let q = [a[0], a[2]];
  if (a[1] < 0) q = [(1 - Math.abs(a[2])) * (a[0] >= 0 ? 1 : -1), (1 - Math.abs(a[0])) * (a[2] >= 0 ? 1 : -1)];
  return q.map((v) => v * 0.5 + 0.5);
};

test('the WGSL blends the two levels by GGX alpha, as the CPU mirror does', () => {
  const probes = readFileSync(new URL('../packages/environment/src/probes.ts', import.meta.url), 'utf8');
  assert.ok(probes.includes('let x=clamp(rough,0.0,1.0)*f32(levels-1u);let k0=min(u32(x),levels-2u);let k=f32(k0);'));
  assert.ok(probes.includes('probeLevel(o0+s0*s0,b.data.y>>(k0+1u),uv),(x*x-k*k)/(2.0*k+1.0));'));
  assert.ok(!probes.includes('lod=clamp(rough,0.0,1.0)*f32(levels-1u)'));
  const gpu = readFileSync(new URL('../examples/package-benchmarks/probes-gpu.mjs', import.meta.url), 'utf8');
  assert.match(gpu, /const \{ k0, weight \} = probeLevelBlend\(rough, levels\);/);
});

test('each level is read alone at its own roughness and the blend matches the lobe width', () => {
  for (const levels of [3, 6, 7]) {
    for (let k = 0; k < levels; k++) {
      const { k0, weight } = probeLevelBlend(k / (levels - 1), levels);
      assert.equal(k0 + weight, k, `${levels} levels, level ${k}`);
    }
    let last = -1;
    for (let i = 0; i <= 1000; i++) {
      const rough = i / 1000,
        { k0, weight } = probeLevelBlend(rough, levels),
        lod = k0 + weight;
      assert.ok(weight >= 0 && weight <= 1 && lod >= last - 1e-12, `${levels}: ${rough}`);
      last = lod;
      // The mixed alpha of the two levels equals the material's alpha.
      const a0 = (k0 / (levels - 1)) ** 2,
        a1 = ((k0 + 1) / (levels - 1)) ** 2;
      assert.ok(Math.abs(a0 + (a1 - a0) * weight - rough * rough) < 1e-12, `${levels}: ${rough}`);
    }
  }
  // A 128 probe (6 levels) at core's 0.045 roughness floor: 5.06% of the 0.2 level, not 22.5%.
  const floor = probeLevelBlend(0.045, 6);
  assert.equal(floor.k0, 0);
  assert.ok(Math.abs(floor.weight - 0.050625) < 1e-12, `${floor.weight}`);
});

// probes-gpu check 4 on the CPU: a 128 probe of the room at [0, 1.5, 0] (level 0 = the walls, level 1 = the bake's
// full-source GGX convolution of level 0 at roughness 0.2), the 0.045 mirror floor seen from the probes.html camera,
// shaded through the box projection and compared with the physical truth (wall points 0.4 m or more from an edge).
const mirrorFloor = (blend) => {
  const R = 128,
    levels = 6,
    P = [0, 1.5, 0],
    rough = materialRoughness(0);
  const source = [];
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++) {
      const p = octRaw((x + 0.5) / R, (y + 0.5) / R),
        r = Math.hypot(...p),
        l = p.map((v) => v / r);
      source.push({ l, w: r ** -3, L: colors[wallAt(P, l).wall] });
    }
  const level1 = new Map(),
    s1 = R >> 1,
    a2 = (1 / (levels - 1)) ** 4;
  const texel = (k, x, y) => {
    if (k === 0) return source[y * R + x].L;
    const key = y * s1 + x;
    if (!level1.has(key)) {
      const n = norm(octRaw((x + 0.5) / s1, (y + 0.5) / s1)),
        sum = [0, 0, 0, 0];
      for (const { l, w, L } of source) {
        const nl = dot(n, l);
        if (nl <= 0) continue;
        const nh = dot(n, norm(n.map((v, i) => v + l[i]))),
          q = nh * nh * (a2 - 1) + 1,
          wt = (a2 / (q * q)) * nl * w;
        for (let c = 0; c < 3; c++) sum[c] += L[c] * wt;
        sum[3] += wt;
      }
      level1.set(
        key,
        sum.slice(0, 3).map((v) => v / sum[3]),
      );
    }
    return level1.get(key);
  };
  const bilinear = (k, uv) => {
    const s = R >> k,
      st = uv.map((v) => Math.min(s - 1, Math.max(0, v * s - 0.5))),
      i = st.map(Math.floor),
      j = i.map((v) => Math.min(v + 1, s - 1)),
      f = st.map((v, q) => v - i[q]),
      mix = (a, b, w) => a.map((v, q) => v + (b[q] - v) * w);
    return mix(
      mix(texel(k, i[0], i[1]), texel(k, j[0], i[1]), f[0]),
      mix(texel(k, i[0], j[1]), texel(k, j[0], j[1]), f[0]),
      f[1],
    );
  };
  const { k0, weight } = blend(rough, levels);
  assert.equal(k0, 0);
  const eye = [0, 1.6, 1.7],
    forward = norm([0, -0.5, -2.7]),
    right = [1, 0, 0],
    up = cross(right, forward).map((v) => -v),
    tan = Math.tan(Math.PI / 6),
    diffs = [];
  for (let py = 4; py < 720; py += 6)
    for (let px = 4; px < 1280; px += 6) {
      const sx = (((px + 0.5) / 1280) * 2 - 1) * tan * (1280 / 720),
        sy = (1 - ((py + 0.5) / 720) * 2) * tan,
        d = norm(forward.map((v, i) => v + sx * right[i] + sy * up[i]));
      if (d[1] >= 0) continue;
      const p = eye.map((v, i) => v - (d[i] * eye[1]) / d[1]);
      if (Math.abs(p[0]) > 1.9 || Math.abs(p[2]) > 1.9 || -d[1] < 0.25) continue;
      const r = [d[0], -d[1], d[2]],
        { hit } = wallAt(p, r),
        edge = hit
          .map((v, k) => Math.min(Math.abs(v - room.min[k]), Math.abs(v - room.max[k])))
          .sort((a, b) => a - b)[1];
      if (edge < 0.4) continue;
      const uv = octEncode(norm(hit.map((v, i) => v - P[i]))),
        a = bilinear(0, uv),
        b = bilinear(1, uv),
        sw = splitSum([1, 1, 1], -d[1], rough),
        got = output.core(a.map((v, c) => (v + (b[c] - v) * weight) * sw[c])),
        truth = mirrorWallTruth(colors, p, r, -d[1], rough);
      diffs.push(Math.max(...got.map((g, c) => Math.abs(g - truth[c]))));
    }
  diffs.sort((a, b) => a - b);
  return { samples: diffs.length, p95: diffs[Math.floor(diffs.length * 0.95)], max: diffs.at(-1) };
};

test('the 0.045 mirror floor shows the walls within 3/255 at the 95th percentile', () => {
  const fixed = mirrorFloor(probeLevelBlend);
  assert.ok(fixed.samples > 2000, `${fixed.samples}`);
  assert.ok(fixed.p95 <= 3, `p95 ${fixed.p95}/255`);
  // The old roughness-linear blend fails the same comparison (KB-A3c: p95 4, max 9 on the Radeon 680M).
  const linear = mirrorFloor((rough, levels) => {
    const x = rough * (levels - 1),
      k0 = Math.floor(x);
    return { k0, weight: x - k0 };
  });
  assert.ok(linear.p95 > 3, `old blend p95 ${linear.p95}/255`);
});
