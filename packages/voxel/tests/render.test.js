// VoxelRenderer and BlockTextures against a recording WebGPU device: what lands in the GPU buffers (quad pages, page
// table, chunk origins, indirect arguments, material table, texture mips) and what the passes draw. Meshes come from
// the real worker mesher on worker_threads. The real-GPU pixel checks are tests/render-browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera, FrameGraph } from '@margoengine/core/extension';
import { BlockTypes, VoxelChunk, VoxelWorld, chunkKey } from '../dist/index.js';
import { blockMaterials, meshChunk, meshInput, sortQuads } from '../dist/mesher.js';
import { BlockTextures, VoxelRenderer } from '../dist/render.js';
import { NodeWebWorker } from './worker-support.js';

globalThis.Worker = NodeWebWorker;
Object.assign(globalThis, {
  GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 },
  GPUTextureUsage: { COPY_DST: 2, TEXTURE_BINDING: 4 },
});

// Records every call: buffers keep their bytes (writeBuffer and copies apply at once), encoders keep their commands.
const recorder = (commands) =>
  new Proxy(
    {},
    { get: (_, name) => (name === 'finish' ? () => ({ commands }) : (...args) => void commands.push([name, ...args])) },
  );
function fakeDevice() {
  const device = {
    limits: { maxStorageBufferBindingSize: 128 << 20 },
    buffers: [],
    textures: [],
    textureWrites: [],
    bundles: [],
    groups: [],
    createBuffer({ size, usage }) {
      const data = new ArrayBuffer(size),
        b = {
          size,
          usage,
          data,
          destroyed: false,
          getMappedRange: () => data,
          unmap() {},
          destroy: () => (b.destroyed = true),
        };
      device.buffers.push(b);
      return b;
    },
    createTexture(descriptor) {
      const t = {
        ...descriptor,
        destroyed: false,
        createView: (d) => ({ texture: t, ...d }),
        destroy: () => (t.destroyed = true),
      };
      device.textures.push(t);
      return t;
    },
    createSampler: (d) => ({ ...d }),
    createShaderModule: (d) => d,
    createRenderPipelineAsync: async (d) => ({ ...d, getBindGroupLayout: () => ({}) }),
    createBindGroup: (d) => (device.groups.push(d), d),
    createRenderBundleEncoder: (d) => {
      const commands = [];
      device.bundles.push({ descriptor: d, commands });
      return recorder(commands);
    },
    createCommandEncoder: () => ({
      copyBufferToBuffer: (from, at, to, offset, size) =>
        new Uint8Array(to.data, offset, size).set(new Uint8Array(from.data, at, size)),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(b, offset, data, start = 0, length = data.length - start) {
        assert.ok(!b.destroyed, 'write to a destroyed buffer');
        const n = data.BYTES_PER_ELEMENT;
        new Uint8Array(b.data, offset, length * n).set(
          new Uint8Array(data.buffer, data.byteOffset + start * n, length * n),
        );
      },
      writeTexture: (target, data, layout, size) =>
        device.textureWrites.push({ ...target, data: data.slice(), layout, size }),
      submit() {},
    },
  };
  return device;
}

// A minimal engine (plugin graph, lighting, stats) and a pass context that records its render passes.
function setup(options = {}, { textures = new BlockTextures(), blocks = defaultBlocks() } = {}) {
  const device = fakeDevice(),
    graph = new FrameGraph(),
    plugins = new Map(),
    errors = [],
    engine = {
      gpu: device,
      frameGraph: graph,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0, visible: 0 },
      onError: (error) => errors.push(error),
      use(plugin) {
        graph.withOwner(plugin.name, () => {
          plugin.setup(engine);
          plugin.registerPasses(graph);
        });
        plugins.set(plugin.name, plugin);
        return engine;
      },
      removePlugin(name) {
        const plugin = plugins.get(name);
        if (!plugin) return;
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose();
      },
    },
    world = new VoxelWorld({ blocks: blocks.types }),
    camera = new Camera({ position: [16, 16, -40], target: [16, 16, 0], near: 0.1, far: 200 }),
    passes = [],
    context = {
      backend: 'webgpu',
      device,
      encoder: {
        beginRenderPass: (descriptor) => {
          const commands = [];
          passes.push({ descriptor, commands });
          return recorder(commands);
        },
      },
      color: {},
      depth: {},
      format: 'bgra8unorm',
      descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth32float-stencil8' } },
      camera,
      width: 320,
      height: 240,
      delta: 0,
      draw() {},
    };
  const renderer = VoxelRenderer.attach(engine, { world, textures, workers: 2, ...options });
  const frame = () => {
    camera.update(context.width / context.height, true);
    passes.length = 0;
    graph.execute(context);
    assert.deepEqual(errors, []);
  };
  return { device, engine, world, renderer, camera, context, passes, frame, ...blocks };
}
function defaultBlocks() {
  const types = new BlockTypes();
  return {
    types,
    STONE: types.define('stone', { textures: 1 }),
    GLASS: types.define('glass', { layer: 'translucent', textures: 2 }),
    LEAVES: types.define('leaves', { layer: 'cutout', textures: 3 }),
  };
}

