// bakeDirectionalLightmap (./directional): a main light direction and directional colour per texel, so normal maps
// still respond to baked light.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeDirectionalLightmap, directionalIrradiance } from '../dist/directional.js';
import { bakeMeshLightmap } from '../dist/mesh.js';

const floor = new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
  uv1 = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices = new Uint32Array([0, 1, 2, 0, 2, 3]),
  mesh = { positions: floor, uv1, indices },
  unit = (v) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  },
  close = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);

test('the flat lightmap is the mesh bake, texel for texel', async () => {
  const options = {
      width: 16,
      lights: [
        { type: 'point', position: [1, 2, -1], intensity: 6 },
        { type: 'directional', direction: [0.3, 1, 0.2], intensity: 2, color: [1, 0.5, 0.25] },
        { type: 'ambient', intensity: 0.1 },
      ],
      occluders: [{ positions: new Float32Array([1.5, 1, -1.5, 3, 1, -1.5, 3, 1, -3]) }],
    },
    flat = await bakeMeshLightmap(mesh, options),
    directional = await bakeDirectionalLightmap(mesh, options);
  assert.equal(directional.samples, flat.samples);
  assert.equal(directional.rays, flat.rays);
  assert.equal(directional.lightmapScale, flat.lightmapScale);
  for (let i = 0; i < flat.irradiance.length; i++)
    close(directional.irradiance[i], flat.irradiance[i], 1e-5, `texel ${i}`);
  assert.deepEqual(directional.lightmap, flat.lightmap);
});

test('one light plus ambient: the direction is the light and any mapped normal gets the exact light', async () => {
  const toward = [0.6, 1, -0.3],
    d = unit(toward),
    baked = await bakeDirectionalLightmap(mesh, {
      width: 8,
      radiometry: 'physical',
      lights: [
        { type: 'directional', direction: toward, intensity: 3, color: [1, 0.8, 0.6] },
        { type: 'ambient', intensity: 0.25 },
      ],
    }),
    colour = [3, 2.4, 1.8];
  for (let i = 0; i < 64; i++) {
    for (let a = 0; a < 3; a++) close(baked.direction[i * 3 + a], d[a], 1e-6, 'direction');
    close(baked.directionality[i], 1, 1e-6, 'directionality');
    for (let a = 0; a < 3; a++) close(baked.directional[i * 3 + a], colour[a], 1e-4, 'directional colour');
    // Normal-mapped normals: exact Lambert light from the one light, plus the ambient.
    for (const n of [d, [0, 1, 0], unit([-0.5, 1, 0.4]), unit([1, 0.2, 0]), [-d[0], 0.05, -d[2]]]) {
      const got = directionalIrradiance(baked, i, n, [0, 1, 0]),
        cos = Math.max(
          0,
          unit(n).reduce((s, x, a) => s + x * d[a], 0),
        );
      for (let a = 0; a < 3; a++) close(got[a], colour[a] * cos + 0.25, 1e-4, `light on ${n}`);
    }
  }
  // The RGBA8 maps encode the same: direction biased by 0.5, alpha the directionality.
  assert.equal(baked.directionMap[3], 255);
  for (let a = 0; a < 3; a++) close(baked.directionMap[a] / 255, d[a] * 0.5 + 0.5, 0.5 / 255, 'direction map');
  close((baked.directionalMap[0] / 255) * baked.directionalScale, 3, (0.5 / 255) * baked.directionalScale, 'map');
});

