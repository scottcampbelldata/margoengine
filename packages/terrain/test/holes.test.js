import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainHoles } from '../dist/holes.js';
import { TerrainQuery } from '../dist/query.js';
import { Terrain } from '../dist/index.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const options = { origin: [-8, -8], size: [16, 16], heightScale: 1 };

test('hole shapes cut the cells whose centres they hold', () => {
  const holes = new TerrainHoles(options, 16);
  assert.equal(holes.mask.length, 256);
  assert.ok(holes.mask.every((v) => v === 255));
  holes.rect(-2, -2, 2, 2);
  // Cells 1 m wide: centres -1.5 .. 1.5 lie in the rectangle, a 4 x 4 block.
  assert.equal(holes.mask.filter((v) => v === 0).length, 16);
  assert.ok(holes.hole(0, 0) && holes.hole(-1.9, 1.9) && !holes.hole(2.1, 0) && !holes.hole(100, 0));
  holes.rect(-2, -2, 2, 2, false).circle(0, 0, 3);
  // Centres within 3 m of the origin: (k + 0.5)^2 + (l + 0.5)^2 <= 9.
  let want = 0;
  for (let k = -8; k < 8; k++) for (let l = -8; l < 8; l++) if ((k + 0.5) ** 2 + (l + 0.5) ** 2 <= 9) want++;
  assert.equal(holes.mask.filter((v) => v === 0).length, want);
  // A concave L polygon by the even-odd rule: the notch stays ground.
  const l = new TerrainHoles(options, 16).polygon([
    [-4, -4],
    [4, -4],
    [4, 0],
    [0, 0],
    [0, 4],
    [-4, 4],
  ]);
  assert.ok(l.hole(-2, -2) && l.hole(2, -2) && l.hole(-2, 2) && !l.hole(2, 2));
  assert.equal(l.mask.filter((v) => v === 0).length, 48);
});

test('hole options are checked', () => {
  for (const [o, c] of [
    [{ origin: [0, 0], size: [0, 1] }, 4],
    [options, 0],
    [options, 8193],
    [options, 2.5],
  ])
    assert.throws(() => new TerrainHoles(o, c), RangeError);
  const holes = new TerrainHoles(options, 4);
  assert.throws(() => holes.circle(0, 0, -1), RangeError);
  assert.throws(() => holes.polygon([[0, 0]]), RangeError);
  assert.throws(() => holes.upload({}), TypeError);
  assert.throws(
    () =>
      new TerrainQuery(new Float32Array(4), 2, 2, {
        ...options,
        holes: { mask: new Uint8Array(3), columns: 2, rows: 2 },
      }),
    RangeError,
  );
});

test('queries skip hole cells: no height, no normal, rays pass through', () => {
  const n = 17,
    heights = new Float32Array(n * n).fill(2),
    holes = new TerrainHoles(options, n - 1),
    query = new TerrainQuery(heights, n, n, { ...options, holes });
  assert.equal(query.height(0.5, 0.5), 2);
  assert.ok(query.raycast([0.5, 10, 0.5], [0, -1, 0]));
  holes.circle(0, 0, 2);
  // Read live: the cut applies at once.
  assert.equal(query.height(0.5, 0.5), undefined);
  assert.equal(query.normal(0.5, 0.5), undefined);
  assert.equal(query.raycast([0.5, 10, 0.5], [0, -1, 0]), null);
  // A slanted ray through the hole meets the ground beyond it.
  const hit = query.raycast([0.5, 10, 0.5], [0.5, -1, 0]);
  assert.ok(hit && hit.position[0] > 2 && Math.abs(hit.position[1] - 2) < 1e-9, JSON.stringify(hit));
  assert.ok(!holes.hole(hit.position[0], hit.position[2]));
  assert.equal(query.height(5, 5), 2);
});

function rig(extra) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      sceneOf: () => undefined,
    };
  const terrain = new Terrain({
    resolution: 8,
    levels: 2,
    size: [32, 32],
    layers: Array.from({ length: 5 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1, tint: true })),
    textures: (device) => {
      const texture = (format, layers = 1) =>
        device.createTexture({ size: [4, 4, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING });
      return { heightmap: texture('r32float'), layers: texture('rgba8unorm', 5), ...extra(texture) };
    },
  });
  const log = gpu.record(() => terrain.setup(engine)),
    passes = [];
  terrain.registerPasses({ add: (p) => passes.push(p) });
  passes.sort((a, b) => a.order - b.order);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', shader: '' });
  const frame = () =>
    gpu.record(() => {
      view.begin(0);
      for (const p of passes) p.execute(view.c);
      view.end();
    });
  const occluder = () =>
    gpu.record(() =>
      terrain.drawOccluder({
        pass: { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {} },
        samples: 1,
      }),
    );
  return { terrain, engine, log, frame, occluder };
}
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test('a holes texture binds after the weights and tint, and every pass drops hole fragments', () => {
  const r = rig((texture) => ({
      weights: [texture('rgba8unorm'), texture('rgba8unorm')],
      tint: texture('rgba8unorm-srgb'),
      holes: texture('r8unorm'),
    })),
    layout = r.log.find((e) => e[0] === 'layout')[2];
  assert.deepEqual(
    layout.entries.map((e) => e.binding),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  const shadow = modules(r.log).find((c) => c.includes('fn outside')),
    colour = modules(r.frame()).find((c) => c.includes('@fragment fn fragment')),
    occluder = modules(r.occluder()).find((c) => c.includes('fn outside'));
  for (const [name, code] of [
    ['shadow', shadow],
    ['colour', colour],
    ['occluder', occluder],
  ]) {
    assert.ok(code, name);
    assert.equal(
      code.split('@binding(9) var terrainHoles:texture_2d<f32>;').length,
      2,
      `${name} declares the mask once`,
    );
    assert.match(code, /\.r<0\.5\)\{discard;\}/, `${name} tests it`);
  }
  assert.throws(() => rig((texture) => ({ holes: texture('r32float') })), TypeError);
});

test('the terrain destroys its holes texture on device restoration and on dispose', () => {
  // Regression: release() destroyed every texture the factory returned but the holes mask, so each device restoration
  // and each disposal leaked it.
  const made = [],
    r = rig((texture) => {
      const holes = texture('r8unorm');
      made.push(holes);
      return { holes };
    });
  r.terrain.onDeviceRestored(r.engine);
  assert.equal(made.length, 2);
  assert.ok(made[0].destroyed, 'the old mask is destroyed on restoration');
  assert.ok(!made[1].destroyed);
  r.terrain.dispose();
  assert.ok(made[1].destroyed, 'the mask is destroyed on dispose');
});

test('without holes no pass mentions them', () => {
  const r = rig(() => ({}));
  for (const code of [...modules(r.log), ...modules(r.frame()), ...modules(r.occluder())])
    assert.ok(!code.includes('terrainHoles'));
});
