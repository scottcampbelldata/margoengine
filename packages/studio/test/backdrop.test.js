import test from 'node:test';
import assert from 'node:assert/strict';
import { Backdrop, backdropGeometry, stagingLights, stagingLighting, stagingRoom } from '../dist/backdrop.js';
test('cyclorama has a tangent circular bend, unit analytic normals and front-facing triangles', () => {
  const g = backdropGeometry(),
    v = g.vertices;
  assert.equal(v.length / 6, 70);
  assert.equal(g.indices.length, 204);
  for (let i = 0; i < v.length; i += 6) assert(Math.abs(Math.hypot(v[i + 3], v[i + 4], v[i + 5]) - 1) < 1e-6);
  for (let row = 1; row <= 33; row++) {
    const i = row * 12,
      y = v[i + 1],
      z = v[i + 2];
    assert(Math.abs((y - 1) ** 2 + (z + 1.5) ** 2 - 1) < 1e-6);
  }
  assert.deepEqual([...v.subarray(3, 6)], [0, 1, 0]);
  assert.deepEqual([...v.subarray(v.length - 3)], [0, 0, 1]);
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => g.indices[i + k] * 6),
      u = [0, 1, 2].map((k) => v[b + k] - v[a + k]),
      w = [0, 1, 2].map((k) => v[c + k] - v[a + k]);
    const cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    assert(cross.reduce((s, x, k) => s + x * v[a + 3 + k], 0) > 0);
  }
  const finest = backdropGeometry({ segments: 256 });
  assert.equal(finest.indices.length, (256 + 2) * 6);
  assert.throws(
    () => backdropGeometry({ radius: Number.MIN_VALUE }),
    (error) => error instanceof RangeError && /float32/.test(error.message),
    'a positive underflowing bend must not produce zero-area strips',
  );
  for (const options of [
    null,
    [],
    { width: 0 },
    { radius: 0 },
    { radius: 4 },
    { radius: NaN },
    { height: Infinity },
    { segments: 1 },
    { segments: 257 },
    { depth: -1 },
  ])
    assert.throws(() => backdropGeometry(options));
});
test('a wrapped cove closes both sides and both back corners with unit normals, facing triangles and no hole', () => {
  const options = { width: 6, depth: 5, height: 4, radius: 1, segments: 16, sides: true },
    g = backdropGeometry(options),
    v = g.vertices,
    count = v.length / 6;
  assert(count > 100);
  let low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 6) {
    assert(Math.abs(Math.hypot(v[i + 3], v[i + 4], v[i + 5]) - 1) < 1e-6);
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k], v[i + k]);
      high[k] = Math.max(high[k], v[i + k]);
    }
  }
  // The wall surfaces reach the full width, the back wall and the full height; the front stays open at z = depth / 2.
  assert.deepEqual([low[0], high[0], low[2], high[2], high[1]], [-3, 3, -2.5, 2.5, 4]);
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => g.indices[i + k] * 6),
      u = [0, 1, 2].map((k) => v[b + k] - v[a + k]),
      w = [0, 1, 2].map((k) => v[c + k] - v[a + k]),
      cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      area = Math.hypot(...cross);
    if (area < 1e-12) continue;
    assert(cross.reduce((s, x, k) => s + x * v[a + 3 + k], 0) > 0, 'every triangle faces into the room');
  }
  // Every point of the cove lies on a surface at the radius from its centre line: a point left of -2 (the inset floor)
  // is on the side bend or wall, so the left, right and back walls all exist at full height.
  const wallAt = (test) => {
    for (let i = 0; i < v.length; i += 6) if (v[i + 1] === 4 && test(v[i], v[i + 2])) return true;
    return false;
  };
  assert(wallAt((x) => x === -3), 'left wall top');
  assert(wallAt((x) => x === 3), 'right wall top');
  assert(wallAt((x, z) => z === -2.5), 'back wall top');
  // The back corner is a vertical quarter cylinder of the bend radius about the inset corner (-2, -1.5).
  const corner = [];
  for (let i = 0; i < v.length; i += 6) if (v[i + 1] === 4 && v[i] < -2 + 1e-9 && v[i + 2] < -1.5 + 1e-9) corner.push([v[i], v[i + 2]]);
  assert(corner.length >= 16);
  for (const [x, z] of corner) assert(Math.abs(Math.hypot(x + 2, z + 1.5) - 1) < 1e-6);
  assert.throws(() => backdropGeometry({ width: 2, radius: 1, sides: true }), RangeError);
  assert.throws(() => backdropGeometry({ sides: 1 }), RangeError);
  assert.equal(backdropGeometry({ sides: false }).vertices.length, backdropGeometry().vertices.length);
});
test('each named rig owns fresh lights and has distinct key/fill/softness; cancelled lighting never attaches', async () => {
  const names = ['portrait', 'rembrandt', 'upfront', 'soft'],
    keys = new Set();
  for (const name of names) {
    const lights = stagingLights(name);
    assert.equal(lights.length, 3);
    keys.add(JSON.stringify(lights));
    lights[0].direction[0] = 100;
    assert.notEqual(stagingLights(name)[0].direction[0], 100);
  }
  assert.equal(keys.size, 4);
  assert(stagingLights('rembrandt')[0].intensity / stagingLights('rembrandt')[1].intensity > 8);
  assert.equal(stagingLights('upfront')[0].direction[0], 0);
  assert(stagingLights('soft')[0].width > stagingLights('portrait')[0].width);
  assert.throws(() => stagingLights('__proto__'), RangeError);
  await assert.rejects(stagingLighting({}, 'portrait', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('the tent rig rings the horizon: a vertical mirror at any heading reflects a lit panel, not the room', async () => {
  // Regression: under 'soft' a flat metal face turned away from its three boxes mirrored the walls (0.3) and read
  // near black on the CAD bench. The tent's panels light every heading to well above the walls.
  const { studio } = await import('@margoengine/environment/studio');
  const lights = stagingLights('tent'),
    width = 256,
    height = width / 2,
    image = studio({ width, lights, ...stagingRoom('tent') });
  assert.equal(lights.length, 7);
  assert.equal(stagingRoom('soft'), undefined);
  stagingRoom('tent').floor[0] = 9;
  assert.equal(stagingRoom('tent').floor[0], 0.35);
  const at = (azimuth, elevation) => {
    // Equirect: column by azimuth, row 0 at the top (elevation PI / 2).
    const x = Math.min(width - 1, Math.floor((((azimuth / (2 * Math.PI)) % 1) + 1) % 1 * width)),
      y = Math.min(height - 1, Math.floor((0.5 - elevation / Math.PI) * height));
    return image.data[(y * width + x) * 4];
  };
  let low = Infinity,
    high = 0;
  for (let deg = 0; deg < 360; deg += 5)
    for (const elevation of [-0.5, -0.2, 0.05, 0.2, 0.4]) {
      const v = at((deg * Math.PI) / 180, elevation);
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
  // Below the horizon a vertical face seen from above mirrors the tent's white floor (0.35), not a dark one.
  assert(low >= 0.35 - 1e-6, `darkest heading ${low}`);
  assert(high > 2 * low, `the panels keep a gradient (${low} to ${high})`);
  // Regression: the overhead box at 3 over a ceiling of 1 (radiance 4) and the panels over 0.8 walls clipped a
  // polished aluminium top to white on the CAD bench. No direction of the tent is brighter than its cloth (1).
  let peak = 0;
  for (let i = 0; i < image.data.length; i += 4) peak = Math.max(peak, image.data[i], image.data[i + 1], image.data[i + 2]);
  assert(peak <= 1 + 1e-6 && peak > 0.9, `brightest tent direction ${peak}`);
  // Straight up is the overhead diffuser, within the cloth's range, so an upward face is lit from above.
  assert(at(0, Math.PI / 2 - 0.01) > 0.85, `overhead ${at(0, Math.PI / 2 - 0.01)}`);
  const soft = studio({ width, lights: stagingLights('soft') });
  let softLow = Infinity;
  for (let x = 0; x < width; x += 4) softLow = Math.min(softLow, soft.data[(Math.floor(0.45 * height) * width + x) * 4]);
  assert(softLow < 0.5, `soft leaves headings on the bare walls (${softLow})`);
});
test('backdrop is an ordinary owned mesh and using cleanup is idempotent', () => {
  const mesh = {
    setGeometry(g) {
      this.geometry = g;
      return this;
    },
    setMaterial(m) {
      this.material = m;
      return this;
    },
    dispose() {
      this.disposed = (this.disposed ?? 0) + 1;
    },
  };
  const value = Backdrop.attach({ createMesh: () => mesh });
  assert.equal(value.mesh, mesh);
  assert.equal(mesh.geometry.indices.length, 204);
  value.dispose();
  value[Symbol.dispose]();
  assert.equal(mesh.disposed, 1);
});