test('a point light: each texel points at it; two opposed lights lower the directionality', async () => {
  const position = [1, 2, -3],
    baked = await bakeDirectionalLightmap(mesh, {
      width: 4,
      radiometry: 'physical',
      lights: [{ type: 'point', position, intensity: 5 }],
    });
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const i = y * 4 + x,
        p = [(x + 0.5) * 1, 0, -(y + 0.5) * 1],
        d = unit(position.map((v, a) => v - p[a]));
      for (let a = 0; a < 3; a++) close(baked.direction[i * 3 + a], d[a], 1e-5, 'toward the light');
      // At the unmapped normal the result is the flat irradiance.
      const flat = directionalIrradiance(baked, i, [0, 2, 0], [0, 1, 0]);
      for (let a = 0; a < 3; a++) close(flat[a], baked.irradiance[i * 3 + a], 1e-6, 'exact at n0');
    }
  const opposed = await bakeDirectionalLightmap(mesh, {
    width: 4,
    radiometry: 'physical',
    lights: [
      { type: 'directional', direction: [1, 1, 0], intensity: 2 },
      { type: 'directional', direction: [-1, 1, 0], intensity: 2 },
    ],
  });
  for (let i = 0; i < 16; i++) {
    for (let a = 0; a < 3; a++) close(opposed.direction[i * 3 + a], [0, 1, 0][a], 1e-6, 'mean direction');
    close(opposed.directionality[i], Math.SQRT1_2, 1e-6, 'directionality of two lights 90 degrees apart');
    // Exact where the fit is anchored, and the mapped normal tilted at one light gains light.
    const at0 = directionalIrradiance(opposed, i, [0, 1, 0], [0, 1, 0]),
      tilted = directionalIrradiance(opposed, i, [1, 1, 0], [0, 1, 0]);
    close(at0[0], opposed.irradiance[i * 3], 1e-5, 'n0');
    assert.ok(tilted[0] >= 0 && tilted[0] <= at0[0] + 1e-5, 'a tilt off the mean direction never adds light');
  }
});

test('legacy radiometry scales the directional colour by AO; shadowed texels keep only ambient', async () => {
  const wall = new Float32Array([0, 0, -2, 4, 0, -2, 4, 4, -2, 0, 4, -2]),
    baked = await bakeDirectionalLightmap(mesh, {
      width: 8,
      aoDistance: 2,
      lights: [
        { type: 'directional', direction: [0, 1, 0], intensity: 2 },
        { type: 'ambient', intensity: 0.5 },
      ],
      occluders: [
        { positions: new Float32Array([0, 1, 0, 4, 1, 0, 4, 1, -1]), indices: new Uint32Array([0, 1, 2]) },
        { positions: wall, indices },
      ],
    });
  let shadowed = 0,
    darker = 0;
  for (let i = 0; i < 64; i++) {
    const o = baked.ao[i * 4] / 255;
    if (baked.direction[i * 3 + 1] === 0) {
      shadowed++;
      for (let a = 0; a < 3; a++) assert.equal(baked.directional[i * 3 + a], 0);
      const lit = directionalIrradiance(baked, i, [0.3, 1, 0], [0, 1, 0]);
      close(lit[0], baked.irradiance[i * 3], 1e-6, 'no direction, no change');
    } else {
      close(baked.directional[i * 3], 2 * o, 2 / 255 + 1e-5, 'directional times AO');
      if (o < 0.95) darker++;
    }
  }
  assert.ok(shadowed > 0 && darker > 0, `${shadowed} shadowed, ${darker} occluded`);
});

test('bad input fails naming the entry; bad lookups throw', async () => {
  await assert.rejects(bakeDirectionalLightmap(mesh, { width: 0 }), /bakeDirectionalLightmap width/);
  await assert.rejects(bakeDirectionalLightmap({ ...mesh, uv1: new Float32Array(3) }), /bakeDirectionalLightmap uv1/);
  const baked = await bakeDirectionalLightmap(mesh, {
    width: 2,
    lights: [{ type: 'directional', direction: [0, 1, 0] }],
  });
  assert.throws(() => directionalIrradiance(baked, 4, [0, 1, 0], [0, 1, 0]), /outside the 2 x 2/);
  assert.throws(() => directionalIrradiance(baked, 0, [0, 0, 0], [0, 1, 0]), /normal must be finite/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(bakeDirectionalLightmap(mesh, { signal: abort.signal }), { name: 'AbortError' });
});
