import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { presets } from '../dist/presets.js';
import { BiomeView } from '../dist/view.js';
import { horizonEdgeMean, horizonHeights, HORIZON_SKIRT } from '../dist/view.js';

test('horizonHeights: the ring meets the world at its edge, skirts under it, and rises into mountains past it', () => {
  // A 1 km world on 8 m texels: a valley floor at 100 m along z = 500 that leaves the west and east edges, walls to 300.
  const width = 129,
    heights = new Float32Array(width * width);
  for (let j = 0; j < width; j++)
    for (let i = 0; i < width; i++) heights[j * width + i] = 100 + Math.min(200, Math.abs(j * 8 - 500) * 0.8);
  const far = horizonHeights({ bounds: [0, 0, 1024, 1024], heights, width, depth: width, seed: 3 }),
    at = (x, z) => {
      const i = Math.round((x - far.origin[0]) / far.texel), // float division
        j = Math.round((z - far.origin[1]) / far.texel); // float division
      return far.heights[j * far.width + i];
    };
  assert.equal(far.texel, 16, 'a power of two of texels near a 64th of the world');
  assert.equal(far.size[0], 1024 + 2 * 3 * 1024, 'three world sizes each side');
  for (let x = 0; x <= 1024; x += far.texel) {
    assert.equal(at(x, 0), heights[x / 8], `the north edge at x ${x} is the world's own height`);
    assert.equal(at(0, x), heights[(x / 8) * width], `the west edge at z ${x}`);
  }
  assert.equal(at(512, 512), heights[64 * width + 64] - HORIZON_SKIRT, 'inside, a skirt under the world');
  // The valley leaving the west edge carries on: 64 m out the floor is still near 100 m, the walls near their height.
  assert.ok(
    Math.abs(at(-64, 496) - at(0, 496)) < 10,
    `the valley floor carries on: ${at(-64, 496)} past ${at(0, 496)}`,
  );
  assert.ok(at(-64, 200) - at(-64, 496) > 150, 'and so do its walls');
  // Far out, mountains: a range of heights spanning a good share of the world's relief, none flat.
  const out = [];
  for (let z = -3000; z <= 4000; z += 160) out.push(at(-2500, z));
  const lo = Math.min(...out),
    hi = Math.max(...out);
  assert.ok(hi - lo > 50, `relief out to the horizon: ${lo} to ${hi}`);
  // Holes cover the world's own ground but not the first row of cells inside its edge.
  const cells = far.width - 1,
    first = (3 * 1024) / 16; // float division: ring cells
  assert.equal(far.inside[(first + 10) * cells + first + 10], 1);
  assert.equal(far.inside[(first + 10) * cells + first], 0, 'the skirt row is drawn');
  assert.equal(far.inside[(first + 10) * cells + first - 1], 0, 'outside is drawn');
});

test('regression KB-BIOMES-WORLDEDGE1: a land-locked view draws far ground to the horizon, a coast keeps its sea', async () => {
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, STORAGE_BINDING: 8 };
  const engine = {
    backend: 'webgpu',
    gpu: {
      limits: { maxTextureDimension2D: 8192 },
      createTexture: () => ({ destroy() {} }),
      queue: { writeTexture() {} },
    },
    camera: { position: [0, 0, 0] },
    use() {},
    removePlugin() {},
    sceneOf: () => undefined,
  };
  try {
    const land = await BiomeWorld.create({
        size: [1024, 1024],
        biomes: [presets.temperate],
        height: { field: (x, z) => 200 + 0.05 * x + 0.03 * z },
        climate: { latitude: 45 },
      }),
      view = await BiomeView.attach(engine, land, { objects: false, water: false, radius: 50, textureResolution: 16 });
    // Main ended the ground at the world's bounds: past them the sea's horizon showed.
    assert.ok(view.horizon, 'far ground around a world with no sea at its edges');
    // Its material textures repeat once per ring texel (16 m here, a 64th of the world), so their macro tone spans
    // hundreds of metres where the ring is seen; at the world's 4 m repeat it mipped to one flat tone a few kilometres
    // off (the alpine shot's horizon rock read 0.29x the form of plain rock, packages/biomes/tests/browser-check.mjs).
    assert.deepEqual(new Set(view.horizon.options.layers.map((l) => l.scale)), new Set([1 / 16]));
    assert.deepEqual(new Set(view.terrain.options.layers.map((l) => l.scale)), new Set([0.25]));
    view.dispose();
    const off = await BiomeView.attach(engine, land, {
      objects: false,
      water: false,
      radius: 50,
      textureResolution: 16,
      horizon: false,
    });
    assert.equal(off.horizon, undefined);
    off.dispose();
    const coast = await BiomeWorld.create({
        size: [1024, 1024],
        biomes: [presets.temperate],
        height: { field: (x) => x * 0.2 },
        climate: { latitude: 45 },
      }),
      sea = await BiomeView.attach(engine, coast, { objects: false, water: false, radius: 50, textureResolution: 16 });
    assert.equal(sea.horizon, undefined, "'auto' keeps a coast's sea horizon");
    sea.dispose();
    await assert.rejects(BiomeView.attach(engine, land, { horizon: 'yes' }), TypeError);
  } finally {
    globalThis.GPUTextureUsage = usage;
  }
});

