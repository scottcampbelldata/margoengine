// bakeMeshLightmap (./mesh): any triangle mesh baked at its own second UV set.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeLightmap } from '../dist/index.js';
import { bakeMeshLightmap } from '../dist/mesh.js';

const floor = new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
  floorUV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  floorIndices = new Uint32Array([0, 1, 2, 0, 2, 3]),
  lights = [
    { type: 'point', position: [1, 2, -1], intensity: 6 },
    { type: 'directional', direction: [0.3, 1, 0.2], intensity: 2 },
  ],
  blocker = new Float32Array([1.5, 1, -1.5, 3, 1, -1.5, 3, 1, -3, 1.5, 1, -3]);

test('two triangles with a quad layout bake the same light as the quad baker', async () => {
  const quad = await bakeLightmap(
      { positions: new Float32Array([...floor, ...blocker]) },
      { texelsPerUnit: 4, radiometry: 'physical', lights, maxAtlasSize: 64 },
    ),
    mesh = await bakeMeshLightmap(
      { positions: floor, uv1: floorUV, indices: floorIndices },
      {
        width: 16,
        height: 16,
        radiometry: 'physical',
        lights,
        occluders: [{ positions: blocker, indices: floorIndices }],
      },
    ),
    c = quad.charts[0];
  assert.equal(mesh.samples, 256);
  assert.equal(mesh.radiometry, 'physical');
  // Both store RGB divided by their largest value; their texel centres are the same points.
  let shadowed = 0;
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const at = ((c.y + y) * quad.width + c.x + x) * 4,
        expected = (quad.textures.lightmap[at] * quad.lightmapScale) / 255,
        got = mesh.irradiance[(y * 16 + x) * 3];
      // One RGB8 step of the quad baker's encoding, half each way.
      assert.ok(Math.abs(got - expected) <= quad.lightmapScale / 510 + 1e-6, `${x},${y}: ${got} vs ${expected}`);
      if (got < 1) shadowed++;
    }
  assert.ok(shadowed > 4, 'the occluder casts a shadow');
});

// A unit cube, two triangles a face, each face its own 14 x 14 chart in a 3 x 2 grid of 16-texel cells.
function cube() {
  const faces = [
      [
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
      ],
      [
        [-1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, -1],
      ],
      [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, -1],
        [-1, 0, 0],
        [0, 1, 0],
      ],
    ],
    positions = [],
    uv1 = [],
    indices = [];
  faces.forEach(([n, t, b], f) => {
    const cx = (f % 3) * 16 + 1,
      cy = Math.floor(f / 3) * 16 + 1;
    for (const [s, r] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      positions.push(...[0, 1, 2].map((a) => n[a] + s * t[a] + r * b[a]));
      uv1.push((cx + ((s + 1) / 2) * 14) / 48, (cy + ((1 - r) / 2) * 14) / 32);
    }
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return {
    faces,
    mesh: {
      positions: new Float32Array(positions),
      uv1: new Float32Array(uv1),
      indices: new Uint16Array(indices),
    },
  };
}

test('a cube bakes each face at its own UVs: Lambert irradiance on every chart texel, dilated gutters', async () => {
  const { faces, mesh } = cube(),
    d = [0.3, 1, 0.2],
    l = Math.hypot(...d),
    baked = await bakeMeshLightmap(mesh, {
      width: 48,
      height: 32,
      radiometry: 'physical',
      dilate: 1,
      lights: [{ type: 'directional', direction: d, intensity: 2 }],
    });
  assert.equal(baked.samples, 6 * 14 * 14);
  assert.equal(baked.overlaps, 0);
  assert.equal(baked.degenerate, 0);
  faces.forEach(([n], f) => {
    // A convex solid never shadows itself: E = intensity * max(0, n . l).
    const expected = 2 * Math.max(0, (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / l),
      cx = (f % 3) * 16 + 1,
      cy = Math.floor(f / 3) * 16 + 1;
    for (let y = cy; y < cy + 14; y++)
      for (let x = cx; x < cx + 14; x++) {
        const at = y * 48 + x;
        assert.equal(baked.triangle[at] >> 1, f, `texel ${x},${y} belongs to face ${f}`);
        assert.ok(Math.abs(baked.irradiance[at * 3] - expected) < 1e-5, `face ${f} texel ${x},${y}`);
      }
    // The one-texel gutter ring is dilated from the chart, so filtering at the border reads the face's light.
    for (const [x, y] of [
      [cx - 1, cy + 5],
      [cx + 14, cy + 5],
      [cx + 5, cy - 1],
      [cx + 5, cy + 14],
    ]) {
      assert.equal(baked.triangle[y * 48 + x], -1);
      assert.equal(baked.lightmap[(y * 48 + x) * 4 + 3], 255);
      assert.ok(Math.abs(baked.irradiance[(y * 48 + x) * 3] - expected) < 1e-5);
    }
  });
  // Without dilation the gutter stays empty (alpha 0).
  const bare = await bakeMeshLightmap(mesh, { width: 48, height: 32, dilate: 0 });
  assert.equal(bare.lightmap[(5 * 48 + 15) * 4 + 3], 0);
  assert.equal(bare.lightmap[(5 * 48 + 14) * 4 + 3], 255);
});

test('conservative rasterization: a sliver that covers no texel centre still gets its texels', async () => {
  // Rows of an 8-texel map have centres at v = 0.4375 and 0.5625; this triangle spans v 0.5 to 0.52 only. Without
  // conservative coverage it would bake nothing.
  const baked = await bakeMeshLightmap(
    {
      positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -0.1]),
      uv1: new Float32Array([0.1, 0.5, 0.9, 0.5, 0.9, 0.52]),
    },
    { width: 8, height: 8, dilate: 0, radiometry: 'physical', lights: [{ type: 'directional', direction: [0, 1, 0] }] },
  );
  assert.ok(baked.samples >= 7, `${baked.samples} texels`);
  for (let x = 1; x < 7; x++) {
    assert.equal(baked.triangle[4 * 8 + x], 0, `texel ${x} of the row below v = 0.5`);
    assert.ok(Math.abs(baked.irradiance[(4 * 8 + x) * 3] - 1) < 1e-6);
  }
  assert.equal(baked.triangle[2 * 8 + 3], -1);
});

