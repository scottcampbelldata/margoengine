import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainVirtualTexture, bakeRects, splitTerrainColor } from '../dist/rvt.js';
import { TerrainMaterials } from '../dist/layers-pbr.js';
import { Terrain } from '../dist/index.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

// Every texel a move must bake, against the texels bakeRects gives: new window less old, on the torus of n.
test('a move bakes exactly the texels it exposes, once each, inside the target', () => {
  const n = 8,
    key = (x, z) => `${((x % n) + n) % n},${((z % n) + n) % n}`;
  let seed = 3;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 22 - 11;
  for (let trial = 0; trial < 400; trial++) {
    const from = [Math.round(random()), Math.round(random())],
      to =
        trial % 7 ? [from[0] + Math.round(random() / 2), from[1] + Math.round(random() / 2)] : [from[0] + 9, from[1]],
      want = new Set();
    for (let x = to[0]; x < to[0] + n; x++)
      for (let z = to[1]; z < to[1] + n; z++) {
        const inOld = x >= from[0] && x < from[0] + n && z >= from[1] && z < from[1] + n;
        if (!inOld || Math.abs(to[0] - from[0]) >= n || Math.abs(to[1] - from[1]) >= n) want.add(key(x, z));
      }
    const got = [];
    for (const [x, y, w, h] of bakeRects(from, to, n)) {
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= n && y + h <= n, `inside: ${[x, y, w, h]}`);
      for (let u = x; u < x + w; u++) for (let v = y; v < y + h; v++) got.push(`${u},${v}`);
    }
    assert.equal(got.length, want.size, `each once, ${from} to ${to}`);
    assert.deepEqual(new Set(got), want);
  }
  // No window yet: all of it. A dirty area: its part inside the window only.
  assert.equal(
    bakeRects(undefined, [5, -3], n).reduce((a, r) => a + r[2] * r[3], 0),
    n * n,
  );
  assert.deepEqual(bakeRects([0, 0], [0, 0], n, [[-4, 6, 2, 100]]), [[0, 6, 2, 2]]);
  assert.deepEqual(bakeRects([0, 0], [0, 0], n), []);
});

test('options and decals are checked', () => {
  const terrain = new Terrain(terrainOptions(() => ({})));
  for (const options of [
    { texel: 0 },
    { size: 1000 },
    { levels: 0 },
    { levels: 13 },
    { steep: 2 },
    { format: 'rgba8unorm' },
    { decals: 1 },
  ])
    assert.throws(() => new TerrainVirtualTexture(terrain, options), RangeError, JSON.stringify(options));
  assert.throws(() => new TerrainVirtualTexture({}, {}), TypeError);
  const r = rig({ decals: (device) => device.createTexture({ size: [4, 4, 2], format: 'rgba8unorm', usage: 4 }) });
  for (const decal of [
    { center: [0, 0], size: [0, 1] },
    { center: [0, NaN], size: [1, 1] },
    { center: [0, 0], size: [1, 1], layer: 2 },
    { center: [0, 0], size: [1, 1], opacity: 1.5 },
    { center: [0, 0], size: [1, 1], repeat: 0 },
  ])
    assert.throws(() => r.rvt.addDecal(decal), RangeError, JSON.stringify(decal));
  assert.throws(() => rig({}).rvt.addDecal({ center: [0, 0], size: [1, 1] }), /decals/);
  const ids = r.rvt.road(
    [
      [0, 0],
      [10, 0],
      [10, 0],
      [10, 5],
    ],
    2,
  );
  assert.equal(ids.length, 2, 'one decal a segment, none for a repeated point');
  assert.equal(r.rvt.removeDecal(ids[0]), true);
  assert.equal(r.rvt.removeDecal(ids[0]), false);
});

