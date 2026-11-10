// bakeLightProbes (./probes): irradiance probes baked from the same scene and lightmap, so moving objects match the room.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeMeshLightmap } from '../dist/mesh.js';
import { bakeLightProbes, probeIrradiance } from '../dist/probes.js';

const unit = (v) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  },
  close = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`),
  one = { min: [-0.5, 0.5, -0.5], max: [0.5, 1.5, 0.5], counts: [1, 1, 1] };

test('a directional light alone: exact irradiance facing it, the order-3 ringing elsewhere', async () => {
  const d = unit([0.3, 1, -0.4]),
    probes = await bakeLightProbes({ volume: one, lights: [{ type: 'directional', direction: d, intensity: 2 }] });
  assert.equal(probes.count, 1);
  assert.deepEqual([...probes.positions], [0, 1, 0]);
  const facing = probeIrradiance(probes, [0, 1, 0], d);
  for (const v of facing) close(v, 2, 1e-5, 'facing the light');
  // Three bands of a delta light, normalized by 16/17: (16/17) (1/4 + cos / 2 + (5/16)(3 cos^2 - 1) / 2) of it.
  for (const cos of [0.8, 0.3, 0, -0.5, -1]) {
    const side = unit([-d[1], d[0], 0]),
      s = Math.sqrt(1 - cos * cos),
      n = d.map((x, a) => cos * x + s * side[a]),
      expected = Math.max(0, 2 * (16 / 17) * (0.25 + cos / 2 + (5 / 32) * (3 * cos * cos - 1)));
    close(probeIrradiance(probes, [0, 1, 0], n)[0], expected, 1e-5, `cos ${cos}`);
  }
});

test('ambient sky alone gives its irradiance for every normal; a blocker shadows the light', async () => {
  const probes = await bakeLightProbes({
    volume: one,
    lights: [{ type: 'ambient', intensity: 0.5, color: [1, 0.5, 0.25] }],
  });
  for (const n of [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [0.3, -0.2, 0.9],
  ]) {
    const e = probeIrradiance(probes, [0, 1, 0], n);
    close(e[0], 0.5, 0.01, 'red');
    close(e[1], 0.25, 0.005, 'green');
    close(e[2], 0.125, 0.0025, 'blue');
  }
  const roof = new Float32Array([-5, 3, -5, 5, 3, -5, 5, 3, 5, -5, 3, 5]),
    shaded = await bakeLightProbes({
      volume: one,
      lights: [{ type: 'directional', direction: [0, 1, 0], intensity: 2 }],
      occluders: [{ positions: roof, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
    });
  for (const v of shaded.coefficients) assert.equal(v, 0);
});

test('a probe over a baked floor matches the floor lightmap: sky and sun above, its bounce below', async () => {
  const size = 40,
    floor = {
      positions: new Float32Array([-size, 0, size, size, 0, size, size, 0, -size, -size, 0, -size]),
      uv1: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    lights = [
      { type: 'directional', direction: [0, 1, 0], intensity: 2 },
      { type: 'ambient', intensity: 0.3 },
    ],
    lightmap = await bakeMeshLightmap(floor, { width: 8, radiometry: 'physical', lights }),
    albedo = [0.6, 0.5, 0.4];
  for (let i = 0; i < 64; i++) close(lightmap.irradiance[i * 3], 2.3, 1e-5, 'floor lightmap');
  const probes = await bakeLightProbes({
      volume: { min: [-1, 0, -1], max: [1, 2, 1], counts: [2, 2, 2] },
      room: { mesh: floor, lightmap, albedo },
      lights,
      rays: 1024,
    }),
    up = probeIrradiance(probes, [0.2, 0.7, -0.1], [0, 1, 0]),
    down = probeIrradiance(probes, [0.2, 0.7, -0.1], [0, -1, 0]);
  // A character's upward face gets the floor's own light; the downward face the floor's bounce, albedo * 2.3, and the sun's ringing.
  for (let c = 0; c < 3; c++) {
    close(up[c], 2.3, 2.3 * 0.03, 'up matches the lightmap');
    // Plus the sun's order-3 ringing straight behind it: 2 * (16 / 17) * (1/4 - 1/2 + 5/16).
    const bounce = albedo[c] * 2.3 + 2 * (16 / 17) * (1 / 16);
    close(down[c], bounce, bounce * 0.03, 'down is the bounce');
  }
});

test('probes interpolate trilinearly, are seeded, and check their input', async () => {
  const volume = { min: [0, 0, 0], max: [2, 1, 1], counts: [2, 1, 1] },
    lights = [{ type: 'point', position: [0.5, 0.5, 0.5 + 0.25], intensity: 1, distance: 0, decay: 2 }],
    probes = await bakeLightProbes({ volume, lights }),
    n = [0, 0, 1],
    a = probeIrradiance(probes, [0.5, 0.5, 0.5], n),
    b = probeIrradiance(probes, [1.5, 0.5, 0.5], n),
    mid = probeIrradiance(probes, [1, 0.5, 0.5], n);
  close(a[0], 16, 1e-3, 'inverse square at 0.25, facing');
  assert.ok(b[0] < a[0]);
  // Linear between the two centres: no clamp at zero is involved here, as both are positive.
  close(mid[0], (a[0] + b[0]) / 2, 1e-4, 'midpoint');
  const again = await bakeLightProbes({ volume, lights, seed: 0 });
  assert.deepEqual(again.coefficients, probes.coefficients);
  await assert.rejects(
    bakeLightProbes({ volume: { min: [0, 0, 0], max: [1, 1, 1], counts: [0, 1, 1] } }),
    /volume.counts/,
  );
  await assert.rejects(bakeLightProbes({ volume: { min: [0, 0, 0], max: [0, 1, 1], counts: [1, 1, 1] } }), /exceed/);
  await assert.rejects(bakeLightProbes({ volume: one, rays: 8 }), /bakeLightProbes rays/);
  await assert.rejects(bakeLightProbes({ volume: one, maxRays: 10 }), /over maxRays/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(bakeLightProbes({ volume: one, signal: abort.signal }), { name: 'AbortError' });
  assert.throws(() => probeIrradiance(probes, [0, 0, 0], [0, 0, 0]), /normal must be finite/);
});