test('a triangle of the mesh itself shadows the rest; degenerate UVs and overlaps are counted', async () => {
  const positions = new Float32Array([...floor, ...blocker]),
    uv1 = new Float32Array([...floorUV, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
    indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    options = { width: 16, radiometry: 'physical', lights: [lights[0]] },
    own = await bakeMeshLightmap({ positions, uv1, indices }, options),
    open = await bakeMeshLightmap({ positions: floor, uv1: floorUV, indices: floorIndices }, options);
  assert.equal(own.degenerate, 2);
  let darker = 0;
  for (let i = 0; i < 256; i++) if (own.irradiance[i * 3] < open.irradiance[i * 3] - 1e-6) darker++;
  assert.ok(darker > 4, `${darker} texels in the mesh's own shadow`);
  const twice = await bakeMeshLightmap(
    { positions: floor, uv1: floorUV, indices: new Uint32Array([...floorIndices, ...floorIndices]) },
    { width: 8, dilate: 0 },
  );
  assert.ok(twice.overlaps > 20, `${twice.overlaps} overlapping texels`);
});

test('legacy radiometry multiplies AO; a wall darkens the floor beside it', async () => {
  const wall = new Float32Array([0, 0, -4, 4, 0, -4, 4, 4, -4]),
    baked = await bakeMeshLightmap(
      { positions: floor, uv1: floorUV, indices: floorIndices },
      { width: 8, occluders: [{ positions: wall }], lights: [{ type: 'ambient', intensity: 1 }], aoDistance: 2 },
    );
  assert.equal(baked.radiometry, undefined);
  const near = baked.ao[(7 * 8 + 6) * 4],
    far = baked.ao[(0 * 8 + 1) * 4];
  assert.ok(near < far - 20, `AO near the wall ${near}, away ${far}`);
  assert.ok(baked.irradiance[(7 * 8 + 6) * 3] < baked.irradiance[(0 * 8 + 1) * 3]);
});

test('inputs are checked first and copied before the first await; budgets and abort', async () => {
  const mesh = { positions: floor.slice(), uv1: floorUV.slice(), indices: floorIndices };
  await assert.rejects(bakeMeshLightmap({ ...mesh, uv1: new Float32Array([0, 0, 1.5, 0, 1, 1, 0, 1]) }), /0 to 1/);
  await assert.rejects(bakeMeshLightmap({ ...mesh, indices: new Uint32Array([0, 1, 9]) }), /past the last vertex/);
  await assert.rejects(bakeMeshLightmap({ ...mesh, uv1: floorUV.subarray(0, 6) }), /2 floats per vertex/);
  await assert.rejects(bakeMeshLightmap(mesh, { width: 64, maxSamples: 100 }), /over maxSamples/);
  await assert.rejects(bakeMeshLightmap(mesh, { width: 64, aoRays: 128, maxRays: 1000 }), /over maxRays/);
  await assert.rejects(bakeMeshLightmap(mesh, { width: 2048, maxBytes: 1e6 }), /over maxBytes/);
  await assert.rejects(bakeMeshLightmap(mesh, { radiometry: 'hdr' }), TypeError);
  const abort = new AbortController(),
    pending = bakeMeshLightmap(mesh, { width: 64, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const reference = await bakeMeshLightmap(mesh, { width: 8, lights }),
    progress = [],
    changed = bakeMeshLightmap(mesh, { width: 8, lights, onProgress: (done, total) => progress.push([done, total]) });
  mesh.positions.fill(9);
  mesh.uv1.fill(0);
  assert.deepEqual((await changed).lightmap, reference.lightmap);
  assert.deepEqual(progress.at(-1), [64, 64]);
});

// Batch 54 gap: triangle meshes had no bounce light (only quad charts in ./global). Path-traced bounces with next-event
// estimation, as ./gpu's.
test('bounces in a closed furnace: every texel gets ambient times the geometric series of the reflectance', async () => {
  const { mesh } = cube(),
    inward = new Uint16Array(mesh.indices.length);
  // The same box seen from inside: each triangle wound the other way, so its normal points in.
  for (let t = 0; t < mesh.indices.length; t += 3)
    inward.set([mesh.indices[t], mesh.indices[t + 2], mesh.indices[t + 1]], t);
  const albedo = [0.5, 0.25, 0],
    bounces = 3,
    baked = await bakeMeshLightmap(
      { ...mesh, indices: inward },
      {
        width: 48,
        height: 32,
        radiometry: 'physical',
        lights: [{ type: 'ambient', intensity: 1 }],
        bounces,
        bounceRays: 4,
        albedo,
      },
    );
  // Every path stays inside and every hit sees the ambient light: E = sum over k of rho^k, k = 0 to bounces.
  const expected = albedo.map((rho) => (1 - rho ** (bounces + 1)) / (1 - rho));
  let worst = 0;
  for (let at = 0; at < 48 * 32; at++) {
    if (baked.triangle[at] < 0) continue;
    for (let a = 0; a < 3; a++) worst = Math.max(worst, Math.abs(baked.irradiance[at * 3 + a] - expected[a]));
  }
  assert.ok(worst < 1e-5, `furnace error ${worst}`);
  assert.equal(baked.rays, baked.samples * (32 + 0 + 4 * bounces));
});

test('bounce light comes from what the paths hit: a black wall adds nothing, a white one lights the floor beside it', async () => {
  const wall = { positions: new Float32Array([2, 0, 0, 2, 0, -4, 2, 3, -4, 2, 3, 0]), indices: floorIndices },
    base = {
      width: 16,
      radiometry: 'physical',
      lights: [{ type: 'directional', direction: [-0.5, 1, 0.2], intensity: 2 }],
      seed: 7,
    },
    flat = await bakeMeshLightmap(
      { positions: floor, uv1: floorUV, indices: floorIndices },
      { ...base, occluders: [wall] },
    ),
    black = await bakeMeshLightmap(
      { positions: floor, uv1: floorUV, indices: floorIndices },
      { ...base, occluders: [{ ...wall, albedo: [0, 0, 0] }], bounces: 2, bounceRays: 8 },
    ),
    white = await bakeMeshLightmap(
      { positions: floor, uv1: floorUV, indices: floorIndices },
      { ...base, occluders: [{ ...wall, albedo: [1, 1, 1] }], albedo: [0, 0, 0], bounces: 2, bounceRays: 64 },
    );
  // The floor is flat, so its paths hit only the wall: a black wall reflects nothing and the bake is the direct one.
  assert.deepEqual(black.irradiance, flat.irradiance);
  // The wall at x = 2 faces -x (the light's side is lit): beside it (x near 2) the floor gains more than far from it.
  const gain = (x) => {
    let sum = 0;
    for (let y = 0; y < 16; y++) sum += white.irradiance[(y * 16 + x) * 3] - flat.irradiance[(y * 16 + x) * 3];
    return sum / 16;
  };
  assert.ok(gain(0) > 0, `the floor gains bounce light: ${gain(0)}`);
  assert.ok(gain(7) > gain(0) * 1.5, `more beside the wall: ${gain(7)} vs ${gain(0)}`);
  // Past the wall (x > 2) its back is unlit (the light comes from -x) and the black floor reflects nothing further.
  assert.ok(Math.abs(gain(12)) < 1e-6, `behind the wall: ${gain(12)}`);
});

test('bounce options are checked: physical radiometry, ranges and reflectances', async () => {
  const mesh = { positions: floor, uv1: floorUV, indices: floorIndices };
  await assert.rejects(bakeMeshLightmap(mesh, { bounces: 1 }), /radiometry 'physical'/);
  await assert.rejects(bakeMeshLightmap(mesh, { radiometry: 'physical', bounces: 9 }), RangeError);
  await assert.rejects(bakeMeshLightmap(mesh, { radiometry: 'physical', bounces: 1, bounceRays: 0 }), RangeError);
  await assert.rejects(bakeMeshLightmap(mesh, { radiometry: 'physical', bounces: 1, bounceRays: 1025 }), RangeError);
  await assert.rejects(bakeMeshLightmap(mesh, { radiometry: 'physical', albedo: [1, 2, 0] }), /albedo/);
  await assert.rejects(
    bakeMeshLightmap(mesh, {
      radiometry: 'physical',
      occluders: [{ positions: blocker, indices: floorIndices, albedo: [0.5] }],
    }),
    /occluder 0 albedo/,
  );
  await assert.rejects(
    bakeMeshLightmap(mesh, { radiometry: 'physical', bounces: 8, bounceRays: 1024, width: 512, maxRays: 1e6 }),
    /over maxRays/,
  );
});

test('one bounce off a lit wall matches the exact form factor on every floor texel', async () => {
  // A wall (albedo 0.5) at z = -4 lit head-on lights the floor, which gets no direct light. Each floor texel receives
  // albedo * E_wall * F, F the exact point-to-polygon form factor (Lambert's contour formula); the same scene and
  // reference as ./gpu's bounce check in tests/gpu.browser.mjs.
  const wall = { positions: new Float32Array([0, 0, -4, 4, 0, -4, 4, 4, -4, 0, 4, -4]), indices: floorIndices },
    baked = await bakeMeshLightmap(
      { positions: floor, uv1: floorUV, indices: floorIndices },
      {
        width: 8,
        radiometry: 'physical',
        bounces: 1,
        bounceRays: 1024,
        lights: [{ type: 'directional', direction: [0, 0, 1], intensity: 2 }],
        occluders: [{ ...wall, albedo: [0.5, 0.5, 0.5] }],
        dilate: 0,
      },
    ),
    sub = (a, b) => a.map((v, i) => v - b[i]),
    crossed = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm = (a) => Math.hypot(...a),
    corners = [
      [0, 0, -4],
      [4, 0, -4],
      [4, 4, -4],
      [0, 4, -4],
    ];
  let worst = 0,
    mean = 0;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const p = [(x + 0.5) / 2, 0, -(y + 0.5) / 2];
      let f = 0;
      for (let k = 0; k < 4; k++) {
        const a = sub(corners[k], p),
          b = sub(corners[(k + 1) % 4], p),
          c = crossed(a, b),
          angle = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b)))));
        f += (angle * c[1]) / norm(c);
      }
      const d = baked.irradiance[(y * 8 + x) * 3] - 0.5 * 2 * Math.abs(f / (2 * Math.PI));
      worst = Math.max(worst, Math.abs(d));
      mean += d / 64;
    }
  // 1,024 paths per texel: a standard error of at most 0.5 / 32 per texel; the mean over 64 texels is unbiased.
  assert.ok(worst < 0.06 && Math.abs(mean) < 0.01, JSON.stringify({ worst, mean }));
});
