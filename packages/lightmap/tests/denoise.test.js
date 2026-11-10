// ./denoise: the edge-avoiding a-trous filter (Dammertz et al. 2010) with variance-guided luminance weights (Schied
// et al. 2017). Bounds: noise drops by the factor a 5-pass B3 kernel allows on flat light; edges, charts and creases
// keep their levels within the input noise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { denoiseLightmap, denoiseMeshLightmap, denoiseTexels } from '../dist/denoise.js';
import { bakeLightmap } from '../dist/index.js';
import { bakeMeshLightmap } from '../dist/mesh.js';

function gaussian(seed) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** A grey image from `level(x, y)` plus Gaussian noise of standard deviation `noise`, clamped at 0. */
function image(w, h, level, noise, seed = 1) {
  const g = gaussian(seed),
    color = new Float32Array(w * h * 3),
    truth = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x,
        v = level(x, y);
      truth[p] = v;
      const noisy = Math.max(0, v + noise * g());
      color.set([noisy, noisy, noisy], p * 3);
    }
  return { width: w, height: h, color, truth };
}

const rmse = (color, truth, keep = () => true) => {
  let sum = 0,
    n = 0;
  for (let p = 0; p < truth.length; p++) {
    if (!keep(p)) continue;
    sum += (color[p * 3 + 1] - truth[p]) ** 2;
    n++;
  }
  return Math.sqrt(sum / n);
};
const columnMean = (color, w, h, x) => {
  let sum = 0;
  for (let y = 0; y < h; y++) sum += color[(y * w + x) * 3 + 1];
  return sum / h;
};

test('flat noisy light: the error falls at least fourfold', async () => {
  const img = image(64, 64, () => 1, 0.1),
    before = rmse(img.color, img.truth),
    { color, variance } = await denoiseTexels(img);
  const after = rmse(color, img.truth);
  // Five B3 passes average about 60 texels' worth of independent noise: a fourfold drop leaves room for edge weights.
  assert.ok(after < before / 4, `${before} -> ${after}`);
  assert.ok(variance.every((v) => v >= 0));
  assert.deepEqual(img.color, image(64, 64, () => 1, 0.1).color, 'input unchanged');
});

test('a hard shadow edge keeps both levels while the noise goes', async () => {
  const w = 64,
    h = 32,
    img = image(w, h, (x) => (x < 32 ? 1 : 0.1), 0.02),
    { color } = await denoiseTexels(img);
  // The texels on each side of the edge stay within the input noise (0.02) of their level.
  assert.ok(Math.abs(columnMean(color, w, h, 31) - 1) < 0.02, `${columnMean(color, w, h, 31)}`);
  assert.ok(Math.abs(columnMean(color, w, h, 32) - 0.1) < 0.02, `${columnMean(color, w, h, 32)}`);
  assert.ok(rmse(color, img.truth) < rmse(img.color, img.truth) / 2);
});

test('texels never mix across charts and empty texels stay as they are', async () => {
  const w = 32,
    h = 16,
    img = image(w, h, (x) => (x < 16 ? 1 : 0.2), 0.3),
    chart = Int32Array.from({ length: w * h }, (_, p) => (p % w < 16 ? 7 : p % w === 31 ? -1 : 3));
  img.color.set([5, 6, 7], (2 * w + 31) * 3);
  const { color } = await denoiseTexels({ ...img, chart });
  // With noise 0.3 the luminance weights alone would let the levels bleed; the chart ids must stop it.
  assert.ok(Math.abs(columnMean(color, w, h, 15) - 1) < 0.1, `${columnMean(color, w, h, 15)}`);
  assert.ok(Math.abs(columnMean(color, w, h, 16) - 0.2) < 0.1, `${columnMean(color, w, h, 16)}`);
  for (let y = 0; y < h; y++)
    for (let a = 0; a < 3; a++) assert.equal(color[(y * w + 31) * 3 + a], img.color[(y * w + 31) * 3 + a]);
  // Noise-free charts come back exactly.
  const clean = image(w, h, (x) => (x < 16 ? 1 : 0.2), 0),
    out = await denoiseTexels({ ...clean, chart });
  assert.deepEqual(out.color, clean.color);
});