test('regression KB-BIOMES-RIVERSTEP1: the riverbed paints the ground under the rivers, and the canopy stays the last material', async () => {
  // Main's first riverbed went after the canopy, which the cover writes at the last index: the forest drew as riverbed.
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = {
    TEXTURE_BINDING: 4,
    COPY_DST: 2,
    RENDER_ATTACHMENT: 16,
    STORAGE_BINDING: 8,
    COPY_SRC: 1,
  };
  const counts = new Map(),
    device = {
      limits: { maxTextureDimension2D: 8192, maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
      createTexture: (descriptor) => ({ descriptor, destroy() {}, createView: () => ({}) }),
      createBuffer: (d) => ({ size: d.size, destroy() {}, getMappedRange: () => new ArrayBuffer(d.size), unmap() {} }),
      createSampler: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      queue: {
        writeBuffer() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
        writeTexture(dest, data) {
          if (dest.texture.descriptor.format !== 'rgba8unorm' || data.length < 4096) return;
          const c = [0, 0, 0, 0];
          for (let i = 0; i < data.length; i++) if (data[i] > 128) c[i & 3]++;
          counts.set(dest.texture, c);
        },
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
      addEventListener() {},
      lost: new Promise(() => {}),
    },
    engine = {
      backend: 'webgpu',
      gpu: device,
      camera: { position: [0, 0, 0] },
      use() {},
      removePlugin() {},
      sceneOf: () => undefined,
      canvas: { width: 64, height: 64 },
    };
  try {
    const world = await BiomeWorld.create({
        height: { relief: { seed: 3, relief: 900, base: 300, rivers: 1, coast: 'south' } },
      }),
      view = await BiomeView.attach(engine, world, {
        objects: false,
        water: { rivers: 'auto' },
        canopy: 0.6,
        radius: 50,
        textureResolution: 16,
      }),
      m = view.materials;
    assert.ok(m.includes('canopy') && m.includes('riverbed'), m.join());
    assert.equal(m.at(-1), 'canopy', `the canopy is the last material: ${m}`);
    view.terrain.options.textures(device);
    const r = m.indexOf('riverbed'),
      painted = [...counts.values()][r >> 2][r & 3];
    // The river runs about 3 km: on 16 m texels some hundreds lie under its water, and nothing like the whole world.
    assert.ok(painted > 50 && painted < 5000, `riverbed texels: ${painted}`);
    view.dispose();
  } finally {
    globalThis.GPUTextureUsage = usage;
  }
});

test('regression KB-TERRAIN-SKYAMBIENT1: a view with a sky gives it its ground and far ground, and takes them back on dispose', async () => {
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, STORAGE_BINDING: 8 };
  const engine = {
    backend: 'webgpu',
    gpu: {
      limits: { maxTextureDimension2D: 8192 },
      createTexture: () => ({ destroy() {} }),
      queue: { writeTexture() {} },
    },
    camera: { position: [0, 0, 0] },
    use() {},
    removePlugin() {},
    sceneOf: () => undefined,
  };
  // A stand-in for a Sky: what the view reads (reflection, lights) and `add`, recording what it lights.
  const lit = new Set(),
    sky = {
      reflectionTexture: undefined,
      lights: [],
      add(terrain) {
        lit.add(terrain);
        return () => lit.delete(terrain);
      },
    };
  try {
    const land = await BiomeWorld.create({
        size: [1024, 1024],
        biomes: [presets.temperate],
        height: { field: (x, z) => 200 + 0.05 * x + 0.03 * z },
        climate: { latitude: 45 },
      }),
      view = await BiomeView.attach(engine, land, {
        sky,
        objects: false,
        water: false,
        radius: 50,
        textureResolution: 16,
      });
    assert.ok(view.horizon, 'far ground around a world with no sea at its edges');
    // Before the fix the view never added its ground: shaded ground took a white floor, not the sky's light.
    assert.deepEqual([...lit], [view.terrain, view.horizon]);
    view.dispose();
    assert.equal(lit.size, 0, 'removed on dispose');
  } finally {
    globalThis.GPUTextureUsage = usage;
  }
});

// KB-BIOMES-HORIZONSTREAK1: every far corner copied its nearest edge texel, so one edge texel's height and material ran
// straight out to the horizon: timber-valley's far ground showed bands of material and light from its edge outward.
test('regression KB-BIOMES-HORIZONSTREAK1: one odd edge texel does not run out to the horizon as a streak', () => {
  // A flat 1 km world at 100 m, 8 m texels, with one texel of its west edge (z = 512) at 300 m.
  const width = 129,
    heights = new Float32Array(width * width).fill(100),
    spike = 64 * width;
  heights[spike] = 300;
  const far = horizonHeights({ bounds: [0, 0, 1024, 1024], heights, width, depth: width, seed: 3 }),
    at = (x, z) =>
      far.heights[
        Math.round((z - far.origin[1]) / far.texel) * far.width + Math.round((x - far.origin[0]) / far.texel)
      ]; // float division
  assert.equal(at(0, 512), 300, 'the edge itself is the world');
  // Straight out from the spike and 160 m beside it, at the same distance. Copying the nearest texel, the spike ran
  // out as a ridge the mountains only slowly took over (about 170 m at 128 m out, 100 m at 256 m); now it is one texel
  // of a stretch of edge that widens with the distance (HORIZON_SPREAD), so it fades as it goes.
  const ridge = (x) => at(x, 512) - at(x, 352);
  assert.ok(ridge(-128) < 60, `128 m out the spike stands ${ridge(-128)} m over its side`);
  assert.ok(ridge(-256) < 40, `256 m out the spike stands ${ridge(-256)} m over its side`);
  assert.ok(Math.abs(ridge(-400)) < 40, 'no ridge 400 m out');
  // The material weights: the far corner straight out from one red edge texel takes it as a share, not whole.
  const paint = new Uint8Array(width * width * 4);
  for (let t = 0; t < width * width; t++) paint[t * 4 + 1] = 255;
  paint[spike * 4] = 255;
  paint[spike * 4 + 1] = 0;
  const mean = horizonEdgeMean({ width, depth: width }, far, paint, 4),
    c = Math.round((512 - far.origin[1]) / far.texel) * far.width + Math.round((-400 - far.origin[0]) / far.texel); // float division
  assert.ok(mean[c * 4] < 255 / 4, `the red share 400 m out: ${mean[c * 4]}`);
  assert.ok(Math.abs(mean[c * 4] + mean[c * 4 + 1] - 255) < 1e-3, 'the weights still sum to 255');
  // The mountains' share: 0 at the edge, all of it past the ramp (512 m for a 1 km world), where a material map gives
  // way to the whole edge's mean, so even the edge's large patches stop fanning out.
  assert.equal(
    far.blend[Math.round((512 - far.origin[1]) / far.texel) * far.width + Math.round(-far.origin[0] / far.texel)],
    0,
  ); // float division
  assert.equal(far.blend[c], Math.min(1, far.blend[c]));
  assert.ok(far.blend[c] > 0.85, `400 m out the mountains have ${far.blend[c]}`);
  assert.equal(far.blend[0], 1, 'the ring corner, kilometres out');
});

test('horizonEdgeMean averages round the edge loop, across its corners, and the whole edge once wider than it', () => {
  // A 3 x 3 grid: its 8 edge texels hold their loop order 0..7 (north row west to east, east column, south row east to
  // west, west column); the centre holds 50.
  const data = new Float32Array([0, 1, 2, 7, 50, 3, 6, 5, 4]),
    grid = { width: 3, depth: 3 },
    nearest = Uint32Array.from([0, 2, 4, 3, 0]),
    spread = Float32Array.from([1, 1, 3, 0, 9]),
    out = horizonEdgeMean(grid, { nearest, spread }, data, 1);
  assert.equal(out[0], Math.fround((7 + 0 + 1) / 3), 'the north-west corner takes both sides of the loop seam'); // float division
  assert.equal(out[1], Math.fround((1 + 2 + 3) / 3), 'round the north-east corner'); // float division
  assert.equal(out[2], 50, 'a texel off the edge keeps its own value');
  assert.equal(out[3], 7, 'no spread: the texel itself');
  assert.equal(out[4], 28 / 8, 'wider than the loop: the whole edge'); // float division
  assert.throws(() => horizonEdgeMean(grid, { nearest, spread }, data, 2), RangeError);
});
