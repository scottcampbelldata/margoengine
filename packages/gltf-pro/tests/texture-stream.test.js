// `textures` of @margoengine/gltf-pro/progressive, on a mock GPU with the real Basis transcoder behind it and a real KTX2 file
// (fixtures/streaming/NOTICE.md). The real-GPU run is in scripts/test-extensions-browser.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { transcodeKTX2Layers } from '../../decoders/dist/codec.js';
import { basis } from '../../decoders/tests/support/ktx2.js';
import { loadGLTFProgressive } from '../dist/progressive.js';
import { measureSurface, scaleOf } from '../../shared/texture-density.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const file = new Uint8Array(
  await readFile(new URL('./fixtures/streaming/FlightHelmet_Materials_LensesMat_BaseColor.ktx2', import.meta.url)),
);

// A packed quad, 2 by 2 in x and y, with `uv` as the far corner of its UV square, plus set 2 when `later` is set.
function quad(uv, later) {
  const vertices = new Float32Array(80),
    corners = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
  corners.forEach(([x, y, s, t], i) => {
    vertices.set([x, y, 0, 1], i * 20);
    vertices.set([s * uv, t * uv], i * 20 + 12);
  });
  const uvs = later && new Float32Array(16);
  if (later) corners.forEach(([, , s, t], i) => uvs.set([s * later, t * later, 0, 0], i * 4));
  return [vertices, new Uint32Array([0, 1, 2, 0, 2, 3]), uvs];
}

test('a span is the local length one whole texture covers, tiled or atlased', () => {
  assert.equal(measureSurface(...quad(1)).spans[0], 2, 'one texture over the 2 unit quad');
  assert.equal(measureSurface(...quad(4)).spans[0], 0.5, 'tiled 4 times, one texture covers a quarter');
  assert.equal(measureSurface(...quad(0.25)).spans[0], 8, 'a quarter of an atlas: the whole texture would span 8');
  assert.equal(measureSurface(...quad(1, 2)).spans[2], 1, 'UV set 2 reads the second array');
  const { centre, radius, spans } = measureSurface(...quad(0));
  assert.deepEqual(centre, [0, 0, 0]);
  assert.equal(radius, Math.SQRT2);
  assert.equal(spans[0], 2 * Math.SQRT2, 'no UV area spans the bounding sphere');
  assert.equal(spans[1], 2 * Math.SQRT2);
});

test('scaleOf is the largest column length', () => {
  assert.equal(scaleOf([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 5, 5, 1]), 3);
  assert.equal(scaleOf([9, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0], 4), 4);
});

// The quad as a GLB, with its KTX2 image past the 256 KB blocks geometry is read in.
function glb() {
  const at = 512 << 10,
    bin = new Uint8Array(at + file.length),
    positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(uvs.buffer), 48);
  bin.set(new Uint8Array(indices.buffer), 80);
  bin.set(file, at);
  const doc = JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_texture_basisu'],
      extensionsRequired: ['KHR_texture_basisu'],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
      images: [{ bufferView: 3, mimeType: 'image/ktx2' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
        { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 48 },
        { buffer: 0, byteOffset: 48, byteLength: 32 },
        { buffer: 0, byteOffset: 80, byteLength: 12 },
        { buffer: 0, byteOffset: at, byteLength: file.length },
      ],
      buffers: [{ byteLength: bin.length }],
    }),
    text = new TextEncoder().encode(doc.padEnd(Math.ceil(doc.length / 4) * 4)),
    pad = (bin.length + 3) & ~3,
    out = new Uint8Array(28 + text.length + pad),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + text.length, pad, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}
const body = glb(),
  reads = [];