test('normals stop the filter at a crease inside one chart', async () => {
  const w = 32,
    h = 16,
    img = image(w, h, (x) => (x < 16 ? 1 : 0.3), 0.25, 5),
    normals = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) normals.set(p % w < 16 ? [0, 1, 0] : [1, 0, 0], p * 3);
  const guided = (await denoiseTexels({ ...img, normals })).color,
    blind = (await denoiseTexels(img)).color;
  assert.ok(Math.abs(columnMean(guided, w, h, 15) - 1) < 0.08, `${columnMean(guided, w, h, 15)}`);
  assert.ok(Math.abs(columnMean(guided, w, h, 16) - 0.3) < 0.08, `${columnMean(guided, w, h, 16)}`);
  // Without the normals the same noise lets the levels bleed, so the guide is what kept them.
  assert.ok(
    columnMean(blind, w, h, 15) - columnMean(blind, w, h, 16) <
      columnMean(guided, w, h, 15) - columnMean(guided, w, h, 16),
  );
});

test('positions stop the filter at a ledge the normals cannot see', async () => {
  const w = 32,
    h = 8,
    img = image(w, h, (x) => (x < 16 ? 1 : 0.3), 0.25, 9),
    normals = new Float32Array(w * h * 3),
    positions = new Float32Array(w * h * 3);
  // One chart over a floor and a raised step 1 unit up, texels 0.25 apart: every normal is +y, only positions differ.
  for (let p = 0; p < w * h; p++) {
    const x = p % w;
    normals.set([0, 1, 0], p * 3);
    positions.set([x * 0.25, x < 16 ? 0 : 1, Math.floor(p / w) * 0.25], p * 3);
  }
  const ledge = (await denoiseTexels({ ...img, normals, positions })).color,
    flat = (await denoiseTexels({ ...img, normals })).color;
  assert.ok(Math.abs(columnMean(ledge, w, h, 15) - 1) < 0.08, `${columnMean(ledge, w, h, 15)}`);
  assert.ok(Math.abs(columnMean(ledge, w, h, 16) - 0.3) < 0.08, `${columnMean(ledge, w, h, 16)}`);
  assert.ok(
    columnMean(flat, w, h, 15) - columnMean(flat, w, h, 16) < columnMean(ledge, w, h, 15) - columnMean(ledge, w, h, 16),
  );
});

test('noise-free light is kept: constant exactly, a ramp inside its chart within 1e-5', async () => {
  const constant = image(16, 16, () => 0.7, 0),
    out = await denoiseTexels(constant);
  assert.deepEqual(out.color, constant.color);
  const ramp = image(64, 8, (x) => 0.1 + x / 64, 0),
    smooth = (await denoiseTexels(ramp, { iterations: 3 })).color;
  // Three passes reach 14 texels; a symmetric kernel keeps a linear ramp beyond that from either border.
  for (let y = 0; y < 8; y++)
    for (let x = 15; x < 49; x++) assert.ok(Math.abs(smooth[(y * 64 + x) * 3] - ramp.truth[y * 64 + x]) < 1e-5);
});

test('a supplied variance of zero keeps the texels exactly; a larger sigma smooths more', async () => {
  const img = image(32, 32, () => 1, 0.1, 3),
    still = await denoiseTexels({ ...img, variance: new Float32Array(32 * 32) });
  assert.deepEqual(still.color, img.color);
  const narrow = rmse((await denoiseTexels(img, { sigmaLuminance: 1 })).color, img.truth),
    wide = rmse((await denoiseTexels(img, { sigmaLuminance: 16 })).color, img.truth);
  assert.ok(wide < narrow, `${narrow} ${wide}`);
});

const floor = new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
  floorUV = new Float32Array([0.05, 0.05, 0.95, 0.05, 0.95, 0.95, 0.05, 0.95]),
  floorIndices = new Uint32Array([0, 1, 2, 0, 2, 3]),
  wall = new Float32Array([1, 0, -1, 1, 0, -3, 1, 2, -3, 1, 2, -1]),
  sky = [{ type: 'ambient', intensity: 1 }];

