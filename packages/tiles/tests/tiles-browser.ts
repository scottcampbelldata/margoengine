// Real-GPU fixture for @margoengine/tiles: a generated city-scale tileset (6-level quadtree over 8 km, 1365 b3dm
// tiles, anchored in ECEF at 40 N 75.6 W) streamed by TilesRenderer through gltf-pro and drawn by the engine.
// tests/tiles-browser.mjs drives it and checks the numbers. Built imports, so it uses the published package boundary.
import { Engine } from '../../core/dist/extension.js';
import { GLTFAsset } from '../../gltf-pro/dist/index.js';
import { gaussianSplats, readGaussianSplats } from '../../gltf-pro/dist/splats.js';
import { glbChunks } from '../../shared/glb.js';
import { i3dm } from '../dist/i3dm.js';
import { splats, tileSplats } from '../dist/splats.js';
import { Splats, transformSplats } from '../../splats/dist/index.js';
import { TilesRenderer } from '../dist/index.js';
import { cityTileset, groveTileset, memoryFetch } from './generator.js';

const W = 480,
  H = 270,
  canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 120, 1800], target: [0, 0, 0], far: 20_000, near: 1 },
  }),
  errors: string[] = [];
engine.stop();
engine.onError = (error) => errors.push(String(error));
const device = engine.gpu!;
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
(engine as unknown as { scene: { background: string } }).scene.background = '#000000';

const city = cityTileset({ levels: 6, size: 8192, format: 'b3dm', height: 30 }),
  memory = memoryFetch(city.files);

async function frame(): Promise<void> {
  device.pushErrorScope('validation');
  try {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
}
function pixels(): Uint8ClampedArray {
  engine.render();
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  const context = copy.getContext('2d')!;
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, W, H).data;
}
const lit = (data: Uint8ClampedArray, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  return data[i] + data[i + 1] + data[i + 2] > 30;
};
function project(world: readonly number[]): [number, number, number] {
  const m = engine.camera.matrix,
    [x, y, z] = world;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
    cy = m[1] * x + m[5] * y + m[9] * z + m[13],
    cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [((cx / cw + 1) / 2) * W, ((1 - cy / cw) / 2) * H, cw];
}

let tiles: TilesRenderer;
async function converge(limit = 600): Promise<{ frames: number; ms: number }> {
  const started = performance.now();
  for (let i = 0; i < limit; i++) {
    await frame();
    await new Promise((r) => setTimeout(r, 0));
    const p = tiles.tileset.progress;
    if (i > 2 && tiles.last.pending === 0 && p.loading === 0 && p.queued === 0)
      return { frames: i, ms: performance.now() - started };
  }
  throw new Error(`tileset did not settle in ${limit} frames: ${JSON.stringify(tiles.tileset.progress)}`);
}
function snapshot() {
  const depths: Record<number, number> = {};
  for (const t of tiles.last.selected) depths[t.depth] = (depths[t.depth] ?? 0) + 1;
  return {
    selected: tiles.last.selected.length,
    depths,
    progress: tiles.tileset.progress,
    requests: memory.requests.length,
  };
}

