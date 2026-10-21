import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeLightmap } from '../dist/index.js';

const floor = {
  positions: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0]),
  albedo: new Float32Array([1, 0.25, 0, 1]),
  emission: new Float32Array([0, 0, 0]),
};
const options = {
  texelsPerUnit: 4,
  padding: 2,
  maxAtlasSize: 64,
  aoRays: 16,
  aoDistance: 4,
  lights: [{ type: 'directional', direction: [0, 1, 0], intensity: 2 }],
};
const texel = (out, texture, chart = 0) => {
  const c = out.charts[chart];
  return out.textures[texture][((c.y + 2) * out.width + c.x + 2) * 4];
};

test('each quad gets its own padded chart; shadows and occlusion are traced', async () => {
  const open = await bakeLightmap(floor, options),
    covered = {
      positions: new Float32Array([...floor.positions, 0, 0.5, 0, 1, 0.5, 0, 1, 0.5, 1, 0, 0.5, 1]),
      albedo: new Float32Array([1, 0.25, 0, 1, 1, 1, 1, 1]),
    },
    shaded = await bakeLightmap(covered, options);
  assert.equal(open.charts.length, 1);
  assert.equal(open.samples, 16);
  assert.equal((texel(open, 'lightmap') * open.lightmapScale) / 255, 2);
  assert.equal(texel(shaded, 'lightmap'), 0);
  assert.equal(texel(open, 'ao'), 255);
  assert.ok(texel(shaded, 'ao') < 255);
  const [a, b] = shaded.charts;
  assert.ok(a.x + a.width + 4 <= b.x || a.y + a.height + 4 <= b.y, 'gutters never overlap');
  assert.equal(open.uv.length, 8);
  assert.deepEqual([...floor.positions], [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0]);
});

test('the surface callback sets materials per texel; gutters repeat the edge texels', async () => {
  const out = await bakeLightmap(floor, {
      ...options,
      surface: ({ uv }) => ({ albedo: [uv[0], 0, 0, 1], roughness: 0.25, metalness: 0.75, emission: [3, 0, 0] }),
    }),
    c = out.charts[0],
    at = (c.y * out.width + c.x) * 4;
  assert.equal(out.textures.albedo[at], 99, 'sRGB of linear 0.125');
  assert.equal(out.textures.albedo[at - 4], 99, 'the gutter repeats the edge');
  assert.equal(out.textures.orm[at + 1], 64);
  assert.equal(out.textures.orm[at + 2], 191);
  assert.equal(out.emissionScale, 3);
  assert.deepEqual([...out.textures.normal.slice(at, at + 3)], [128, 128, 255]);
});

test('budgets, malformed quads and cancellation fail before any texel is baked', async () => {
  await assert.rejects(() => bakeLightmap(floor, { ...options, maxSamples: 15 }), /maxSamples/);
  await assert.rejects(() => bakeLightmap(floor, { ...options, maxRays: 1 }), /maxRays/);
  await assert.rejects(() => bakeLightmap(floor, { ...options, maxBytes: 100 }), /maxBytes/);
  await assert.rejects(
    () => bakeLightmap({ ...floor, positions: new Float32Array(11) }, options),
    /12 floats per quad/,
  );
  const skewed = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 1]) };
  await assert.rejects(() => bakeLightmap(skewed, options), /not a parallelogram/);
  await assert.rejects(() => bakeLightmap(floor, { ...options, padding: 0 }), RangeError);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    () =>
      bakeLightmap(floor, {
        ...options,
        onProgress: () => {
          calls++;
          controller.abort();
        },
        signal: controller.signal,
      }),
    /abort/i,
  );
  assert.equal(calls, 1);
});