test('a mesh bake with 4 AO rays comes at least twice as close to the 128-ray bake', async () => {
  const mesh = { positions: floor, uv1: floorUV, indices: floorIndices },
    options = { width: 48, lights: sky, occluders: [{ positions: wall, indices: floorIndices }] },
    noisy = await bakeMeshLightmap(mesh, { ...options, aoRays: 4, seed: 11 }),
    reference = await bakeMeshLightmap(mesh, { ...options, aoRays: 128, seed: 12, maxRays: 67_108_864 }),
    clean = await denoiseMeshLightmap(noisy, mesh),
    baked = (p) => noisy.triangle[p] >= 0,
    error = (r) => {
      let sum = 0,
        n = 0;
      for (let p = 0; p < r.triangle.length; p++)
        if (baked(p)) {
          sum += (r.irradiance[p * 3] - reference.irradiance[p * 3]) ** 2;
          n++;
        }
      return Math.sqrt(sum / n);
    };
  assert.ok(error(clean) < error(noisy) / 2, `${error(noisy)} -> ${error(clean)}`);
  assert.equal(clean.triangle, noisy.triangle);
  // Alpha marks the same texels, every dilated texel was refilled, and the scale decodes the new light.
  for (let p = 0; p < noisy.triangle.length; p++) {
    assert.equal(clean.lightmap[p * 4 + 3], noisy.lightmap[p * 4 + 3]);
    if (noisy.lightmap[p * 4 + 3] && !baked(p)) assert.ok(clean.irradiance[p * 3] > 0);
    if (noisy.lightmap[p * 4 + 3])
      assert.ok(
        Math.abs((clean.lightmap[p * 4] / 255) * clean.lightmapScale - clean.irradiance[p * 3]) <=
          clean.lightmapScale / 255,
      );
  }
  assert.ok(noisy.irradiance.some((v, i) => v !== clean.irradiance[i]));
});

test('a quad atlas: the chart texels come closer to the reference and gutters copy the chart edge', async () => {
  const quads = { positions: new Float32Array([...floor, ...wall]) },
    options = { texelsPerUnit: 8, lights: sky, padding: 2 },
    noisy = await bakeLightmap(quads, { ...options, aoRays: 4, seed: 4 }),
    reference = await bakeLightmap(quads, { ...options, aoRays: 128, seed: 5 }),
    clean = await denoiseLightmap(noisy, quads),
    c = noisy.charts[0],
    decode = (atlas, x, y) =>
      (atlas.textures.lightmap[((c.y + y) * atlas.width + c.x + x) * 4] / 255) * atlas.lightmapScale;
  let before = 0,
    after = 0;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      before += (decode(noisy, x, y) - decode(reference, x, y)) ** 2;
      after += (decode(clean, x, y) - decode(reference, x, y)) ** 2;
    }
  assert.ok(after < before / 2, `${before} -> ${after}`);
  for (let y = 0; y < c.height; y++) {
    assert.equal(decode(clean, -1, y), decode(clean, 0, y));
    assert.equal(decode(clean, c.width + 1, y), decode(clean, c.width - 1, y));
  }
  assert.equal(clean.textures.albedo, noisy.textures.albedo);
  assert.notEqual(clean.textures.lightmap, noisy.textures.lightmap);
});

test('bad input throws a RangeError naming the fix; the signal cancels', async () => {
  const img = image(8, 8, () => 1, 0.1);
  await assert.rejects(denoiseTexels({ ...img, color: new Float32Array(5) }), /color must be a Float32Array/);
  await assert.rejects(denoiseTexels({ ...img, width: 0 }), /width/);
  await assert.rejects(denoiseTexels({ ...img, chart: new Int32Array(3) }), /chart/);
  await assert.rejects(denoiseTexels({ ...img, normals: new Float32Array(3) }), /normals/);
  await assert.rejects(denoiseTexels(img, { iterations: 9 }), /iterations/);
  await assert.rejects(denoiseTexels(img, { sigmaLuminance: 0 }), /sigmaLuminance/);
  const nan = img.color.slice();
  nan[4] = Number.NaN;
  await assert.rejects(denoiseTexels({ ...img, color: nan }), /finite/);
  await assert.rejects(denoiseTexels({ ...img, variance: new Float32Array(64).fill(-1) }), /variance/);
  await assert.rejects(denoiseLightmap({}, { positions: floor }), /atlas/);
  await assert.rejects(denoiseMeshLightmap({}, {}), /bakeMeshLightmap/);
  await assert.rejects(denoiseTexels(img, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