async function run(name: string): Promise<unknown> {
  if (name === 'grove') {
    // 25 box trees from one i3dm tile (EAST_NORTH_UP, RTC_CENTER, ECEF), drawn as instances through gltf-pro.
    const grove = groveTileset({ n: 5, spacing: 40, height: 12 }),
      files = memoryFetch(grove.files);
    engine.camera.position = [0, 90, 230];
    engine.camera.target = [0, 0, -10];
    tiles = await TilesRenderer.load(engine, files.url, { fetch: files.fetch, i3dm });
    const timing = await converge();
    const data = pixels();
    const trees = grove.offsets.map((_, i) => {
      const content = tiles.tileset.root.contents[0] as unknown as { matrices: Float64Array };
      const foot = tiles.toWorld([0, 1, 2].map((k) => content.matrices[i * 16 + 12 + k] + grove.rtc[k]));
      return project([foot[0], foot[1] + 6, foot[2]]);
    });
    const onScreen = trees.filter(([x, y, w]) => w > 0 && x > 4 && x < W - 4 && y > 4 && y < H - 4);
    const drawn = onScreen.filter(([x, y]) => lit(data, x, y)).length;
    // Between trees (half a spacing east of the middle one, at half height) the background shows.
    const gap = project([20, 6, 0]);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
    const result = {
      ...timing,
      ...snapshot(),
      onScreen: onScreen.length,
      drawn,
      gapLit: lit(data, gap[0], gap[1]),
      lit: count,
      errors: [...errors],
    };
    tiles.dispose();
    return result;
  }
  if (name === 'cesium-trees') {
    // The real TilesetWithTreeBillboards sample (Cesium 3d-tiles-samples, CC0): 25 trees in each of two i3dm tiles,
    // fetched from the repository by a relative URL, as a page would. Close enough (under 146 m) that the root's
    // geometric error of 10 m refines to the full trees; the root's billboards need KHR_techniques_webgl (GLSL
    // shaders), which gltf-pro refuses with a coded error, as glTF says a loader must for a required extension.
    engine.camera.position = [0, 70, 110];
    engine.camera.target = [0, 0, 0];
    tiles = await TilesRenderer.load(engine, '../../../examples/assets/3d-tiles/TilesetWithTreeBillboards/tileset.json', { i3dm });
    tiles.tileset.on('error', ({ error }) => errors.push(`tile: ${(error as Error).message}`));
    const timing = await converge();
    const data = pixels();
    const shown = tiles.last.selected.flatMap((tile) => tile.contents) as unknown as { matrices?: Float64Array }[];
    const trees = shown.flatMap((content) =>
      Array.from({ length: (content.matrices?.length ?? 0) / 16 }, (_, i) => {
        const foot = tiles.toWorld([0, 1, 2].map((k) => content.matrices![i * 16 + 12 + k]));
        // 10 m up the 20 m tree is the textured crown; the trunk below is darker than the lit threshold.
        return project([foot[0], foot[1] + 10, foot[2]]);
      }),
    );
    const onScreen = trees.filter(([x, y, w]) => w > 0 && x > 4 && x < W - 4 && y > 4 && y < H - 4);
    const result = {
      ...timing,
      ...snapshot(),
      trees: trees.length,
      onScreen: onScreen.length,
      drawn: onScreen.filter(([x, y]) => lit(data, x, y)).length,
      urls: tiles.last.selected.map((tile) => tile.contentUrls[0]?.split('/').pop()),
      errors: [...errors],
    };
    tiles.dispose();
    return result;
  }
  if (name === 'gpu-memory') {
    // What the GPU really holds for a tile, counted at the device: every buffer and texture created while the tile
    // loads and draws, less those destroyed; then what disposing the tile frees. The tile is Khronos's real BoomBox
    // (10.6 MB GLB, four 2048 x 2048 PNG textures) as one glTF tile, so the file size and the GPU size differ widely.
    const from = errors.length,
      sizes = new Map<object, number>();
    let live = 0;
    const blocks: Record<string, number> = { bc7: 16, astc: 16, etc2: 16, bc1: 8, bc4: 8 };
    const texel = (format: string) => {
      const block = Object.keys(blocks).find((k) => format.startsWith(k));
      return block ? blocks[block] / 16 : format.startsWith('rgba16') ? 8 : format.startsWith('rgba32') ? 16 : 4;
    };
    const track = (object: GPUBuffer | GPUTexture, bytes: number) => {
      sizes.set(object, bytes);
      live += bytes;
      const destroy = object.destroy.bind(object);
      object.destroy = () => {
        if (sizes.has(object)) live -= sizes.get(object)!;
        sizes.delete(object);
        destroy();
      };
      return object;
    };
    const createBuffer = device.createBuffer.bind(device),
      createTexture = device.createTexture.bind(device);
    device.createBuffer = (d) => track(createBuffer(d), d.size) as GPUBuffer;
    device.createTexture = (d) => {
      const t = createTexture(d),
        [w, h, layers = 1] = Array.isArray(d.size) ? d.size : [(d.size as GPUExtent3DDict).width, (d.size as GPUExtent3DDict).height ?? 1, (d.size as GPUExtent3DDict).depthOrArrayLayers ?? 1];
      let bytes = 0;
      for (let l = 0; l < (d.mipLevelCount ?? 1); l++) bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * layers * texel(d.format);
      // Render targets (the frame's own) are not tile memory; keep them apart by their usage.
      return track(t, d.usage & GPUTextureUsage.TEXTURE_BINDING && !(d.usage & GPUTextureUsage.STORAGE_BINDING) ? bytes * (d.sampleCount ?? 1) : 0) as GPUTexture;
    };
    const glb = new Uint8Array(await (await fetch('../../../examples/assets/khronos/BoomBox/BoomBox.glb')).arrayBuffer());
    const json = {
      asset: { version: '1.1' },
      geometricError: 1,
      root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 0, content: { uri: 'boom.glb' } },
    };
    const files = memoryFetch(new Map([['tileset.json', new TextEncoder().encode(JSON.stringify(json))], ['boom.glb', glb]]));
    engine.camera.position = [0, 0, 0.08];
    engine.camera.target = [0, 0, 0];
    await frame();
    const before = live;
    tiles = await TilesRenderer.load(engine, files.url, { fetch: files.fetch });
    const timing = await converge();
    await frame();
    await frame();
    const loaded = live - before,
      counted = tiles.tileset.progress.bytes;
    tiles.dispose();
    await frame();
    const freed = loaded - (live - before);
    device.createBuffer = createBuffer;
    device.createTexture = createTexture;
    return { ...timing, file: glb.byteLength, counted, loaded, freed, errors: errors.slice(from) };
  }
  if (name === 'cesium-splats') {
    // CesiumJS's real sh_unit_cube splat tileset (Specs/Data, Apache-2.0): one glTF tile of 27 Gaussian splats with
    // SH degree 3 in an SPZ payload (KHR_gaussian_splatting_compression_spz_2), not geo-referenced ('local' frame).
    const base = '../../../examples/assets/3d-tiles/GaussianSplats/sh_unit_cube/',
      from = errors.length; // the cases before leave their own (expected) errors
    const bytes = new Uint8Array(await (await fetch(base + '0/0.glb')).arrayBuffer()),
      [json, binary] = glbChunks(bytes),
      doc = JSON.parse(new TextDecoder().decode(json.data)),
      raw = await readGaussianSplats(
        new GLTFAsset(doc, [], binary.data, { splats: gaussianSplats }, 2 ** 30),
        doc.meshes[0].primitives[0],
      );
    // Its one node turns and moves the primitive (z up to y up, then 50 m along x and z, -50 m along y).
    const data = transformSplats(raw, doc.nodes[0].matrix);
    const count = data.positions.length / 3;
    let low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++)
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], data.positions[i * 3 + k]);
        high[k] = Math.max(high[k], data.positions[i * 3 + k]);
      }
    tiles = await TilesRenderer.load(engine, base + 'tileset.json', { splats });
    tiles.tileset.on('error', ({ error }) => errors.push(`tile: ${(error as Error).message}`));
    // glTF content in a 'local' frame: the y-up to z-up turn and the frame's z-up to y-up cancel, so a centre's world
    // position is its glTF position. Look at the cube from 2.5 of its spans away.
    const middle = low.map((v, k) => (v + high[k]) / 2),
      span = Math.max(...high.map((v, k) => v - low[k]));
    engine.camera.position = [middle[0] + span * 1.2, middle[1] + span * 0.9, middle[2] + span * 2];
    engine.camera.target = middle;
    const timing = await converge();
    const data2 = pixels();
    const scene = await tileSplats((tiles as unknown as { host: Parameters<typeof tileSplats>[0] }).host);
    const centres = Array.from({ length: count }, (_, i) =>
      project([data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]]),
    ).filter(([x, y, w]) => w > 0 && x > 2 && x < W - 2 && y > 2 && y < H - 2);
    let lit2 = 0;
    for (let i = 0; i < data2.length; i += 4) if (data2[i] + data2[i + 1] + data2[i + 2] > 30) lit2++;
    const result = {
      ...timing,
      ...snapshot(),
      splats: scene?.count ?? 0,
      clouds: scene?.clouds.length ?? 0,
      centres: centres.length,
      drawn: centres.filter(([x, y]) => lit(data2, x, y)).length,
      lit: lit2,
      errors: errors.slice(from),
    };
    // Hiding the tile (selection frozen) empties the cloud at the next flush (the renderer flushes after each update).
    tiles.enabled = false;
    for (const tile of tiles.last.selected) if (tile.renderable) tile.renderable.visible = false;
    scene?.flush();
    const hidden = scene?.count ?? -1;
    tiles.dispose();
    const after = pixels();
    let litAfter = 0;
    for (let i = 0; i < after.length; i += 4) if (after[i] + after[i + 1] + after[i + 2] > 30) litAfter++;
    // The control: the same splats drawn straight by @margoengine/splats at their glTF positions. The tile path must
    // give the same picture (the same splats, in the same place, the same shapes and colours).
    const direct = Splats.attach(engine, data),
      reference = pixels();
    direct.dispose();
    let differ = 0,
      worst = 0;
    for (let i = 0; i < reference.length; i += 4) {
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs(reference[i + c] - data2[i + c])));
      worst = Math.max(worst, d);
      if (d > 2) differ++;
    }
    const directDrawn = centres.filter(([x, y]) => lit(reference, x, y)).length;
    return { ...result, hidden, litAfter, cloudsAfter: scene?.clouds.length ?? -1, directDrawn, differ, worst };
  }
  if (name === 'city') {
    tiles = await TilesRenderer.load(engine, memory.url, {
      fetch: memory.fetch,
      maxConcurrentRequests: 8,
      memoryBudget: 80_000,
      // This case checks eviction against file sizes (its 80 kB is a file budget); 'gpu-memory' checks the GPU count.
      budget: 'content',
    });
    const timing = await converge();
    const data = pixels();
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
    // Every on-screen leaf building: its centre (the tile volume's centre, through the float64 frame) must be drawn.
    const centres = tiles.last.selected
      .filter((t) => t.children.length === 0)
      .map((t) => project(tiles.toWorld(t.bounds.center)))
      .filter(([x, y, w]) => w > 0 && x > 8 && x < W - 8 && y > 8 && y < H - 8);
    const drawn = centres.filter(([x, y]) => lit(data, x, y)).length;
    // Sky above the horizon stays background.
    const sky = !lit(data, W / 2, 4);
    return {
      ...timing,
      ...snapshot(),
      lit: count,
      leavesOnScreen: centres.length,
      leavesDrawn: drawn,
      sky,
      errors: [...errors],
    };
  }
  // Fly 3 km east, low: new leaves load there, old ones are evicted under the 80 kB budget, models are disposed.
  const before = memory.requests.length;
  let unloads = 0;
  tiles.tileset.on('tileunload', () => unloads++);
  engine.camera.position = [3000, 60, 600];
  engine.camera.target = [3000, 0, -400];
  const timing = await converge();
  const data = pixels();
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) count++;
  return {
    ...timing,
    ...snapshot(),
    newRequests: memory.requests.length - before,
    unloads,
    lit: count,
    errors: [...errors],
  };
}

(window as unknown as { tilesFixture: unknown }).tilesFixture = {
  run,
  dispose: () => {
    tiles.dispose();
    return { plugins: engine.hasPlugin(tiles.name), errors: [...errors] };
  },
};
