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

function captureFixture() {
  const created = [],
    removed = [],
    projections = [];
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
    limits: { maxTextureDimension2D: 4, maxBufferSize: 1e6 },
    createTexture: () => own(),
    createBuffer: ({ size }) =>
      own({ mapAsync: async () => {}, getMappedRange: () => new ArrayBuffer(size), unmap() {} }),
    createCommandEncoder: () => ({ copyTextureToBuffer() {}, finish() {} }),
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
    render({ views }) {
      views[0].camera.update(1, true);
      projections.push(views[0].camera.matrix.slice());
    },
  };
  const figure = {
    engine,
    theme: { background: '#ffffff' },
    ready: async () => {},
    render() {},
    exportLayout: () => ({ roots: [], bars: [] }),
    vectorAxes: () => [],
    layers: [],
  };
  return { figure, created, removed, projections };
}

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