const server = createServer((request, response) => {
  const plain = request.url.startsWith('/plain/'),
    range = !plain && /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  if (request.url.endsWith('/missing.glb')) return response.writeHead(404).end();
  if (!range) {
    reads.push([0, body.length]);
    return response.writeHead(200, { 'content-length': body.length }).end(body);
  }
  const from = +range[1],
    to = Math.min(range[2] ? +range[2] + 1 : body.length, body.length);
  reads.push([from, to]);
  response
    .writeHead(206, { 'content-range': `bytes ${from}-${to - 1}/${body.length}`, 'content-length': to - from })
    .end(body.subarray(from, to));
});
server.keepAliveTimeout = 0;
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function mockDevice(log) {
  const device = optionalGPU().engine.gpu,
    create = device.createTexture;
  device.createTexture = (descriptor) => {
    const texture = create.call(device, descriptor);
    return Object.assign(texture, descriptor, {
      device,
      createView: (view = {}) => ({ texture, format: view.format ?? descriptor.format }),
      destroy() {
        log.destroyed++;
        texture.gone = true;
      },
    });
  };
  device.createSampler = (descriptor) => ({ descriptor });
  device.createCommandEncoder = () => ({
    copyTextureToTexture() {},
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  device.queue.submit = () => {};
  device.queue.writeTexture = () => {};
  device.limits.maxTextureDimension2D = 8192;
  return device;
}
async function scene() {
  const log = { destroyed: 0 },
    device = mockDevice(log),
    store = await TransformStore.create(1024);
  const engine = new Engine(
    { width: 256, height: 256, clientWidth: 256, clientHeight: 256 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 400], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(1, true);
  const module = await basis(),
    decoder = {
      target: 'rgba8',
      decode: async (data, { exactTarget }) => transcodeKTX2Layers(module, data, exactTarget, true),
    };
  return { engine, store, decoder, log };
}
// Polls until `done`, each round letting the local server and the decoder run; the five seconds only guard against a hang.
const until = async (done) => {
  const end = Date.now() + 5000;
  while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
};
const baseView = (model) => model['resources'][0].views[0];

test('a KTX2 image in a GLB opens from its head over Range, and its finer levels follow the camera', async () => {
  const { engine, store, decoder, log } = await scene();
  reads.length = 0;
  const load = loadGLTFProgressive(engine, `${base}/model.glb`, { textures: { decoder } }),
    model = await load.complete,
    stream = await load.textures;
  store.tick(false);
  assert.ok(Math.max(...reads.map(([, to]) => to)) < body.length - 4, 'the largest level stayed on the server');
  stream.update();
  const [far] = stream.textures;
  assert.equal(far.levels, 11);
  // A 2 unit quad at 400 units: under 2 px on screen, so the coarsest level there is.
  assert.ok(far.pixels < 2);
  const view = baseView(model);
  assert.equal(view.format, 'rgba8unorm-srgb', 'base colour reads as sRGB');
  assert.equal(view.texture.mipLevelCount, far.levels - far.level);

  engine.camera.position = [0, 0, 2];
  engine.camera.update(1, true);
  await until(() => {
    stream.update();
    return stream.textures[0].level === 0;
  });
  const [near] = stream.textures;
  assert.equal(near.level, 0, 'close up the whole texture is wanted');
  assert.ok(near.pixels > 513);
  assert.deepEqual(baseView(model).texture.size.slice(0, 2), [1024, 1024]);
  assert.notEqual(baseView(model), view, 'the draw took the new texture');
  assert.ok(Math.max(...reads.map(([, to]) => to)) >= body.length - 4, 'the largest level came over the network');
  assert.ok(log.destroyed >= near.levels - 4, 'textures left behind are destroyed');

  stream.budgetBytes = 1;
  engine.camera.position = [0, 0, 400];
  engine.camera.update(1, true);
  stream.update();
  assert.ok(stream.textures[0].level > 0, 'over budget the unneeded levels go');
  assert.equal(baseView(model).texture.size[0], 1024 >> stream.textures[0].level);

  const last = baseView(model).texture;
  model.dispose();
  assert.ok(last.gone, 'disposing the model frees the stream');
  assert.equal(stream.textures.length, 0);
});

test('after a device restore the slot draws its default, then the same file on the new device', async () => {
  const { engine, decoder, log } = await scene(),
    load = loadGLTFProgressive(engine, `${base}/model.glb`, { textures: { decoder } }),
    model = await load.complete,
    stream = await load.textures,
    old = baseView(model).texture,
    plugins = [...engine.scene.plugins.values()];
  assert.equal(plugins.length, 2);
  engine['renderer'].gpu = mockDevice(log);
  for (const plugin of plugins) plugin.onDeviceRestored?.(engine);
  assert.notEqual(baseView(model).texture.device, old.device);
  // A stream's texture can be copied from; a slot's default cannot.
  const back = () => baseView(model).texture.usage & GPUTextureUsage.COPY_SRC;
  assert.ok(!back(), 'the default stands in');
  await until(back);
  assert.equal(baseView(model).texture.device, engine.gpu);
  assert.ok(back(), 'the stream is back');
  assert.equal(stream.textures[0].levels, 11);
  model.dispose();
});

test('a server without Range sends the file once, and the texture streams from memory', async () => {
  const { engine, decoder } = await scene();
  reads.length = 0;
  const load = loadGLTFProgressive(engine, `${base}/plain/model.glb`, { textures: { decoder } }),
    model = await load.complete,
    stream = await load.textures;
  assert.equal(stream.textures[0].levels, 11);
  assert.equal(reads.length, 1, `${reads.length} reads`);
  model.dispose();
});

test('a file the plain loader takes still streams, and without `textures` there is no stream', async () => {
  const { engine, decoder } = await scene(),
    calls = [];
  const load = loadGLTFProgressive(engine, `${base}/model.glb`, {
      textures: { decoder },
      fetch: (...args) => {
        calls.push(args[0]);
        return fetch(...args);
      },
    }),
    model = await load.complete,
    stream = await load.textures;
  assert.ok(calls.length > 0, 'the plain loader ran');
  assert.equal(stream.textures[0].levels, 11);
  assert.ok(baseView(model).texture.mipLevelCount < 11);
  model.dispose();
  const plain = loadGLTFProgressive(engine, `${base}/missing.glb`);
  assert.equal(plain.textures, undefined);
  await assert.rejects(plain.complete);
});

test('a load that fails or aborts frees its streams', async () => {
  const { engine, decoder } = await scene(),
    missing = loadGLTFProgressive(engine, `${base}/missing.glb`, { textures: { decoder } });
  await assert.rejects(missing.complete);
  const missed = await missing.textures;
  await until(() => missed.textures.length === 0);
  assert.equal(missed.textures.length, 0);
  const load = loadGLTFProgressive(engine, `${base}/model.glb`, { textures: { decoder } });
  await load.ready;
  load.abort(new Error('stop'));
  await assert.rejects(load.complete, /stop/);
  const stopped = await load.textures;
  await until(() => stopped.textures.length === 0);
  assert.equal(stopped.textures.length, 0);
});
