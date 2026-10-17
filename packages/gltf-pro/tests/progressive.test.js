// HANDOFF 5g.c: @margoengine/gltf-pro/progressive. Once `complete` resolves the model's GPU data (every draw resource's
// vertex, index and uniform bytes, every bound texture's descriptor and uploads, every sampler) and its CPU side (document,
// buffers, accessors, primitives, images, transform store) equal a plain loadGLTF of the same file, byte for byte; over HTTP
// range requests and a server without range support, on the main thread and through the worker script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DracoDecoder } from '../../decoders/dist/index.js';
import { loadGLTF } from '../dist/index.js';
import { loadGLTFProgressive } from '../dist/progressive.js';
import { instancing } from '../dist/instancing.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { snapshot } from '../../../tests/support/pbr-snapshot.js';
import { assertSameBytes, bytes } from '../../../tests/support/parse-worker.js';
import { bigGLB } from '../../../tests/support/big-glb.js';

const asset = (name) => readFile(new URL(`../../../examples/assets/${name}`, import.meta.url));
// A GLB split into .gltf JSON + external .bin (and the BIN chunk dropped), for the external-buffer path.
function split(glb, bin) {
  const v = new DataView(glb.buffer, glb.byteOffset),
    length = v.getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  json.buffers[0].uri = bin;
  return { json: JSON.stringify(json), bin: glb.slice(28 + length) };
}
const helmet = new Uint8Array(await asset('damaged-helmet.glb')),
  robot = new Uint8Array(await asset('robot-expressive.glb'));
const grids = bigGLB({ segments: 256, meshes: 3 }),
  parts = bigGLB({ segments: 6, meshes: 3, instances: 12 }),
  external = split(bigGLB({ segments: 40, meshes: 2 }), 'external.bin');
const files = {
  '/helmet.glb': helmet,
  '/robot.glb': robot,
  '/grids.glb': grids,
  '/parts.glb': parts,
  '/external.gltf': Buffer.from(external.json),
  '/external.bin': external.bin,
};

