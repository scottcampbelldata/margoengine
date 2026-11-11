import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeRefractedLightmap as bake, scatterRough, smithLambda, smithNormal } from '../dist/refracted.js';

// Unpolarized dielectric Fresnel reflectance, written out independently of optics.ts.
function fresnel(cosine, n1, n2) {
  const sin2 = (n1 / n2) ** 2 * (1 - cosine * cosine);
  if (sin2 >= 1) return 1;
  const ct = Math.sqrt(1 - sin2),
    rs = (n1 * cosine - n2 * ct) / (n1 * cosine + n2 * ct),
    rp = (n1 * ct - n2 * cosine) / (n1 * ct + n2 * cosine);
  return 0.5 * (rs * rs + rp * rp);
}

// Deterministic generator so every count below is exact on every machine.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296;
}
const macro = [0, 0, 1],
  tangent = [1, 0, 0],
  down = (theta) => [Math.sin(theta), 0, -Math.cos(theta)];

test('Smith Lambda is zero at normal incidence and follows Lambda(-w) = -1 - Lambda(w)', () => {
  const alpha = [0.4, 0.7];
  assert.equal(smithLambda([0, 0, 1], alpha), 0);
  for (const w of [
    [0.3, 0.2, 0.932737905308882],
    [0.8, -0.1, 0.591607978309962],
  ]) {
    const up = smithLambda(w, alpha),
      below = smithLambda([-w[0], -w[1], -w[2]], alpha);
    assert.ok(up > 0);
    assert.ok(Math.abs(below + 1 + up) < 1e-12, `${below} vs ${-1 - up}`);
  }
});

test('sampled visible normals are unit length and face the viewer', () => {
  const random = lcg(5);
  for (let i = 0; i < 2000; i++) {
    const view = [0.6, 0.1, Math.sqrt(1 - 0.37)],
      m = smithNormal(view, [0.5, 0.2], random(), random());
    assert.ok(Math.abs(Math.hypot(...m) - 1) < 1e-12);
    assert.ok(m[2] > 0);
    assert.ok(m[0] * view[0] + m[1] * view[1] + m[2] * view[2] > -1e-12);
  }
});

test('the microsurface walk conserves every photon: it leaves reflected or transmitted, never masked', () => {
  const random = lcg(11);
  let reflected = 0,
    transmitted = 0;
  for (let i = 0; i < 20000; i++) {
    const r = scatterRough(down(1.1), macro, tangent, [0.8, 0.8], 1, 1.5, 32, random);
    if (r.truncated) continue;
    assert.ok(Math.abs(Math.hypot(...r.direction) - 1) < 1e-9);
    // A transmitted photon leaves below the macro surface, a reflected one above it.
    if (r.transmitted) {
      transmitted++;
      assert.ok(r.direction[2] < 0);
    } else {
      reflected++;
      assert.ok(r.direction[2] > 0);
    }
    assert.equal(r.events, r.reflections + r.refractions);
  }
  assert.ok(reflected > 0 && transmitted > 0);
  assert.ok(reflected + transmitted > 19900, `${reflected + transmitted} of 20000 escaped within 32 events`);
});

test('a near-smooth walk transmits the smooth Fresnel share in one event', () => {
  const random = lcg(3),
    theta = 0.9,
    count = 40000;
  let transmitted = 0,
    events = 0;
  for (let i = 0; i < count; i++) {
    const r = scatterRough(down(theta), macro, tangent, [1e-4, 1e-4], 1, 1.5, 32, random);
    if (r.transmitted) transmitted++;
    events += r.events;
  }
  const expected = 1 - fresnel(Math.cos(theta), 1, 1.5),
    sigma = Math.sqrt((expected * (1 - expected)) / count);
  assert.ok(Math.abs(transmitted / count - expected) < 5 * sigma, `${transmitted / count} vs ${expected}`);
  assert.equal(events, count);
});

test('anisotropic roughness spreads light along its rough axis only', () => {
  const random = lcg(9);
  let along = 0,
    across = 0;
  for (let i = 0; i < 20000; i++) {
    const r = scatterRough([0, 0, -1], macro, tangent, [0.8, 0.05], 1, 1.5, 32, random);
    if (r.truncated) continue;
    along += Math.abs(r.direction[0]);
    across += Math.abs(r.direction[1]);
  }
  assert.ok(along > 8 * across, `along ${along} across ${across}`);
});

test('the bake accepts [U, V] roughness with a direction and rejects malformed pairs', async () => {
  const floor = { positions: Float32Array.from([-5, 0, -5, -5, 0, 5, 5, 0, 5, 5, 0, -5]) },
    slab = {
      positions: Float32Array.from([
        -10, 1, -10, 10, 1, -10, 10, 1, 10, -10, 1, 10, -10, 2, -10, -10, 2, 10, 10, 2, 10, 10, 2, -10,
      ]),
      indices: Uint32Array.from([
        0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 3, 5, 0, 5, 4, 1, 7, 6, 1, 6, 2, 0, 4, 7, 0, 7, 1, 3, 2, 6, 3, 6, 5,
      ]),
      ior: 1.5,
    },
    options = (volume) => ({
      glassVolumes: [volume],
      emitters: [
        {
          type: 'directional',
          direction: [0, 1, 0],
          aperture: { corner: [-0.5, 3, -0.5], edgeU: [1, 0, 0], edgeV: [0, 0, 1] },
        },
      ],
      photons: 2048,
      seed: 4,
      texelsPerUnit: 4,
      maxAtlasSize: 128,
    });
  const result = await bake(floor, options({ ...slab, roughness: [0.7, 0.1], roughnessDirection: [0, 0, 1] }));
  assert.deepEqual(result.diagnostics.masked, [0, 0, 0]);
  await assert.rejects(bake(floor, options({ ...slab, roughness: [0.5] })), TypeError);
  await assert.rejects(bake(floor, options({ ...slab, roughness: [0.5, 2] })), RangeError);
  await assert.rejects(bake(floor, options({ ...slab, roughness: [0.5, 0.5], roughnessDirection: [0, 0, 0] })));
});