// Runs frames until `done()` (meshes arrive from the workers between them).
async function settle(frame, done, label = 'renderer') {
  const end = Date.now() + 20000;
  for (;;) {
    frame();
    if (done()) return;
    if (Date.now() > end) throw new Error(`${label} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
// The buffers the renderer binds now: from its newest beauty bind group (the 240-byte frame uniform at binding 0; not
// a lighting group 1 or a shadow group), and the newest live indirect buffer.
function bound(device) {
  const entries = device.groups.findLast((g) => g.entries[0]?.resource.buffer?.size === 240).entries,
    buffer = (i) => entries[i].resource.buffer;
  return {
    frame: new Float32Array(buffer(0).data),
    pool: buffer(1),
    pageTable: new Uint32Array(buffer(2).data),
    origins: new Float32Array(buffer(3).data),
    materials: buffer(4),
    args: new Uint32Array(device.buffers.findLast((b) => b.usage & 256 && !b.destroyed).data),
  };
}
// Per chunk key with opaque quads: its slot and the opaque and cutout arguments, as the GPU reads them.
function residents(device) {
  if (!device.groups.length) return new Map(); // pipelines still compiling
  const { origins, args, pageTable } = bound(device),
    out = new Map();
  for (let slot = 0; slot * 10 < args.length; slot++) {
    if (!args[slot * 10] && !args[slot * 10 + 5]) continue;
    const key = chunkKey(origins[slot * 4] / 32, origins[slot * 4 + 1] / 32, origins[slot * 4 + 2] / 32),
      start = args[slot * 10 + 3] / 256;
    out.set(key, { slot, start, quads: args[slot * 10] / 6, opaque: [...args.subarray(slot * 10, slot * 10 + 5)] });
    if (args[slot * 10]) assert.equal(pageTable[start], slot, `${key} page table`);
  }
  return out;
}
// A chunk of `n` stone cubes on even cells (no two touch, so each shows six unmerged faces: 6n quads).
function cubes(state, n) {
  const chunk = new VoxelChunk();
  for (let i = 0; i < n; i++) chunk.set((i % 16) * 2, ((i >> 4) % 16) * 2, (i >> 8) * 2, state);
  return chunk;
}
const replace = (world, cx, cy, cz, chunk) => {
  world.removeChunk(cx, cy, cz);
  world.addChunk(cx, cy, cz, chunk);
};

test('pages: first fit, freed holes reused, in-place remesh, data and page table as meshed', async () => {
  const { world, renderer, frame, device, STONE } = setup();
  try {
    const place = async (cx, n) => {
      replace(world, cx, 0, 0, cubes(STONE, n));
      await settle(frame, () => residents(device).get(chunkKey(cx, 0, 0))?.quads === n * 6, `chunk ${cx}`);
    };
    const start = (cx) => residents(device).get(chunkKey(cx, 0, 0)).start;
    // Chunks two apart: no shared shells, so adding one never remeshes another.
    await place(0, 10); // 60 quads: 1 page
    await place(2, 20); // 120 quads: 2 pages
    await place(4, 10);
    assert.deepEqual([start(0), start(2), start(4)], [0, 1, 3]);
    world.removeChunk(2, 0, 0);
    await settle(frame, () => !residents(device).has('2,0,0'));
    await place(6, 5); // the first hole that fits: page 1
    await place(8, 20); // 2 pages: the hole left at page 2 is too short
    assert.deepEqual([start(6), start(8)], [1, 4]);
    await place(0, 3); // still one page: stays in place
    assert.equal(start(0), 0);
    await place(4, 20); // grows to 2 pages: its old page 3 merges with the hole at 2
    assert.equal(start(4), 2);
    await place(8, 5); // shrinks in place, freeing page 5
    await place(10, 5);
    assert.deepEqual([start(8), start(10)], [4, 5]);
    // The pool holds exactly the meshes, and the stats count them.
    const { pool } = bound(device),
      resident = residents(device);
    let quads = 0;
    for (const [key, r] of resident) {
      const mesh = meshChunk(meshInput(world, key));
      assert.deepEqual([...new Uint32Array(pool.data, r.start * 768, mesh.opaque.length)], [...mesh.opaque], key);
      quads += r.quads;
    }
    const pages = [...resident.values()].reduce((sum, r) => sum + Math.ceil(r.quads / 64), 0);
    assert.deepEqual(
      { chunks: renderer.stats.chunks, quads: renderer.stats.quads, bytes: renderer.stats.bytes },
      { chunks: 5, quads, bytes: pages * 768 },
    );
  } finally {
    renderer.dispose();
  }
});

test('pool grows to maxQuadBytes keeping its pages, then a mesh that does not fit waits for freed pages', async () => {
  const pages = 8000,
    { world, renderer, frame, device, STONE } = setup({ maxQuadBytes: pages * 768 });
  try {
    const checkerboard = () => {
      const chunk = new VoxelChunk();
      for (let i = 0; i < 32768; i++)
        if (((i & 31) + ((i >> 5) & 31) + (i >> 10)) % 2 === 0) chunk.set(i & 31, i >> 10, (i >> 5) & 31, STONE);
      return chunk;
    };
    for (let i = 0; i < 5; i++) world.addChunk(i * 2, 0, 0, checkerboard()); // 98,304 quads (1,536 pages) each
    await settle(frame, () => renderer.stats.chunks === 5);
    const { pool } = bound(device),
      pools = device.buffers.filter((b) => b.size % 768 === 0 && b.usage & 128 && b.size >= 5461 * 768);
    assert.equal(pool.size, pages * 768, 'grown to the limit');
    assert.deepEqual(
      pools.map((b) => [b.size, b.destroyed]),
      [
        [5461 * 768, true],
        [pages * 768, false],
      ],
    );
    for (const [key, r] of residents(device)) {
      const mesh = meshChunk(meshInput(world, key));
      assert.deepEqual(
        new Uint32Array(pool.data, r.start * 768, mesh.opaque.length),
        mesh.opaque,
        `${key} after the copy`,
      );
    }
    world.addChunk(20, 0, 0, checkerboard()); // 7,680 of 8,000 pages are used
    for (let i = 0; i < 50; i++) {
      frame();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(renderer.stats.chunks, 5, 'the sixth mesh waits');
    world.removeChunk(2, 0, 0);
    await settle(frame, () => residents(device).has('20,0,0'));
    assert.equal(renderer.stats.chunks, 5);
  } finally {
    renderer.dispose();
  }
});

test('frustum cull per chunk sets instance counts; the bundle draws each chunk layer and re-records only on residency changes', async () => {
  const { world, renderer, frame, device, camera, passes, engine, STONE, LEAVES, GLASS } = setup();
  try {
    // The camera at (16, 16, -40) looks along +z (60 degrees, far 200).
    const keys = { front: [0, 0, 0], behind: [0, 0, -4], side: [10, 0, 0], far: [0, 0, 8], cutout: [0, 0, 2] };
    for (const [name, [cx, cy, cz]] of Object.entries(keys))
      world.addChunk(cx, cy, cz, cubes(name === 'cutout' ? LEAVES : STONE, 3));
    world.setBlock(5, 5, 5, GLASS);
    await settle(frame, () => renderer.stats.chunks === 5);
    const r = residents(device),
      visible = (name) => {
        const [cx, cy, cz] = keys[name],
          { slot } = r.get(chunkKey(cx, cy, cz)),
          { args } = bound(device);
        return [args[slot * 10 + 1], args[slot * 10 + 6]];
      };
    assert.deepEqual(visible('front'), [1, 0]);
    assert.deepEqual(visible('cutout'), [0, 1]);
    for (const name of ['behind', 'side', 'far']) assert.deepEqual(visible(name), [0, 0], name);
    const front = r.get('0,0,0');
    assert.deepEqual(front.opaque.slice(0, 1).concat(front.opaque.slice(2)), [
      front.quads * 6,
      0,
      front.start * 256,
      0,
    ]);
    // The newest bundle: opaque pipeline, its indirect draws, cutout pipeline, its draws (translucent is drawn directly).
    const bundle = device.bundles.at(-1),
      draws = bundle.commands.filter(([name]) => name === 'drawIndexedIndirect').map(([, , offset]) => offset);
    assert.deepEqual(bundle.descriptor, {
      colorFormats: ['bgra8unorm'],
      depthStencilFormat: 'depth32float-stencil8',
      sampleCount: 4,
      stencilReadOnly: true,
    });
    const expected = [...r].map(([key, { slot }]) => slot * 40 + (key === '0,0,2' ? 20 : 0));
    assert.deepEqual(
      draws.sort((a, b) => a - b),
      expected.sort((a, b) => a - b),
    );
    assert.equal(renderer.stats.visible, 2);
    assert.equal(renderer.stats.draws, 3, 'front opaque, cutout, front glass');
    frame();
    const [opaque, translucent] = passes;
    assert.deepEqual(
      opaque.commands.map(([name]) => name),
      ['executeBundles', 'end'],
    );
    assert.deepEqual(translucent.commands.filter(([name]) => name === 'drawIndexed').length, 1);
    assert.ok(engine.stats.drawCalls >= 3);
    // Turning the camera changes only the arguments.
    const bundles = device.bundles.length;
    camera.target = [16, 16, -80];
    frame();
    frame();
    assert.equal(device.bundles.length, bundles, 'no re-record on cull changes');
    assert.deepEqual(visible('behind'), [1, 0]);
    assert.deepEqual(visible('front'), [0, 0]);
    world.addChunk(0, 0, -6, cubes(STONE, 2));
    await settle(frame, () => renderer.stats.chunks === 6);
    assert.equal(device.bundles.length, bundles + 1, 'one re-record for the new chunk');
  } finally {
    renderer.dispose();
  }
});

test('translucent chunks draw back to front; near ones re-sort after the camera moves 4 blocks', async () => {
  const { world, renderer, frame, device, camera, passes, GLASS } = setup();
  try {
    for (const [cx, cz] of [
      [0, 0],
      [0, 3],
      [1, 1],
      [-1, 2],
    ])
      world.setBlocks([cx * 32 + 3, 3, cz * 32 + 3, GLASS, cx * 32 + 9, 3, cz * 32 + 3, GLASS]);
    await settle(frame, () => renderer.stats.chunks === 4);
    frame();
    const order = () => {
      const { pageTable, origins } = bound(device),
        pass = passes.find((p) => p.commands.some(([name]) => name === 'drawIndexed'));
      return pass.commands
        .filter(([name]) => name === 'drawIndexed')
        .map(([, , , , base]) => {
          const slot = pageTable[base / 256];
          return chunkKey(origins[slot * 4] / 32, origins[slot * 4 + 1] / 32, origins[slot * 4 + 2] / 32);
        });
    };
    const eye = camera.position,
      d = (key) => {
        const [cx, cy, cz] = key.split(',').map(Number);
        return Math.hypot(cx * 32 + 16 - eye[0], cy * 32 + 16 - eye[1], cz * 32 + 16 - eye[2]);
      };
    const drawn = order();
    assert.equal(drawn.length, 4);
    assert.deepEqual(
      drawn,
      [...drawn].sort((a, b) => d(b) - d(a)),
      'farthest first',
    );
    // Quads inside chunk 0,0,0 as the mesher sorted them for the old eye, then re-sorted on the CPU for the new one.
    const words = () => {
      const { pool, pageTable, origins } = bound(device),
        pass = passes.find((p) => p.commands.some(([name]) => name === 'drawIndexed')),
        call = pass.commands.find(([name, , , , base]) => {
          if (name !== 'drawIndexed') return false;
          const slot = pageTable[base / 256];
          return origins[slot * 4] === 0 && origins[slot * 4 + 2] === 0;
        });
      return [...new Uint32Array(pool.data, (call[4] / 256) * 768, call[1] / 2)];
    };
    const mesh = meshChunk(meshInput(world, '0,0,0')).translucent;
    assert.deepEqual(words(), [...sortQuads(mesh.slice(), [16, 16, -40])]);
    camera.position = [6, 3, -3]; // between the two glass blocks of chunk 0,0,0 (and 37 blocks from where it was sorted)
    camera.target = [6, 3, 40];
    frame();
    frame();
    // The renderer sorts its copy again (stable: equal distances keep the previous order).
    const resorted = [...sortQuads(sortQuads(mesh.slice(), [16, 16, -40]), [6, 3, -3])];
    assert.deepEqual(words(), resorted);
    assert.notDeepEqual(resorted, [...sortQuads(mesh.slice(), [16, 16, -40])], 'the order depends on the eye');
    camera.position = [8, 3, -3]; // 2 blocks: no re-sort
    frame();
    assert.deepEqual(words(), resorted);
  } finally {
    renderer.dispose();
  }
});

test('material table: 16 bytes per blockMaterials id (layer, frames, flags, sRGB tint, roughness, metalness, fps, emissive)', async () => {
  const types = new BlockTypes(),
    blocks = {
      types,
      GRASS: types.define('grass', {
        textures: [4, 4, 5, 6, 4, 4],
        color: [0.2, 0.5, 0.1],
        roughness: 0.25,
        metalness: 1,
      }),
      LAVA: types.define('lava', { textures: 10, emissive: 2.5, animation: { frames: 4, fps: 7.5 } }),
      LEAVES: types.define('leaves', { layer: 'cutout', textures: 7 }),
      FLOWER: types.define('flower', { layer: 'cutout', shape: 'cross', textures: 8 }),
    };
  for (const fancyLeaves of [true, false]) {
    const { renderer, frame, device } = setup({ fancyLeaves }, { blocks });
    try {
      await settle(frame, () => device.groups.length);
      const ids = blockMaterials(types.table),
        { materials } = bound(device),
        words = new Uint32Array(materials.data),
        floats = new Float32Array(materials.data),
        entry = (id, face) => {
          const m = ids[id * 6 + face];
          return [
            words[m * 4] & 255,
            (words[m * 4] >> 8) & 255,
            words[m * 4] >>> 16,
            words[m * 4 + 1],
            words[m * 4 + 2],
            floats[m * 4 + 3],
          ];
        },
        srgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)),
        tint = (r, g, b) => (srgb(r) | (srgb(g) << 8) | (srgb(b) << 16) | (255 << 24)) >>> 0;
      assert.equal(materials.size, (Math.max(...ids.filter((m) => m !== 0xffff)) + 1) * 16);
      assert.deepEqual(entry(blocks.GRASS, 0), [4, 0, 0, tint(0.2, 0.5, 0.1), 64 | (255 << 8), 0]);
      assert.deepEqual(entry(blocks.GRASS, 2)[0], 5, 'top');
      assert.deepEqual(entry(blocks.GRASS, 3)[0], 6, 'bottom');
      assert.deepEqual(entry(blocks.LAVA, 1), [10, 3, 0, 0xffffffff, 255 | ((7.5 * 256) << 16), 2.5]);
      assert.deepEqual(entry(blocks.LEAVES, 0).slice(0, 3), [7, 0, +!fancyLeaves], 'solid leaves without fancyLeaves');
      assert.deepEqual(entry(blocks.FLOWER, 0).slice(0, 3), [8, 0, 0], 'cross blocks always cut out');
      // Block types defined later grow the table.
      const late = types.define(`late ${fancyLeaves}`, { textures: 12 });
      frame();
      const after = blockMaterials(types.table);
      assert.equal(new Uint32Array(bound(device).materials.data)[after[late * 6] * 4] & 255, 12);
    } finally {
      renderer.dispose();
    }
  }
});

// Linear light of an sRGB byte and back, as the GPU's rgba8unorm-srgb conversion.
const linear = (b) => (b / 255 <= 0.04045 ? b / 255 / 12.92 : ((b / 255 + 0.055) / 1.055) ** 2.4),
  srgbByte = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));

test('BlockTextures: rgba8unorm-srgb array with every mip, linear box filter, alpha-weighted colour, alpha coverage kept', async () => {
  const size = 16,
    rgba = (f) => {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set(f(x, y), (y * size + x) * 4);
      return { width: size, height: size, data };
    };
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
  // Layer 0: opaque stripes of two colours. Layer 1: leaves, red texels on transparent black, about a third covered.
  // Layer 2: water, partly transparent everywhere.
  const stripes = rgba((x) => (x % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255])),
    leaves = rgba(() => (random() < 0.35 ? [255, 0, 0, 255] : [0, 0, 0, 0])),
    water = rgba(() => [40, 90, 200, 170]),
    textures = new BlockTextures({ images: [stripes, leaves, water] });
  assert.equal(textures.size, 16);
  assert.equal(textures.layers, 3);
  const { device, frame, renderer } = setup({}, { textures });
  try {
    frame();
    const texture = device.textures.at(-1);
    assert.deepEqual([texture.size, texture.format, texture.mipLevelCount], [[16, 16, 3], 'rgba8unorm-srgb', 5]);
    const level = (layer, mip) => device.textureWrites.findLast((w) => w.origin[2] === layer && w.mipLevel === mip);
    assert.equal(device.textureWrites.length, 15, 'three layers, five levels each');
    // Blended alpha (not only 0 and 255) is averaged, not rescaled for an alpha test.
    for (let mip = 1; mip < 5; mip++)
      assert.deepEqual([...level(2, mip).data.slice(0, 4)], [40, 90, 200, 170], `water mip ${mip}`);
    // Stripes: each level-1 texel averages a red and a blue texel in linear light.
    const mixed = srgbByte((linear(255) + linear(0)) / 2);
    for (let mip = 1; mip < 5; mip++)
      assert.deepEqual([...level(0, mip).data.slice(0, 4)], [mixed, 0, mixed, 255], `stripes mip ${mip}`);
    // Leaves: colour stays red wherever anything is covered (the black transparent texels do not darken it), and the
    // share of texels passing an alpha test at 0.5 is the share nearest level 0's that scaling the level's box-filtered
    // alpha can give (within one texel; brute force over every threshold). A plain box filter is far off.
    const coverage = (alpha) => alpha.filter((a) => a >= 128).length / alpha.length,
      alphas = (data) => data.filter((_, i) => i % 4 === 3),
      target = coverage(alphas(level(1, 0).data));
    let box = Float32Array.from(alphas(level(1, 0).data), (a) => a / 255),
      plainOff = 0;
    for (let mip = 1, n = 8; mip < 4; mip++, n >>= 1) {
      const data = level(1, mip).data,
        got = coverage(alphas(data)),
        next = new Float32Array(n * n);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const p = 4 * y * n + 2 * x;
          next[y * n + x] = (box[p] + box[p + 1] + box[p + 2 * n] + box[p + 2 * n + 1]) / 4;
        }
      box = next;
      const values = [...new Set(box)].filter((a) => a > 0),
        best = Math.min(
          ...[0, ...values.map((v) => box.filter((a) => a >= v).length / box.length)].map((c) => Math.abs(c - target)),
        );
      assert.ok(Math.abs(got - target) <= best + 1 / (n * n), `leaves mip ${mip}: coverage ${got}, level 0 ${target}`);
      for (let i = 0; i < data.length; i += 4)
        if (data[i + 3]) assert.deepEqual([...data.slice(i, i + 3)], [255, 0, 0]);
      plainOff = Math.max(
        plainOff,
        Math.abs(box.filter((a) => Math.round(255 * a) >= 128).length / box.length - target) * n * n,
      );
    }
    assert.ok(plainOff > 1, `a plain box filter would be ${plainOff} texels off`);
    // set() is live: one layer re-uploaded, nothing else.
    const writes = device.textureWrites.length;
    textures.set(0, leaves);
    frame();
    assert.equal(device.textureWrites.length, writes + 5);
    assert.equal(device.textures.length, 1, 'same texture');
    textures.set(4, stripes); // past the end: layers 3 (white) and 4, a new texture
    frame();
    assert.deepEqual(device.textures.at(-1).size, [16, 16, 5]);
    assert.ok(device.textures[0].destroyed);
    assert.deepEqual([...level(3, 0).data.slice(0, 8)], [255, 255, 255, 255, 255, 255, 255, 255]);
  } finally {
    renderer.dispose();
  }
  const atlas = {
      width: 32,
      height: 16,
      data: new Uint8Array(32 * 16 * 4).map((_, i) => ((i >> 2) % 32 < 16 ? 10 : 200)),
    },
    tiles = BlockTextures.fromAtlas(atlas, { size: 16 });
  assert.equal(tiles.layers, 2);
  assert.throws(() => new BlockTextures({ size: 12 }), RangeError);
  assert.throws(
    () => new BlockTextures({ images: [{ width: 8, height: 8, data: new Uint8Array(256) }], size: 16 }),
    RangeError,
  );
  assert.throws(() => textures.set(256, stripes), RangeError);
  assert.throws(() => textures.set(0, 5), TypeError);
  assert.throws(
    () => new BlockTextures({ images: [{ width: 16, height: 16 }] }),
    (e) => e.name === 'MargoError' && e.code === 'unsupported',
  );
  await assert.rejects(BlockTextures.load([]), TypeError);
  textures.dispose();
  assert.throws(
    () => textures.set(0, stripes),
    (e) => e.name === 'MargoError' && e.code === 'disposed',
  );
});

test('device restore: every chunk meshed again into the new device', async () => {
  const { world, renderer, frame, device, engine, context, STONE } = setup();
  try {
    world.addChunk(0, 0, 0, cubes(STONE, 30));
    world.addChunk(1, 0, 0, cubes(STONE, 7));
    await settle(frame, () => renderer.stats.chunks === 2);
    const before = residents(device),
      fresh = fakeDevice();
    engine.gpu = context.device = fresh;
    renderer.onDeviceRestored(engine);
    await settle(frame, () => renderer.stats.chunks === 2 && residents(fresh).size === 2);
    const { pool } = bound(fresh);
    for (const [key, r] of residents(fresh)) {
      assert.equal(r.quads, before.get(key).quads, key);
      const mesh = meshChunk(meshInput(world, key));
      assert.deepEqual(new Uint32Array(pool.data, r.start * 768, mesh.opaque.length), mesh.opaque);
    }
  } finally {
    renderer.dispose();
  }
});

test('VoxelRenderer: argument errors, WebGPU required, dispose', () => {
  const { engine, world, renderer, frame } = setup();
  renderer.dispose();
  frame(); // passes removed with the plugin
  const textures = new BlockTextures(),
    attach =
      (options, e = engine) =>
      () =>
        VoxelRenderer.attach(e, { world, textures, ...options });
  assert.throws(attach({ world: {} }), TypeError);
  assert.throws(attach({ textures: {} }), TypeError);
  assert.throws(attach({ maxQuadBytes: 100 }), RangeError);
  assert.throws(attach({ maxQuadBytes: 256 << 20 }), RangeError);
  assert.throws(attach({ daylight: -1 }), RangeError);
  assert.throws(attach({ fancyLeaves: 1 }), TypeError);
  assert.throws(attach({ workers: 0 }), RangeError);
  const headless = { ...engine, gpu: null, use: (plugin) => plugin.setup(headless) };
  assert.throws(attach({}, headless), (e) => e.name === 'MargoError' && e.code === 'unsupported');
  const r = attach({ daylight: 0.25 })();
  assert.equal(r.daylight, 0.25);
  assert.throws(() => (r.daylight = Number.NaN), RangeError);
  r.dispose();
  r.dispose();
});

test('addLighting: hooks composed into every pipeline, group 1 bound in the bundle and translucent pass; removed again', async () => {
  const { world, renderer, frame, device, passes, engine, STONE, GLASS } = setup();
  try {
    world.setBlocks([3, 3, 3, STONE, 9, 3, 3, GLASS]);
    await settle(frame, () => renderer.stats.chunks === 1 && device.bundles.length > 0);
    const light = device.createBuffer({ size: 16, usage: 64 }),
      effect = {
        pbr: (group) => ({
          declarations: `@group(${group}) @binding(9) var<uniform> testLight:vec4f;\n`,
          light: 'testLight.rgb',
          output: (color) => `(${color})*testLight.w`,
        }),
        bindings: () => [{ binding: 9, resource: { buffer: light } }],
      };
    const remove = renderer.addLighting(effect),
      lit = (bundle) => bundle.commands.some(([name, index]) => name === 'setBindGroup' && index === 1);
    await settle(frame, () => lit(device.bundles.at(-1)), 'lit bundle');
    const pipelines = device.bundles
      .at(-1)
      .commands.filter(([name]) => name === 'setPipeline')
      .map(([, p]) => p);
    for (const p of pipelines) {
      assert.match(p.fragment.module.code, /var color=testLight\.rgb\+direct\+/);
      assert.match(p.fragment.module.code, /color=\(select\(color,pbrNeutral/);
    }
    const group = device.bundles.at(-1).commands.find(([name, index]) => name === 'setBindGroup' && index === 1)[2];
    assert.deepEqual(group.entries, effect.bindings());
    frame();
    const translucent = passes.find((p) => p.commands.some(([name]) => name === 'drawIndexed'));
    assert.ok(translucent.commands.some(([name, index]) => name === 'setBindGroup' && index === 1));
    // A shadow map's uniform in the declarations: inside its range the map decides the sun, not sky visibility.
    const shadowed = {
      pbr: (group) => ({
        declarations: `struct S {view:mat4x4f,splits:vec4f}\n@group(${group}) @binding(1) var<uniform> shadowFrame:S;\n`,
        direct: (d) => `(${d})`,
      }),
      bindings: () => [{ binding: 1, resource: { buffer: light } }],
    };
    const unshadow = renderer.addLighting(shadowed);
    await settle(
      frame,
      () =>
        device.bundles
          .at(-1)
          .commands.find(([n]) => n === 'setPipeline')[1]
          .fragment.module.code.includes('shadowFrame.splits.w'),
      'shadowed sun',
    );
    unshadow();
    remove();
    await settle(frame, () => !lit(device.bundles.at(-1)), 'unlit bundle');
    assert.throws(() => renderer.addLighting({}), TypeError);
    assert.throws(
      () => renderer.addLighting({ ...effect, owner: {} }),
      (e) => e.name === 'MargoError' && e.code === 'attached',
    );
    assert.equal(engine.stats.drawCalls > 0, true);
  } finally {
    renderer.dispose();
  }
  assert.throws(
    () => renderer.addLighting({ pbr: () => undefined, bindings: () => [] }),
    (e) => e.name === 'MargoError' && e.code === 'disposed',
  );
});

test('drawShadow: opaque and cutout chunks inside the cascade only; shadowVersion moves for changes inside it', async () => {
  const { world, renderer, frame, device, STONE, LEAVES } = setup();
  try {
    world.addChunk(0, 0, 0, cubes(STONE, 4));
    world.addChunk(1, 0, 0, cubes(LEAVES, 4));
    world.addChunk(10, 0, 0, cubes(STONE, 4));
    await settle(frame, () => renderer.stats.chunks === 3);
    // An orthographic light matrix covering x 0-64, y 0-32 (depth along z): chunks 0 and 1, not 10.
    const matrix = new Float32Array(16);
    matrix[0] = 1 / 32;
    matrix[12] = -1;
    matrix[5] = 1 / 16;
    matrix[13] = -1;
    matrix[10] = 1 / 200;
    matrix[14] = 0.5;
    matrix[15] = 1;
    const draw = (cascade = 1) => {
      const commands = [];
      renderer.drawShadow({ context: { device }, pass: recorder(commands), matrix, cascade });
      return commands;
    };
    assert.deepEqual(draw(), [], 'pipelines still compiling');
    const compiling = renderer.shadowVersion;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(renderer.shadowVersion > compiling, 'ready pipelines redraw the map');
    const commands = draw(),
      calls = commands.filter(([name]) => name === 'drawIndexed'),
      pipelines = commands.filter(([name]) => name === 'setPipeline').map(([, p]) => p);
    assert.equal(calls.length, 2, 'chunk 0 opaque and chunk 1 cutout; chunk 10 culled');
    assert.deepEqual(
      calls.map(([, count]) => count),
      [24 * 6, 24 * 6],
    );
    assert.equal(pipelines[0].fragment, undefined, 'opaque casts depth only');
    assert.equal(pipelines[1].fragment.entryPoint, 'shadowCutout');
    assert.equal(pipelines[0].depthStencil.depthCompare, 'less-equal');
    const uniform = device.buffers.find((b) => b.size === 1024 && b.usage & 64);
    assert.deepEqual(new Float32Array(uniform.data, 256, 16), matrix, 'cascade 1 slot');
    // Changes outside the cascade leave the map; inside, it is drawn again.
    let version = renderer.shadowVersion;
    world.setBlock(10 * 32 + 1, 1, 1, STONE);
    await settle(frame, () => !world.dirty.size && renderer.stats.quads === 3 * 24 + 6);
    frame();
    assert.equal(renderer.shadowVersion, version, 'edit in a culled chunk');
    world.setBlock(1, 1, 1, STONE);
    await settle(frame, () => renderer.stats.quads === 3 * 24 + 12);
    assert.ok(renderer.shadowVersion > version, 'edit inside the cascade');
    version = renderer.shadowVersion;
    world.removeChunk(1, 0, 0);
    await settle(frame, () => renderer.stats.chunks === 2);
    assert.ok(renderer.shadowVersion > version, 'a cutout chunk left the cascade');
  } finally {
    renderer.dispose();
  }
});

test('blockLightColor: live in the frame uniform, validated', async () => {
  const { world, renderer, frame, device, STONE } = setup();
  try {
    world.setBlock(3, 3, 3, STONE);
    await settle(frame, () => renderer.stats.chunks === 1 && device.groups.length > 0);
    assert.deepEqual(
      [...bound(device).frame.subarray(48, 51)].map((v) => +v.toFixed(5)),
      [1, 0.82, 0.6],
    );
    renderer.blockLightColor = [0.2, 0.4, 0.8];
    frame();
    assert.deepEqual(
      [...bound(device).frame.subarray(48, 51)].map((v) => +v.toFixed(5)),
      [0.2, 0.4, 0.8],
    );
    assert.deepEqual(renderer.blockLightColor, [0.2, 0.4, 0.8]);
    assert.throws(() => (renderer.blockLightColor = [1, 2]), TypeError);
    assert.throws(() => (renderer.blockLightColor = [1, -1, 0]), RangeError);
    assert.throws(() => (renderer.blockLightColor = [1, Number.POSITIVE_INFINITY, 0]), RangeError);
  } finally {
    renderer.dispose();
  }
});
