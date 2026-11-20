import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { inflateSync } from 'node:zlib';
import { readZipDirectory, readZipEntry, crc32 } from '@margoengine/loaders';
import {
  mediaDimensions,
  renderMediaTiles,
  exportImage,
  exportImageSequence,
  exportVideo,
} from '@margoengine/sciviz/export-media';

test('physical dimensions round once, with correct inches, millimetres, pixels and scale', () => {
  assert.deepEqual(mediaDimensions(640, 480, { scale: 3 }), { width: 1920, height: 1440, dpi: 300 });
  for (const size of [
    { width: 25.4, height: 50.8, unit: 'mm' },
    { width: 1, height: 2, unit: 'in' },
  ])
    assert.deepEqual(mediaDimensions(1, 1, { size, dpi: 300 }), { width: 300, height: 600, dpi: 300 });
  assert.equal(mediaDimensions(2, 3, { size: { width: 21, height: 12, unit: 'px' }, dpi: 600 }).width, 21);
  for (const options of [
    { scale: 0 },
    { dpi: Infinity },
    { size: { width: -1, height: 2, unit: 'mm' } },
    { size: { width: 1, height: 2, unit: 'cm' } },
    { scale: 2, size: { width: 1, height: 1, unit: 'px' } },
  ])
    assert.throws(() => mediaDimensions(640, 480, options), RangeError);
});

function captureFixture(maxTextureDimension2D = 4) {
  const created = [],
    removed = [],
    projections = [],
    textures = [],
    views = [],
    copies = [];
  const canvas = {
    width: 8,
    height: 4,
    clientWidth: 8,
    clientHeight: 4,
    getBoundingClientRect: () => ({ width: 8, height: 4, left: 0, top: 0 }),
  };
  const own = (extra = {}) => {
    const value = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      ...extra,
    };
    created.push(value);
    return value;
  };
  const gpu = {
    limits: { maxTextureDimension2D, maxBufferSize: 1e6 },
    createTexture: ({ size }) => (textures.push(size), own()),
    createBuffer: ({ size }) =>
      own({ mapAsync: async () => {}, getMappedRange: () => new ArrayBuffer(size), unmap() {} }),
    createCommandEncoder: () => ({
      copyTextureToBuffer: (source, _, size) => copies.push([...(source.origin ?? [0, 0]), ...size]),
      finish() {},
    }),
    queue: { submit() {} },
  };
  // As core: plugins join the active scene, removePlugin(name) acts on the active scene, sceneOf finds the owner.
  const scenes = [new Map(), new Map()];
  let active = scenes[0];
  const owner = (scene) => ({
    plugins: scene,
    removePlugin(name) {
      removed.push(name);
      scene.delete(name);
    },
  });
  const engine = {
    gpu,
    canvas,
    camera: new Camera(),
    disposed: false,
    scenes,
    activate(index) {
      active = scenes[index];
    },
    use(plugin) {
      this.plugin = plugin;
      active.set(plugin.name, plugin);
    },
    sceneOf(plugin) {
      const scene = scenes.find((s) => s.get(plugin.name) === plugin);
      return scene && owner(scene);
    },
    removePlugin(name) {
      owner(active).removePlugin(name);
    },
    render({ views: [view] }) {
      views.push({ viewport: view.viewport, scissor: view.scissor, exportScale: figure.renderer.exportScale });
      view.camera.update(1, true);
      projections.push(view.camera.matrix.slice());
    },
  };
  const figure = {
    engine,
    renderer: { exportScale: undefined },
    theme: { background: '#ffffff' },
    ready: async () => {},
    render() {},
    exportLayout: () => ({ roots: [], bars: [] }),
    vectorAxes: () => [],
    layers: [],
  };
  return { figure, created, removed, projections, textures, views, copies };
}