// Static server; paths under /plain/ ignore Range (a server without range support). Records every request.
const log = [];
const server = createServer((request, response) => {
  const plain = request.url.startsWith('/plain/'),
    path = request.url.replace('/plain/', '/'),
    body = files[path];
  if (!body) {
    response.writeHead(404);
    response.end();
    return;
  }
  const range = !plain && /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  log.push({ path: request.url, range: request.headers.range ?? null });
  if (!range) {
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
    return;
  }
  const lo = +range[1],
    hi = Math.min(range[2] ? +range[2] : body.length - 1, body.length - 1);
  response.writeHead(206, { 'content-range': `bytes ${lo}-${hi}/${body.length}`, 'content-length': hi - lo + 1 });
  response.end(body.subarray(lo, hi + 1));
});
// Client closes idle sockets: a server keep-alive close can race a reused socket under load (ECONNRESET).
server.keepAliveTimeout = 0;
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// Mock WebGPU that keeps what reaches the GPU: buffer bytes, texture descriptors and uploads, sampler descriptors.
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
async function gpuEngine() {
  const h = optionalGPU(),
    device = h.engine.gpu,
    store = await TransformStore.create(4096);
  const createTexture = device.createTexture;
  device.createTexture = (descriptor) => Object.assign(createTexture.call(device, descriptor), { uploads: [] });
  device.createSampler = (descriptor) => ({ descriptor });
  device.createCommandEncoder = () => ({
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  device.queue.submit = () => {};
  device.queue.copyExternalImageToTexture = (source, { texture }, size) =>
    texture.uploads.push(['bitmap', source.bytes, size]);
  device.queue.writeTexture = ({ texture, mipLevel }, data, layout, size) =>
    texture.uploads.push(['write', mipLevel ?? 0, Buffer.from(bytes(data)), layout, size]);
  device.limits.maxTextureDimension2D = 8192;
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(128 / 96, true);
  const encoder = {
    beginRenderPass: () => ({
      setPipeline() {},
      setBindGroup() {},
      setBlendConstant() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      drawIndexed() {},
      end() {},
    }),
  };
  const draw = (model) => {
    store.tick(false);
    const context = { ...h.context, camera: engine.camera, encoder };
    model.draw(context, 'beauty', context.color, context.depth);
  };
  return { engine, device, draw, resources: h.resources };
}
const texture = (t) => ({
  size: t.size,
  format: t.format,
  mipLevelCount: t.mipLevelCount,
  usage: t.usage,
  uploads: t.uploads,
  destroyed: t.destroyed,
});
// Everything the model put on the GPU, per draw resource in draw order, after one drawn frame wrote the uniforms.
function gpu(model, draw) {
  draw(model);
  return {
    resources: model['resources'].map((r) => ({
      vertex: bytes(r.vertex.data),
      index: bytes(r.index.data),
      uniform: bytes(r.uniform.data),
      live: [r.vertex, r.index, r.uniform].map((b) => b.destroyed),
      sizes: [r.vertex.size, r.index.size, r.vertex.usage, r.index.usage],
      views: r.views.map((v) => texture(v.texture)),
      samplers: r.samplers.map((s) => s.descriptor),
    })),
    textures: model['textures'].map(texture).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}
// Node has no image decoder: a "bitmap" carries its encoded bytes (structured-cloneable, as through the worker).
const bitmapStub = async (blob, options) => ({
  width: 4,
  height: 4,
  bytes: new Uint8Array(await blob.arrayBuffer()),
  type: blob.type,
  options: options ?? null,
});
// The worker script run in-process; messages go through structuredClone with their transfer lists, as in a browser.
class InProcessWorker {
  static created = 0;
  constructor() {
    InProcessWorker.created++;
    const scope = {
      postMessage: (data, transfer) => {
        const copy = structuredClone(data, { transfer });
        setTimeout(() => {
          if (!this.terminated) this.onmessage?.({ data: copy });
        });
      },
    };
    new Function(
      'self',
      readFileSync(fileURLToPath(new URL('../dist/workers/progressive.js', import.meta.url)), 'utf8'),
    )(scope);
    this.scope = scope;
  }
  postMessage(data) {
    const copy = structuredClone(data);
    setTimeout(() => {
      if (!this.terminated) this.scope.onmessage({ data: copy });
    });
  }
  terminate() {
    this.terminated = true;
  }
}
async function withGlobals(worker, run) {
  const saved = {
    createImageBitmap: globalThis.createImageBitmap,
    Worker: globalThis.Worker,
    location: globalThis.location,
  };
  globalThis.createImageBitmap = bitmapStub;
  if (worker) {
    globalThis.Worker = InProcessWorker;
    globalThis.location = { href: base + '/' };
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
  }
}

test('progressive geometry replaces and releases wireframe edge buffers created before completion', (t) =>
  withGlobals(false, async () => {
    const { engine, draw } = await gpuEngine(),
      load = loadGLTFProgressive(engine, base + '/grids.glb', { frameBudget: 0 }),
      model = await load.ready;
    t.after(() => engine.dispose());
    for (const primitive of model.primitives) primitive.material.wireframe = true;
    draw(model);
    const placeholders = model['resources'].map((resource) => resource.wireframe.index);
    assert.ok(placeholders.length > 0);
    assert.ok(placeholders.every((buffer) => !buffer.destroyed));
    await load.complete;
    assert.ok(
      placeholders.every((buffer) => buffer.destroyed),
      'replacing placeholder resources must release their edge buffers',
    );
    draw(model);
    const final = model['resources'].flatMap((resource) => (resource.wireframe ? [resource.wireframe.index] : []));
    assert.ok(final.length > 0);
    assert.ok(final.every((buffer) => !buffer.destroyed && !placeholders.includes(buffer)));
    model.dispose();
    assert.ok(final.every((buffer) => buffer.destroyed));
  }));

test('progressive textured materials retain live wireframe through the internal texture swap', (t) =>
  withGlobals(false, async () => {
    const { engine } = await gpuEngine(),
      load = loadGLTFProgressive(engine, base + '/helmet.glb'),
      model = await load.ready;
    t.after(() => engine.dispose());
    assert.ok(model.primitives.some((primitive) => primitive.material.maps.every((map) => !map)));
    for (const primitive of model.primitives) primitive.material.wireframe = true;
    await load.complete;
    assert.ok(model.primitives.some((primitive) => primitive.material.maps.some(Boolean)));
    assert.ok(
      model.primitives.every((primitive) => primitive.material.wireframe === true),
      'a streamed texture must preserve the live wireframe choice',
    );
  }));

test('progressive wireframe replacement releases both edge and replacement resources after a disposal error', (t) =>
  withGlobals(false, async () => {
    const { engine, draw, resources } = await gpuEngine(),
      load = loadGLTFProgressive(engine, base + '/grids.glb', { frameBudget: 0 }),
      model = await load.ready;
    t.after(() => engine.dispose());
    for (const primitive of model.primitives) primitive.material.wireframe = true;
    draw(model);
    const placeholders = model['resources'].map((resource) => resource.wireframe.index),
      uniform = model['resources'][0].uniform,
      destroy = uniform.destroy.bind(uniform),
      failure = new Error('uniform disposal failed');
    let calls = 0;
    uniform.destroy = () => {
      destroy();
      if (!calls++) throw failure;
    };
    await assert.rejects(load.complete, (error) => error === failure);
    assert.equal(model.disposed, true);
    assert.ok(placeholders.every((buffer) => buffer.destroyed));
    assert.ok(
      resources.filter((resource) => resource.usage & GPUBufferUsage.UNIFORM).every((buffer) => buffer.destroyed),
      'failed replacement must release the newly allocated uniforms too',
    );
  }));

for (const [name, path, decoders] of [
  ['DamagedHelmet (textured, tangents)', '/helmet.glb'],
  ['RobotExpressive (skins, morph targets, animations, many primitives)', '/robot.glb'],
  ['3 x 66k-vertex grids (one without normals; several range requests)', '/grids.glb'],
  ['grids drawn 12 times each through EXT_mesh_gpu_instancing', '/parts.glb', { instancing }],
  ['.gltf with an external .bin', '/external.gltf'],
])
  for (const mode of ['main thread', 'worker'])
    for (const plain of [false, true])
      test(`progressive ${name}, ${mode}, ${plain ? 'no range support' : 'range requests'}: complete equals loadGLTF`, () =>
        withGlobals(mode === 'worker', async () => {
          const url = base + (plain ? '/plain' : '') + path,
            a = await gpuEngine(),
            b = await gpuEngine(),
            stages = [];
          const expected = await loadGLTF(a.engine, url, { decoders });
          log.length = 0;
          const created = InProcessWorker.created;
          const load = loadGLTFProgressive(b.engine, url, { decoders, onProgress: (p) => stages.push(p.stage) });
          const model = await load.ready;
          // Ready: one box per primitive, spanning its POSITION accessor's min/max.
          assert.ok(model.primitives.every((p) => p.vertices.length === 24 * 20 && p.indices.length === 36));
          const position = model.asset.doc.accessors[model.primitives[0].definition.attributes.POSITION],
            v = model.primitives[0].vertices;
          for (let c = 0; c < 3; c++) {
            const values = Array.from({ length: 24 }, (_, i) => v[i * 20 + c]);
            assert.deepEqual(
              [Math.min(...values), Math.max(...values)],
              [Math.fround(position.min[c]), Math.fround(position.max[c])],
            );
          }
          assert.equal(await load.complete, model);
          assert.equal(InProcessWorker.created - created, mode === 'worker' ? 1 : 0);
          assert.deepEqual([stages[0], stages.at(-1)], ['ready', 'complete']);
          assertSameBytes(snapshot(model), snapshot(expected));
          assertSameBytes(gpu(model, b.draw), gpu(expected, a.draw));
          if (decoders) assert.ok(model.primitives.every((p) => p.instances?.count === 12));
          // Without range support each file is downloaded once; with ranges, about once (requests round to 256 KB blocks).
          const requests = log.filter((r) => r.path.endsWith(path) || r.path.endsWith('.bin'));
          if (plain) assert.equal(requests.length, path.endsWith('.gltf') ? 2 : 1);
          else {
            const served = requests.reduce((sum, r) => {
              const m = /bytes=(\d+)-(\d*)/.exec(r.range);
              return sum + (m[2] ? +m[2] + 1 - m[1] : files[r.path].length - m[1]);
            }, 0);
            assert.ok(
              served <=
                Object.entries(files)
                  .filter(([p]) => requests.some((r) => r.path === p))
                  .reduce((sum, [, f]) => sum + f.length, 0) *
                  1.1 +
                  65536,
              `${served} bytes requested`,
            );
            if (path === '/grids.glb') assert.ok(requests.length > 3, `${requests.length} requests`);
          }
          model.dispose();
          expected.dispose();
        }));

test('the primitive nearest the camera inside the view streams first', () =>
  withGlobals(false, async () => {
    const { engine } = await gpuEngine(),
      loaded = [],
      load = loadGLTFProgressive(engine, base + '/grids.glb', {
        onProgress: (p) => {
          if (p.stage === 'geometry')
            loaded.push(model.primitives.findIndex((q, i) => q.vertices.length !== 480 && !loaded.includes(i)));
        },
      });
    const model = await load.ready;
    // Grids sit side by side along x (0, 4.5, 9); look straight at the last one from close by.
    engine.camera.position = [9, 3, 1];
    engine.camera.target = [9, 0, 0];
    engine.camera.update(128 / 96, true);
    await load.complete;
    assert.equal(loaded[0], 2, `load order ${loaded}`);
    model.dispose();
  }));

test('abort and dispose stop the load; errors keep their type', () =>
  withGlobals(false, async () => {
    const { engine } = await gpuEngine();
    let load = loadGLTFProgressive(engine, base + '/grids.glb'),
      model = await load.ready;
    load.abort();
    await assert.rejects(load.complete, { name: 'AbortError' });
    assert.equal(model.disposed, true);
    load = loadGLTFProgressive(engine, base + '/grids.glb');
    model = await load.ready;
    model.dispose();
    await assert.rejects(load.complete, { name: 'AbortError' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loadGLTFProgressive(engine, base + '/grids.glb', { signal: controller.signal }).ready, {
      name: 'AbortError',
    });
    await assert.rejects(loadGLTFProgressive(engine, base + '/missing.glb').ready, /HTTP 404/);
  }));

test('Draco, meshopt or KTX2 decoders fall back to loadGLTF', () =>
  withGlobals(false, async () => {
    const { engine } = await gpuEngine(),
      load = loadGLTFProgressive(engine, base + '/helmet.glb', { decoders: { meshopt: { decodeGltfBuffer() {} } } });
    assert.equal(load.ready, load.complete);
    const model = await load.complete;
    assert.equal(
      model.primitives[0].vertices.length,
      model.asset.doc.accessors[model.primitives[0].definition.attributes.POSITION].count * 20,
    );
    model.dispose();
  }));

test('maxDownloadBytes bounds loadGLTF and progressive loads (main thread and worker); the error names the option', async () => {
  const suffix = ` (${helmet.length - 1} bytes; raise the maxDownloadBytes option)`;
  for (const mode of ['main thread', 'worker'])
    for (const path of ['/helmet.glb', '/plain/helmet.glb'])
      await withGlobals(mode === 'worker', async () => {
        const { engine } = await gpuEngine();
        await assert.rejects(
          loadGLTFProgressive(engine, base + path, { maxDownloadBytes: helmet.length - 1 }).ready,
          { name: 'RangeError', message: 'glTF exceeds download budget' + suffix },
          `${mode} ${path}`,
        );
        const model = await loadGLTFProgressive(engine, base + path, { maxDownloadBytes: helmet.length }).complete;
        assert.equal(model.asset.maxBytes, helmet.length);
        model.dispose();
      });
  await withGlobals(false, async () => {
    const { engine } = await gpuEngine();
    await assert.rejects(loadGLTF(engine, base + '/helmet.glb', { maxDownloadBytes: helmet.length - 1 }), {
      name: 'RangeError',
      message: 'glTF download byte budget exceeded' + suffix,
    });
    (await loadGLTF(engine, base + '/helmet.glb', { maxDownloadBytes: helmet.length })).dispose();
    await assert.rejects(loadGLTFProgressive(engine, base + '/helmet.glb', { maxDownloadBytes: 0 }).ready, {
      name: 'RangeError',
      message: 'maxDownloadBytes must be a positive integer',
    });
  });
});

for (const useWorker of [false, true])
  test(`automatic compressed progressive input falls back before publishing a placeholder (${useWorker ? 'worker' : 'main'})`, () =>
    withGlobals(useWorker, async () => {
      const decode = DracoDecoder.prototype.decode;
      DracoDecoder.prototype.decode = async () => ({
        vertexCount: 3,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint16Array([0, 1, 2]),
      });
      const doc = {
        asset: { version: '2.0' },
        buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AQIDBA==' }],
        bufferViews: [{ buffer: 0, byteLength: 4 }],
        accessors: [{ componentType: 5126, count: 3, type: 'VEC3' }],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0 },
                extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } },
              },
            ],
          },
        ],
        nodes: [{ mesh: 0 }],
      };
      files['/compressed.gltf'] = Buffer.from(JSON.stringify(doc));
      const { engine } = await gpuEngine();
      try {
        const loading = loadGLTFProgressive(engine, base + '/compressed.gltf');
        const model = await loading.ready;
        assert.equal(await loading.complete, model);
        assert.equal(model.primitives[0].vertices.length, 60);
        assert.deepEqual([...model.primitives[0].indices], [0, 1, 2]);
      } finally {
        engine.dispose();
        DracoDecoder.prototype.decode = decode;
        delete files['/compressed.gltf'];
      }
    }));