test('the lit shader reads the cache; the full colour stays for the capture and the bake', () => {
  const r = rig({ levels: 3, size: 256 });
  const log = r.frame(),
    codes = log.filter((e) => e[0] === 'module').map((e) => e[2].code),
    lit = codes.find((c) => c.includes('@fragment fn fragment(i:Output)') && !c.includes('fn terrainBakeTexel')),
    bakeCode = codes.find((c) => c.includes('fn terrainBakeTexel'));
  assert.ok(lit && bakeCode);
  assert.match(lit, /let base=terrainVirtualGround\(i\.position,/);
  assert.equal(lit.split('let dx=terrainDx;let dy=terrainDy;').length, 2);
  assert.match(lit, /@group\(1\) @binding\(94\) var terrainVirtualCache:texture_2d_array<f32>;/);
  assert.ok(!bakeCode.includes('terrainVirtualCache'), 'the bake does not read the cache it writes');
  // The first frame bakes every level whole, three passes at one draw each.
  assert.equal(r.rvt.baked, 3 * 256 * 256);
  assert.equal(log.filter((e) => e[0] === 'beginRenderPass').length, 4, 'three bakes and the terrain');
  // A still camera bakes nothing; a 1.5 texel move bakes the columns level 0 exposes (and none above it).
  r.frame();
  assert.equal(r.rvt.baked, 0);
  r.frame(([x, y, z]) => [x + 0.075, y, z]);
  assert.equal(r.rvt.baked, 256, JSON.stringify(r.rvt.baked));
  r.rvt.invalidate(-1, -1, 1, 1);
  r.frame(([x, y, z]) => [x + 0.075, y, z]);
  assert.ok(r.rvt.baked > 256 && r.rvt.baked < 256 * 3 + 3 * 41 * 41, `${r.rvt.baked}`);
  r.rvt.invalidate();
  r.frame(([x, y, z]) => [x + 0.075, y, z]);
  assert.equal(r.rvt.baked, 3 * 256 * 256);
  // Bindings 1 and 2 (heights, normals) are visible to fragments, for the bake.
  const layout = r.log.find((e) => e[0] === 'layout')[2];
  assert.ok(layout.entries.filter((e) => e.binding === 1 || e.binding === 2).every((e) => e.visibility & 2));
  assert.throws(() => splitTerrainColor('fn other(){}'), /colour function/);
  r.rvt.dispose();
  assert.equal(r.rvt.texture, undefined);
});

test('the virtual texture refuses layer materials', () => {
  const r = rig({});
  const materials = new TerrainMaterials(r.terrain, {
    textures: (device) => ({
      normals: device.createTexture({ size: [4, 4, 5], format: 'rgba8unorm', usage: 4 }),
      surface: device.createTexture({ size: [4, 4, 5], format: 'rgba8unorm', usage: 4 }),
    }),
  });
  assert.throws(() => materials.shader(r.rvt.shader(r.source(), 1), 1), /own lit shader/);
  assert.throws(() => r.rvt.shader(materials.shader(r.source(), 1), 1), /without layer materials/);
});

function terrainOptions(extra) {
  return {
    resolution: 8,
    levels: 2,
    size: [32, 32],
    origin: [-16, -16],
    layers: Array.from({ length: 5 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
    textures: (device) => {
      const texture = (format, layers = 1) =>
        device.createTexture({ size: [4, 4, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING });
      return { heightmap: texture('r32float'), layers: texture('rgba8unorm', 5), ...extra(texture) };
    },
  };
}
function rig(options) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      removePlugin() {},
      sceneOf: () => undefined,
    };
  const terrain = new Terrain(terrainOptions(() => ({}))),
    rvt = new TerrainVirtualTexture(terrain, options);
  const log = gpu.record(() => {
      terrain.setup(engine);
      rvt.setup(engine);
    }),
    passes = [];
  terrain.registerPasses({ add: (p) => passes.push(p) });
  rvt.registerPasses({ add: (p) => passes.push(p) });
  passes.sort((a, b) => a.order - b.order);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', shader: '' });
  let eye = [0.01, 1, 0.01];
  const frame = (move) =>
    gpu.record(() => {
      view.begin(0);
      if (move) eye = move(eye);
      // A copy: the mock context writes its orbit into the camera position array in place each frame.
      view.c.camera.position = [...eye];
      for (const p of passes) p.execute(view.c);
      view.end();
    });
  // The terrain's lit shader without effects, as the effects receive it.
  const source = () => {
    const lit = log.length && terrain.colorSource().code;
    return lit;
  };
  return { terrain, rvt, engine, log, frame, source };
}