// Every pixel is drawn in its 1024 px render block, with the block's viewport and projection, and a tile is the part
// of that drawing its scissor keeps. Apple Metal coloured 164 of 307,200 values 1 apart between 64 px tiles and one
// whole-image tile when each tile had a viewport and cropped projection of its own (the Radeon 680M 1,982, as it also
// draws lines differently into targets of 128 px or less): the GPU placed and interpolated the same lines differently.
test('tiles are scissored parts of one block drawing: same viewport, projection and target for every tile size', async () => {
  const { figure, textures, views, copies, projections } = captureFixture(8192);
  figure.engine.canvas.clientWidth = figure.engine.canvas.width = 320;
  figure.engine.canvas.clientHeight = figure.engine.canvas.height = 240;
  const tiles = await Array.fromAsync(renderMediaTiles(figure, { overlays: false, tileSize: 300 }));
  assert.deepEqual(
    tiles.map((t) => [t.x, t.y, t.width, t.height]),
    [
      [0, 0, 300, 240],
      [300, 0, 20, 240],
    ],
  );
  assert.deepEqual(textures, [[1024, 1024]], 'one block target for the whole capture');
  assert.deepEqual(copies, [
    [0, 0, 300, 240],
    [300, 0, 20, 240],
  ]);
  assert.deepEqual(views, [
    { viewport: [0, 0, 1, 1], scissor: [0, 0, 300 / 1024, 240 / 1024], exportScale: 1 },
    { viewport: [0, 0, 1, 1], scissor: [300 / 1024, 0, 20 / 1024, 240 / 1024], exportScale: 1 },
  ]);
  assert.equal(figure.renderer.exportScale, undefined, 'the export scale ends with the capture');
  // CSS pixel sizes (graph nodes) draw at the image's pixels per CSS pixel, not window.devicePixelRatio.
  const double = captureFixture(8192);
  double.figure.engine.canvas.clientWidth = double.figure.engine.canvas.width = 320;
  double.figure.engine.canvas.clientHeight = double.figure.engine.canvas.height = 240;
  await Array.fromAsync(renderMediaTiles(double.figure, { overlays: false, scale: 2, tileSize: 64 }));
  assert.ok(double.views.length && double.views.every((v) => v.exportScale === 2));
  assert.deepEqual(projections[1], projections[0], 'both tiles draw with the block projection');
  // The block projection maps the 1024 px block, from the image's top-left pixel, onto clip space.
  const whole = new Camera();
  whole.update(320 / 240, true);
  const m = whole.matrix,
    close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
  close(projections[0][0], (320 / 1024) * m[0] + ((320 - 1024) / 1024) * m[3]);
  close(projections[0][5], (240 / 1024) * m[5] + ((1024 - 240) / 1024) * m[7]);
  // A tile size that does not divide the block ends its last tile at the block edge; tiles never cross blocks.
  const wide = captureFixture(8192);
  wide.figure.engine.canvas.clientWidth = wide.figure.engine.canvas.width = 2100;
  const spans = await Array.fromAsync(renderMediaTiles(wide.figure, { overlays: false, tileSize: 1000 }));
  assert.deepEqual(
    spans.map((t) => [t.x, t.width]),
    [
      [0, 1000],
      [1000, 24],
      [1024, 1000],
      [2024, 24],
      [2048, 52],
    ],
  );
  assert.deepEqual(
    wide.copies.map((c) => c[0]),
    [0, 1000, 0, 1000, 0],
  );
  assert.deepEqual(wide.projections[1], wide.projections[0]);
  assert.deepEqual(wide.projections[3], wide.projections[2]);
  assert.notDeepEqual(wide.projections[2], wide.projections[0]);
  assert.equal((await exportImage(wide.figure, { overlays: false, tileSize: 1000 })).type, 'image/png');
  // The block is the largest power of two within a device limit below 1024, and caps the tile size.
  const odd = captureFixture(300);
  odd.figure.engine.canvas.clientWidth = odd.figure.engine.canvas.width = 320;
  const edges = await Array.fromAsync(renderMediaTiles(odd.figure, { overlays: false }));
  assert.deepEqual(
    edges.map((t) => t.width),
    [256, 64],
  );
  assert.deepEqual(odd.textures, [[256, 256]]);
  assert.ok([wide, odd].every((f) => f.created.every((c) => c.destroyed)));
});

test('tile capture uses actual cropped perspective projection and releases each resource and pass', async () => {
  const { figure, created, removed, projections } = captureFixture();
  const tiles = await Array.fromAsync(renderMediaTiles(figure, { overlays: false, tileSize: 4 }));
  assert.deepEqual(
    tiles.map((t) => [t.x, t.y, t.width, t.height]),
    [
      [0, 0, 4, 4],
      [4, 0, 4, 4],
    ],
  );
  assert.ok(created.every((c) => c.destroyed));
  assert.deepEqual(removed, ['sciviz:media-clear']);
  assert.equal(projections.length, 2);
  assert.ok(Math.abs(projections[0][12] / projections[0][15] - 1) < 1e-6);
  assert.ok(Math.abs(projections[1][12] / projections[1][15] + 1) < 1e-6);
  assert.equal(figure.engine.camera.project, undefined);
});

test('early iterator close, overlapping captures and readback errors release ownership without altering the camera', async () => {
  const { figure, created, removed } = captureFixture(),
    iterator = renderMediaTiles(figure, { overlays: false });
  await iterator.next();
  await assert.rejects(renderMediaTiles(figure, { overlays: false }).next(), { code: 'state' });
  await iterator.return();
  assert.ok(created.every((c) => c.destroyed));
  assert.equal(removed.length, 1);
  const original = figure.engine.gpu.createBuffer,
    reason = new Error('map failed');
  figure.engine.gpu.createBuffer = (options) => {
    const b = original(options);
    b.mapAsync = async () => {
      throw reason;
    };
    return b;
  };
  await assert.rejects(renderMediaTiles(figure, { overlays: false }).next(), (e) => e === reason);
  assert.ok(created.every((c) => c.destroyed));
  assert.equal(removed.length, 2);
});

test("a capture that ends while another scene is active removes its own tile clear, not that scene's plugin", async () => {
  const { figure, removed } = captureFixture(),
    engine = figure.engine,
    decoy = { name: 'sciviz:media-clear', setup() {} };
  engine.scenes[1].set(decoy.name, decoy);
  const iterator = renderMediaTiles(figure, { overlays: false, tileSize: 4 });
  await iterator.next();
  const clear = engine.plugin;
  assert.equal(engine.scenes[0].get(clear.name), clear);
  // A second view's scene is active when the last tile is taken and the capture finishes.
  engine.activate(1);
  while (!(await iterator.next()).done);
  assert.equal(engine.scenes[1].get(decoy.name), decoy, 'the other scene keeps its plugin');
  assert.equal(engine.scenes[0].has(clear.name), false, 'the tile clear left the scene it joined');
  assert.deepEqual(removed, ['sciviz:media-clear']);
});

test('abort and invalid output requests reject before producing partial files', async () => {
  const { figure } = captureFixture(),
    abort = new AbortController();
  abort.abort(new Error('stop'));
  await assert.rejects(exportImage(figure, { signal: abort.signal }), /stop/);
  await assert.rejects(exportImage(figure, { format: 'gif' }), TypeError);
  await assert.rejects(
    exportImage(figure, { format: 'webp', size: { width: 16384, height: 2, unit: 'px' } }),
    RangeError,
  );
  const timeline = { times: [0, 1], index: 0, playing: false, pause() {}, async seek() {} };
  await assert.rejects(exportImageSequence(figure, timeline, { end: 2 }), RangeError);
  await assert.rejects(exportVideo(figure, timeline, { start: -1 }), RangeError);
});

test('streamed PNG has exact row coverage, CRCs, physical density, Unicode provenance and no destination canvas', async () => {
  const { figure, created } = captureFixture(),
    record = { source: 'NOAA', title: 'Wind σ' };
  const blob = await exportImage(figure, { overlays: false, provenance: record, dpi: 600 });
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    view = new DataView(bytes.buffer),
    chunks = new Map();
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  for (let p = 8; p < bytes.length; ) {
    const size = view.getUint32(p),
      name = new TextDecoder().decode(bytes.subarray(p + 4, p + 8));
    assert.equal(view.getUint32(p + 8 + size), crc32(bytes.subarray(p + 4, p + 8 + size)));
    chunks.set(name, bytes.subarray(p + 8, p + 8 + size));
    p += size + 12;
  }
  assert.equal(inflateSync(chunks.get('IDAT')).length, (8 * 4 + 1) * 4);
  assert.ok(inflateSync(chunks.get('IDAT')).every((b) => b === 0));
  assert.equal(
    new DataView(chunks.get('pHYs').buffer, chunks.get('pHYs').byteOffset).getUint32(0),
    Math.round(600 / 0.0254),
  );
  assert.ok(new TextDecoder().decode(chunks.get('iTXt')).endsWith(JSON.stringify(record)));
  assert.ok(created.every((c) => c.destroyed));
});

test('image ZIP opens with the independent loader, retains manifest times and restores the timeline', async () => {
  const { figure } = captureFixture(),
    seen = [],
    timeline = {
      times: [101, 202, 303],
      index: 1,
      playing: false,
      pause() {},
      async seek(index) {
        this.index = index;
        seen.push(index);
      },
    };
  const blob = await exportImageSequence(figure, timeline, { overlays: false, fps: 2, provenance: { source: 'NOAA' } }),
    bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = readZipDirectory(bytes);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['frame-000000.png', 'frame-000001.png', 'frame-000002.png', 'manifest.json'],
  );
  const manifest = JSON.parse(new TextDecoder().decode(await readZipEntry(bytes, entries[3])));
  assert.deepEqual(
    manifest.frames.map((f) => [f.time, f.timestamp]),
    [
      [101, 0],
      [202, 500000],
      [303, 1000000],
    ],
  );
  for (const entry of entries.slice(0, 3)) assert.equal((await readZipEntry(bytes, entry))[0], 137);
  assert.deepEqual(manifest.provenance, { source: 'NOAA' });
  assert.equal(timeline.index, 1);
  assert.deepEqual(seen, [0, 1, 2, 1]);
});
