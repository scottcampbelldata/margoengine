// Real-GPU checks of gltf-pro's file extensions, each through the real loaders on a physical adapter. Run from the
// repository root after `npm run build:packages`: `npm run test:extensions:browser --workspace packages/gltf-pro`.
// MARGO_SPLAT_SAMPLES names a folder holding the large tower.glb capture (tests/fixtures/splats/NOTICE.md).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { cubeDocument } from '../tests/support/cube-png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page, hardware } = browser,
  errors = [],
  size = 256;
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

/** Opens a canvas and engine in the page, as `window.check`. */
const open = () =>
  page.evaluate(async (size) => {
    const { Engine } = await import('/packages/core/dist/index.js');
    document.querySelector('canvas')?.remove();
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px`;
    canvas.width = canvas.height = size;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } });
    engine.gpu.addEventListener?.('uncapturederror', (event) => console.error(event.error.message));
    engine.gpu.pushErrorScope('validation');
    window.check = { engine };
  }, size);
/** Renders and takes the canvas as RGBA pixels. */
async function pixels() {
  await page.evaluate(async () => {
    const { engine } = window.check,
      { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    engine.start();
    // Pipelines compile off the frame, and fitToBoundingBox moves the camera over several frames.
    let last;
    const still = () => {
      const now = String(engine.camera.position),
        same = now === last;
      last = now;
      return same;
    };
    const frame = async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await engine.gpu.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(frame, { ready: still });
  });
  const shot = await decodePNG(await page.locator('canvas').screenshot());
  return { ...shot, at: (x, y) => [...shot.data.subarray((y * shot.width + x) * 4, (y * shot.width + x) * 4 + 3)] };
}
/** Closes the engine and fails on any WebGPU validation error since `open`. */
const close = () =>
  page.evaluate(async () => {
    const { engine } = window.check,
      error = await engine.gpu.popErrorScope();
    engine.dispose();
    if (error) throw new Error(error.message);
  });
const lit = (image, floor = 24) => {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] > floor || image.data[i + 1] > floor || image.data[i + 2] > floor) count++;
  return count;
};

/**
 * A flat 2 x 2 quad in the z = 0 plane, x along u, drawn through the extended shader with the node's `scale`, seen from
 * +z, or -z with `back`: `ramp` a 256 x 1 map of x / 255 (a rise of 256/255 over u), or a flat one; `normal` the vertex
 * normal. Returns the canvas pixels.
 */
async function bumpQuad({ ramp, normal = [0, 0, 1], scale = [1, 1, 1], bump = {}, back = false }) {
  await open();
  await page.evaluate(
    async ({ ramp, normal, scale, bump, back }) => {
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
        { extendedMaterials } = await import('/packages/gltf-pro/dist/extended.js'),
        { engine } = window.check,
        floats = new Float32Array([
          ...[-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
          ...normal,
          ...normal,
          ...normal,
          ...normal,
          ...[0, 1, 1, 1, 1, 0, 0, 0],
        ]),
        indices = new Uint16Array([0, 1, 2, 0, 2, 3]),
        bytes = new Uint8Array(floats.byteLength + indices.byteLength);
      bytes.set(new Uint8Array(floats.buffer));
      bytes.set(new Uint8Array(indices.buffer), floats.byteLength);
      const pixels = new Uint8ClampedArray(256 * 4);
      for (let x = 0; x < 256; x++) pixels.set(ramp ? [x, x, x, 255] : [128, 128, 128, 255], x * 4);
      const image = await createImageBitmap(new ImageData(pixels, 256, 1), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        }),
        view = (byteOffset, byteLength) => ({ buffer: 0, byteOffset, byteLength }),
        accessor = (bufferView, type, count, componentType = 5126) => ({ bufferView, componentType, count, type });
      const doc = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, scale }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
        materials: [
          {
            doubleSided: true,
            pbrMetallicRoughness: { baseColorFactor: [0.7, 0.7, 0.7, 1], metallicFactor: 0, roughnessFactor: 0.5 },
            extensions: { EXT_materials_bump: { bumpFactor: 1, bumpTexture: { index: 0 }, ...bump } },
          },
        ],
        textures: [{ source: 0 }],
        images: [{}],
        buffers: [{ byteLength: bytes.byteLength }],
        bufferViews: [view(0, 48), view(48, 48), view(96, 32), view(128, 12)],
        accessors: [
          { ...accessor(0, 'VEC3', 4), min: [-1, -1, 0], max: [1, 1, 0] },
          accessor(1, 'VEC3', 4),
          accessor(2, 'VEC2', 4),
          accessor(3, 'SCALAR', 6, 5123),
        ],
      };
      await parseGLTFAsync(engine, doc, [bytes], [image], { materials: extendedMaterials });
      engine.camera.position = [0, 0, back ? -4 : 4];
      engine.camera.target = [0, 0, 0];
    },
    { ramp, normal, scale, bump, back },
  );
  const image = await pixels();
  await close();
  return image;
}
/** The largest channel difference between two pictures over the middle of the canvas. */
function difference(a, b) {
  let worst = 0;
  for (let y = 96; y < 160; y += 4)
    for (let x = 96; x < 160; x += 4)
      a.at(x, y).forEach((v, c) => {
        worst = Math.max(worst, Math.abs(v - b.at(x, y)[c]));
      });
  return worst;
}
const unit = (x, y, z) => {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
};

/** GLB bytes of a glTF object and its binary chunk. */
function glb(json, bin) {
  const pad = (bytes, fill) => {
      const out = Buffer.alloc(Math.ceil(bytes.length / 4) * 4, fill);
      out.set(bytes);
      return out;
    },
    text = pad(Buffer.from(JSON.stringify(json)), 0x20),
    data = pad(bin, 0),
    head = Buffer.alloc(12),
    chunk = (bytes, type) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(bytes.length, 0);
      h.write(type, 4, 'latin1');
      return Buffer.concat([h, bytes]);
    };
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + text.length + 8 + data.length, 8);
  return Buffer.concat([head, chunk(text, 'JSON'), chunk(data, 'BIN\0')]);
}
/** The canvas pixels of GLB `bytes` from straight ahead, 4 units back. */
async function drawGLB(bytes, instanced = false) {
  await open();
  await page.evaluate(
    async ({ base64, instanced }) => {
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
        { instancing } = await import('/packages/gltf-pro/dist/instancing.js'),
        { engine } = window.check,
        data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
        model = await parseGLTFAsync(engine, data, instanced ? { decoders: { instancing } } : {});
      if (instanced && !model.primitives[0].instances) throw new Error('the node did not instance');
      engine.camera.position = [0, 0, 4];
      engine.camera.target = [0, 0, 0];
    },
    { base64: bytes.toString('base64'), instanced },
  );
  const image = await pixels();
  await close();
  return image;
}
/** The real file's JSON and binary chunk. */
function fourUV() {
  const bytes = readFileSync('packages/gltf-pro/tests/fixtures/uv/FourUV.glb'),
    length = bytes.readUInt32LE(12);
  return { json: JSON.parse(bytes.subarray(20, 20 + length)), bin: bytes.subarray(28 + length) };
}
/** The same file with TEXCOORD_2 and 3 in the first two sets, and its maps on them: the path every engine build has run. */
function firstTwoSets({ json, bin }) {
  const edited = structuredClone(json),
    p = edited.meshes[0].primitives[0],
    m = edited.materials[0];
  p.attributes = { ...p.attributes, TEXCOORD_0: p.attributes.TEXCOORD_2, TEXCOORD_1: p.attributes.TEXCOORD_3 };
  delete p.attributes.TEXCOORD_2;
  delete p.attributes.TEXCOORD_3;
  m.pbrMetallicRoughness.baseColorTexture.texCoord = 0;
  m.emissiveTexture.texCoord = 1;
  return { json: edited, bin };
}

/**
 * A 2 x 2 quad facing +z, seen from +z, whose one material has these `extensions` on a metal-free surface of `base`.
 * Everything is through `parseGLTFAsync`; with `installed`, `install(model)` from @margoengine/materials runs on it.
 */
async function scatterQuad(extensions, { base = [1, 1, 1], installed = false } = {}) {
  await open();
  await page.evaluate(
    async ({ extensions, base, installed }) => {
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
        { engine } = window.check,
        floats = new Float32Array([
          ...[-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
          ...[0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
          ...[0, 1, 1, 1, 1, 0, 0, 0],
        ]),
        indices = new Uint16Array([0, 1, 2, 0, 2, 3]),
        bytes = new Uint8Array(floats.byteLength + indices.byteLength);
      bytes.set(new Uint8Array(floats.buffer));
      bytes.set(new Uint8Array(indices.buffer), floats.byteLength);
      const view = (byteOffset, byteLength) => ({ buffer: 0, byteOffset, byteLength }),
        accessor = (bufferView, type, count, componentType = 5126) => ({ bufferView, componentType, count, type }),
        doc = {
          asset: { version: '2.0' },
          scene: 0,
          scenes: [{ nodes: [0] }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
          materials: [
            { pbrMetallicRoughness: { baseColorFactor: [...base, 1], metallicFactor: 0, roughnessFactor: 0.6 }, extensions },
          ],
          buffers: [{ byteLength: bytes.byteLength }],
          bufferViews: [view(0, 48), view(48, 48), view(96, 32), view(128, 12)],
          accessors: [
            { ...accessor(0, 'VEC3', 4), min: [-1, -1, 0], max: [1, 1, 0] },
            accessor(1, 'VEC3', 4),
            accessor(2, 'VEC2', 4),
            accessor(3, 'SCALAR', 6, 5123),
          ],
        };
      const model = await parseGLTFAsync(engine, doc, [bytes], []);
      if (installed) (await import('/packages/materials/dist/index.js')).install(model);
      engine.camera.position = [0, 0, 4];
      engine.camera.target = [0, 0, 0];
    },
    { extensions, base, installed },
  );
  const image = await pixels(),
    middle = image.at(size / 2, size / 2);
  await close();
  return middle;
}
/** The scene light behind a pixel: sRGB decoded, then the Khronos PBR Neutral offset put back (the peak stays under its 0.76 knee). */
const sceneLight = (pixel) => {
  const c = pixel.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)),
    low = Math.min(...c),
    x = low + 0.04 < 0.08 ? Math.sqrt(low / 6.25) : low + 0.04,
    offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  return c.map((v) => v + offset);
};

/** Draws the real EXT_lights_ies wall through loadGLTF and `/lights`, its fixture turned to `rotation`; without `light`, unlit by it. */
async function iesWall({ name = 'Example.gltf', rotation, light = true } = {}) {
  if (rotation) {
    const doc = JSON.parse(readFileSync('packages/gltf-pro/tests/fixtures/lights/Example.gltf', 'utf8'));
    doc.nodes[2].rotation = rotation;
    await page.route('**/Turned.gltf', (route) => route.fulfill({ json: doc }));
    name = 'Turned.gltf';
  }
  await open();
  await page.evaluate(
    async ({ name, light }) => {
      const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { applyGLTFLightExtensions } = await import('/packages/gltf-pro/dist/lights.js'),
        { engine } = window.check,
        model = await loadGLTF(engine, `/packages/gltf-pro/tests/fixtures/lights/${name}`);
      engine.camera.position = [0, 0, 9];
      engine.camera.target = [0, 0, 0];
      engine.lighting.radiance.fill(0);
      engine.lighting.ambient.fill(0);
      if (light) window.check.lights = await applyGLTFLightExtensions(model, { exposure: 0.03 });
    },
    { name, light },
  );
  const image = await pixels();
  await close();
  if (rotation) await page.unroute('**/Turned.gltf');
  return image;
}
/** Canvas pixel of the wall's front at x, y, seen from z = 9 at the default 60 degrees. */
const wallPixel = (x, y) => {
  const half = 8.95 * Math.tan(Math.PI / 6);
  return [Math.round(size / 2 + (x / half) * (size / 2)), Math.round(size / 2 - (y / half) * (size / 2))];
};
/** A quad facing the camera in an image-based light, with the file's `cube`. Returns the middle pixel. */
async function cubeQuad(cube) {
  await open();
  await page.evaluate(
    async ({ cube }) => {
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
        { applyGLTFLightExtensions } = await import('/packages/gltf-pro/dist/lights.js'),
        { engine } = window.check,
        floats = new Float32Array([
          ...[-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
          ...[0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        ]),
        indices = new Uint16Array([0, 1, 2, 0, 2, 3]),
        bytes = new Uint8Array(floats.byteLength + indices.byteLength);
      bytes.set(new Uint8Array(floats.buffer));
      bytes.set(new Uint8Array(indices.buffer), floats.byteLength);
      const view = (byteOffset, byteLength) => ({ buffer: 0, byteOffset, byteLength }),
        doc = {
          asset: { version: '2.0' },
          scene: 0,
          scenes: [{ nodes: [0], extensions: { EXT_lights_image_based: { light: 0 } } }],
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
          materials: [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } }],
          buffers: [{ byteLength: bytes.byteLength }],
          bufferViews: [view(0, 48), view(48, 48), view(96, 12)],
          accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
            { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
          ],
          // The images stand apart from what the material reads: nothing here is a texture.
          images: cube.images,
          extensions: { EXT_lights_image_based: { lights: [cube.light] } },
        };
      const model = await parseGLTFAsync(engine, doc, [bytes], []);
      window.check.lights = await applyGLTFLightExtensions(model);
      engine.lighting.radiance.fill(0);
      engine.lighting.ambient.fill(0);
      engine.camera.position = [0, 0, 4];
      engine.camera.target = [0, 0, 0];
    },
    { cube },
  );
  const image = await pixels(),
    middle = image.at(size / 2, size / 2);
  await close();
  return middle;
}

const streamFile = 'packages/gltf-pro/tests/fixtures/streaming/FlightHelmet_Materials_LensesMat_BaseColor.ktx2';
/** Serves `files` (name to bytes) with Range support to the page, counting the bytes sent. `ranges: false` sends them whole. */
async function rangeServer(files, ranges = true) {
  const served = { bytes: 0, requests: 0, spans: [] },
    server = createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url, 'http://x').pathname.slice(1)),
        headers = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges',
          ...(ranges ? { 'Accept-Ranges': 'bytes' } : {}),
        };
      if (request.method === 'OPTIONS') return response.writeHead(204, headers).end();
      const bytes = files[name];
      if (!bytes) return response.writeHead(404, headers).end();
      const range = ranges && /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? ''),
        from = range ? +range[1] : 0,
        to = range && range[2] ? Math.min(+range[2] + 1, bytes.length) : bytes.length,
        part = bytes.subarray(from, to);
      served.bytes += part.length;
      served.requests++;
      served.spans.push([from, to]);
      response
        .writeHead(range ? 206 : 200, {
          ...headers,
          ...(range ? { 'Content-Range': `bytes ${from}-${to - 1}/${bytes.length}` } : {}),
          'Content-Length': part.length,
        })
        .end(part);
    });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, served, close: () => server.close() };
}
/** A 2 by 2 quad facing +Z with one texture over it, image `image` as glTF JSON and its binary, `tail` at offset `at` of it. */
function texturedQuad(image, tail = new Uint8Array(0), at = 92) {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices = new Uint16Array([0, 1, 2, 0, 2, 3]),
    bytes = new Uint8Array(at + tail.length);
  bytes.set(new Uint8Array(positions.buffer), 0);
  bytes.set(new Uint8Array(uvs.buffer), 48);
  bytes.set(new Uint8Array(indices.buffer), 80);
  bytes.set(tail, at);
  return {
    bytes,
    doc: {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_texture_basisu'],
      extensionsRequired: ['KHR_texture_basisu'],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 }, emissiveFactor: [0, 0, 0] }],
      textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
      images: [image],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
        { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 48 },
        { buffer: 0, byteOffset: 48, byteLength: 32 },
        { buffer: 0, byteOffset: 80, byteLength: 12 },
        ...(tail.length ? [{ buffer: 0, byteOffset: at, byteLength: tail.length }] : []),
      ],
      buffers: [{ byteLength: bytes.length }],
    },
  };
}
/** Loads `url` with streaming textures as `window.check.load`, and waits until its levels stop changing at `camera`. */
const streamed = (url, options, camera) =>
  page.evaluate(
    async ({ url, options, camera }) => {
      const { loadGLTFProgressive } = await import('/packages/gltf-pro/dist/progressive.js'),
        { engine } = window.check;
      Object.assign(engine.camera, camera);
      const load = loadGLTFProgressive(engine, url, { textures: options });
      window.check.model = await load.complete;
      window.check.stream = await load.textures;
      engine.start();
    },
    { url, options, camera },
  );
/** Moves the camera and waits for the streams to settle; returns their levels and bytes. */
const settle = (camera) =>
  page.evaluate(async (camera) => {
    const { engine, stream } = window.check;
    Object.assign(engine.camera, camera);
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    let last,
      calm = 0;
    const steady = () => {
      stream.update();
      const now = JSON.stringify(stream.textures.map((t) => t.level));
      calm = now === last ? calm + 1 : 0;
      last = now;
      return calm > 40;
    };
    const frame = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await engine.gpu.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(frame, { ready: steady });
    return { textures: stream.textures, used: stream.usedBytes };
  }, camera);

const checks = {
  // A real Khronos KTX2 file on a quad. levelForPixels asks for the coarsest level at least as wide as the texture is on
  // screen, so the file's width over a power of two must lie at or above the on-screen width, and below twice it.
  async 'streaming: a real KTX2 texture loads the levels its size on screen needs, over HTTP Range'() {
    const file = new Uint8Array(readFileSync(streamFile)),
      quad = texturedQuad({ uri: 'lamp.ktx2' }),
      doc = { ...quad.doc, buffers: [{ ...quad.doc.buffers[0], uri: 'quad.bin' }] },
      host = await rangeServer({ 'quad.gltf': new TextEncoder().encode(JSON.stringify(doc)), 'quad.bin': quad.bytes, 'lamp.ktx2': file });
    await open();
    await streamed(`${host.url}quad.gltf`, {}, { position: [0, 0, 400], target: [0, 0, 0] });
    const far = await settle({ position: [0, 0, 400], target: [0, 0, 0] }),
      farBytes = host.served.bytes,
      [distant] = far.textures,
      // The quad is 2 wide; one unit at distance d is size / 2 / (d tan 30) pixels.
      across = (d) => (2 * size) / 2 / ((d - Math.SQRT2) * Math.tan(Math.PI / 6));
    assert.ok(distant.pixels > 0 && Math.abs(distant.pixels / across(400) - 1) < 1e-3, 'on-screen size from the camera');
    const near = await settle({ position: [0, 0, 2], target: [0, 0, 0] }),
      [close1] = near.textures;
    assert.ok(close1.level < distant.level, 'a closer camera loads finer levels');
    assert.ok(close1.width >> close1.level >= Math.min(close1.width, close1.pixels), 'at least as sharp as the screen');
    assert.ok(host.served.bytes > farBytes, 'the finer levels came over the network afterwards');
    assert.ok(farBytes < quad.bytes.length + file.length, 'far away the file is not all read');
    assert.ok(near.used > far.used, 'the finer levels are on the GPU');
    const image = await pixels();
    await close();
    // The same level 0 the plain loader uploads, so the same camera draws the same picture.
    await open();
    const whole = await page.evaluate(
      async ({ url }) => {
        const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
          { engine } = window.check;
        Object.assign(engine.camera, { position: [0, 0, 2], target: [0, 0, 0] });
        await loadGLTF(engine, url);
      },
      { url: `${host.url}quad.gltf` },
    );
    assert.equal(whole, undefined);
    const plain = await pixels();
    assert.equal(Buffer.compare(image.data, plain.data), 0, 'the same pixels as the plain loader');
    await close();
    host.close();
  },
  async 'streaming: a budget drops levels nothing needs, and the model keeps drawing'() {
    const file = new Uint8Array(readFileSync(streamFile)),
      quad = texturedQuad({ uri: 'lamp.ktx2' }),
      doc = { ...quad.doc, buffers: [{ ...quad.doc.buffers[0], uri: 'quad.bin' }] },
      host = await rangeServer({ 'quad.gltf': new TextEncoder().encode(JSON.stringify(doc)), 'quad.bin': quad.bytes, 'lamp.ktx2': file });
    await open();
    await streamed(`${host.url}quad.gltf`, {}, { position: [0, 0, 2], target: [0, 0, 0] });
    const held = await settle({ position: [0, 0, 2], target: [0, 0, 0] });
    await page.evaluate(() => {
      window.check.stream.budgetBytes = 1;
    });
    const dropped = await settle({ position: [0, 0, 400], target: [0, 0, 0] });
    assert.ok(dropped.used < held.used, 'over budget, the finer levels leave');
    assert.ok(dropped.textures[0].level > held.textures[0].level);
    await pixels();
    await close();
    host.close();
  },
  // In a GLB the image sits in the binary chunk: Range reads reach it there, and the rest of the chunk still loads. KTX2 keeps
  // the largest level last, so a far camera never reads the end of the file. The image starts past the 256 KB blocks geometry
  // is read in. Without Range the file comes whole, once, and the stream reads the same bytes from memory.
  async 'streaming: an image in a GLB binary chunk streams, with and without HTTP Range'() {
    const file = new Uint8Array(readFileSync(streamFile)),
      quad = texturedQuad({ bufferView: 3, mimeType: 'image/ktx2' }, file, 512 << 10),
      bytes = glb(quad.doc, Buffer.from(quad.bytes));
    for (const ranges of [true, false]) {
      const host = await rangeServer({ 'quad.glb': bytes }, ranges);
      await open();
      await streamed(`${host.url}quad.glb`, {}, { position: [0, 0, 400], target: [0, 0, 0] });
      const far = await settle({ position: [0, 0, 400], target: [0, 0, 0] });
      if (ranges) assert.ok(host.served.spans.every(([, to]) => to < bytes.length - 4), 'the largest level stays on the server');
      const near = await settle({ position: [0, 0, 2], target: [0, 0, 0] });
      assert.ok(near.textures[0].level < far.textures[0].level);
      await pixels();
      await close();
      host.close();
    }
  },
  // MARGO_SPLAT_SAMPLES/helmet holds the Khronos FlightHelmet glTF-KTX-BasisU files (CC0, 33 MB, so not in the repository).
  async 'streaming: the real FlightHelmet starts from a small part of its files'() {
    const folder = process.env.MARGO_SPLAT_SAMPLES;
    if (!folder || !existsSync(join(folder, 'helmet/FlightHelmet.gltf'))) {
      console.log('FlightHelmet absent: set MARGO_SPLAT_SAMPLES (packages/gltf-pro/README.md)');
      return;
    }
    const names = readdirSync(join(folder, 'helmet')),
      files = Object.fromEntries(names.map((name) => [name, new Uint8Array(readFileSync(join(folder, 'helmet', name)))])),
      total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0),
      host = await rangeServer(files);
    await open();
    await streamed(`${host.url}FlightHelmet.gltf`, {}, { position: [0, 0.3, 40], target: [0, 0.3, 0] });
    const far = await settle({ position: [0, 0.3, 40], target: [0, 0.3, 0] }),
      farBytes = host.served.bytes;
    const near = await settle({ position: [0, 0.35, 0.7], target: [0, 0.3, 0] }),
      nearBytes = host.served.bytes,
      image = await pixels();
    console.log(`FlightHelmet: ${names.length} files, ${total} B; far ${farBytes} B, ${far.used} B on the GPU; near ${nearBytes} B, ${near.used} B on the GPU`);
    assert.equal(far.textures.length, 15);
    assert.ok(farBytes < total / 2, 'far away, under half the files are read');
    assert.ok(near.used > far.used);
    assert.ok(new Set(Array.from({ length: 16 }, (_, i) => String(image.at(size / 2, 16 * i + 8)))).size > 4, 'the helmet draws');
    await close();
    host.close();
  },
  // The file's wall stands 0.1 behind a fixture aimed down it at y = 3. On the row y = 1, 2 below the fixture, the profile
  // dips to 3250 cd at 20 degrees and comes back to 5250 at 30, so the wall gets brighter going outward, which a light that
  // falls off smoothly cannot do. Each pixel is held to Lambert's law for its own place on the wall: the green of the tint
  // times exposure x I(theta) x cos i / d^2 / pi, with cos i = 0.1 / d.
  async 'lights: the real EXT_lights_ies Example draws its profile on the wall, from a uri and a bufferView'() {
    const plain = await iesWall({ light: false }),
      wall = await iesWall(),
      view = await iesWall({ name: 'Example_bufferView.gltf' }),
      dip = sceneLight(wall.at(...wallPixel(0.728, 1))),
      ring = sceneLight(wall.at(...wallPixel(1.155, 1))),
      { parseIES, iesCandela } = await import('../../clustered/dist/ies.js'),
      profile = parseIES(readFileSync('packages/gltf-pro/tests/fixtures/lights/LightProfile.ies', 'latin1')),
      lambert = (x, y) => {
        const half = 8.95 * Math.tan(Math.PI / 6),
          [px, py] = wallPixel(x, y),
          dx = ((px + 0.5) / (size / 2) - 1) * half,
          h = 3 - (1 - (py + 0.5) / (size / 2)) * half,
          d = Math.hypot(dx, h, 0.1),
          theta = (Math.atan2(Math.hypot(dx, 0.1), h) * 180) / Math.PI;
        return (0.485 * 0.03 * iesCandela(profile, theta, 0) * 0.1) / d ** 3 / Math.PI;
      };
    assert.deepEqual(plain.at(...wallPixel(0.728, 1)), [0, 0, 0], 'the wall has no other light');
    console.log(`wall: 20 degrees ${dip.map((v) => v.toFixed(3))}, 30 degrees ${ring.map((v) => v.toFixed(3))}`);
    console.log(`Lambert: ${lambert(0.728, 1).toFixed(3)}, ${lambert(1.155, 1).toFixed(3)}`);
    assert.ok(ring[1] > dip[1] * 1.05, `the ring at 30 degrees is brighter than the dip at 20: ${ring[1]} ${dip[1]}`);
    // An 8-bit step here is about 1 percent, and the shader's grid is 1 degree: 5 percent holds those and no wrong candela.
    assert.ok(Math.abs(dip[1] / lambert(0.728, 1) - 1) < 0.05, `the file's candela at 20 degrees: ${dip}`);
    assert.ok(Math.abs(ring[1] / lambert(1.155, 1) - 1) < 0.05, `the file's candela at 30 degrees: ${ring}`);
    // color is 0.181, 0.485, 0: the green over red of the tint, whatever the candela.
    assert.ok(Math.abs(ring[0] / ring[1] - 0.181 / 0.485) < 0.1, `the file's tint: ${ring}`);
    for (const point of [[0.728, 1], [1.155, 1], [0, 2]]) {
      const [px, py] = wallPixel(...point);
      assert.deepEqual(view.at(px, py), wall.at(px, py), `bufferView against uri at ${point}`);
    }
  },
  // The node is at y = 3: aimed down it lights the wall below and not above, and aimed up the other way round, which a
  // spot cone from the light's down axis could not reach.
  async 'lights: turning the node turns the beam, past a hemisphere'() {
    const s = Math.SQRT1_2,
      down = await iesWall(),
      up = await iesWall({ rotation: [s, 0, 0, s] }),
      green = (image, y) => image.at(...wallPixel(0, y))[1];
    console.log(`above, below: down ${green(down, 3.4)} ${green(down, 2.6)}, up ${green(up, 3.4)} ${green(up, 2.6)}`);
    assert.ok(green(down, 2.6) > 100 && green(down, 3.4) === 0, 'aimed down');
    assert.ok(green(up, 3.4) > 100 && green(up, 2.6) === 0, 'aimed up');
  },
  // Stand-in cube: the file EnvironmentTest cannot be committed. Only +Z shines, and the quad faces +Z. Half a turn puts
  // the bright face behind it, and a quarter turn beside it, where a Lambert surface still sees none of the face's centre
  // but some of its edge: the order bright, side, behind is what irradiance allows.
  async 'lights: an image-based light lights what faces it and its rotation turns it (stand-in cube)'() {
    const dark = [0, 0, 0, 255],
      white = [255, 255, 255, 255],
      colors = [dark, dark, dark, dark, white, dark],
      s = Math.SQRT1_2,
      facing = await cubeQuad(cubeDocument(colors)),
      side = await cubeQuad(cubeDocument(colors, { rotation: [0, s, 0, s] })),
      behind = await cubeQuad(cubeDocument(colors, { rotation: [0, 1, 0, 0] })),
      doubled = await cubeQuad(cubeDocument(colors, { intensity: 2 }));
    console.log(`cube: facing ${facing}, side ${side}, behind ${behind}, intensity 2 ${doubled}`);
    assert.ok(facing[0] > side[0] + 10 && side[0] >= behind[0], 'the bright face is in front, then beside, then behind');
    assert.ok(doubled[0] > facing[0] + 5, 'intensity scales it');
  },
  // Adobe Stock licence: stays out of the repository, read from MARGO_SPLAT_SAMPLES/ibl when it is there.
  async 'lights: the real EnvironmentTest (Adobe Dimension) lights its spheres'() {
    const folder = process.env.MARGO_SPLAT_SAMPLES;
    if (!folder || !existsSync(join(folder, 'ibl/EnvironmentTest.gltf'))) {
      console.log('EnvironmentTest absent: set MARGO_SPLAT_SAMPLES (tests/fixtures/lights/NOTICE.md)');
      return;
    }
    await page.route('**/ibl-sample/**', (route) =>
      route.fulfill({ body: readFileSync(join(folder, 'ibl', new URL(route.request().url()).pathname.split('/ibl-sample/')[1])) }),
    );
    const draw = async (light) => {
        await open();
        await page.evaluate(
          async ({ light }) => {
            const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
              { applyGLTFLightExtensions } = await import('/packages/gltf-pro/dist/lights.js'),
              { engine } = window.check,
              model = await loadGLTF(engine, '/ibl-sample/EnvironmentTest.gltf'),
              b = model.bounds;
            engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
            if (light) window.check.lights = await applyGLTFLightExtensions(model, { background: true });
          },
          { light },
        );
        const image = await pixels();
        await close();
        return image;
      },
      lit = await draw(true),
      plain = await draw(false);
    await page.unroute('**/ibl-sample/**');
    let changed = 0;
    for (let i = 0; i < lit.data.length; i += 4)
      if (Math.abs(lit.data[i] - plain.data[i]) + Math.abs(lit.data[i + 2] - plain.data[i + 2]) > 24) changed++;
    console.log(`EnvironmentTest: ${changed} of ${size * size} pixels change under its light`);
    assert.ok(changed > (size * size) / 4, 'the file light reaches the picture');
  },
  // The spec compares a dense medium to a plain diffuse surface of the multi-scatter colour, and a thin one has no medium.
  // Black diffuse transmission colour leaves the back lobe out, so only the scattered lobe differs between these.
  async 'scatter: dense is the diffuse surface of its colour, thin is none, between is the share of the formula'() {
    const color = [0.6, 0.3, 0.15],
      diffuse = {
        KHR_materials_diffuse_transmission: { diffuseTransmissionFactor: 1, diffuseTransmissionColorFactor: [0, 0, 0] },
      },
      medium = (attenuationDistance) => ({
        ...diffuse,
        KHR_materials_volume: { attenuationColor: [0.5, 0.5, 0.5], attenuationDistance, thicknessFactor: 1 },
        KHR_materials_volume_scatter: { multiscatterColorFactor: color },
      });
    // sigma_t x = ln 2 / d: exp(-69 rho_ss) leaves under 1e-3 of a level at distance 0.01; 1e-5 of a level at 1000.
    const dense = await scatterQuad(medium(0.01)),
      thin = await scatterQuad(medium(1000)),
      between = await scatterQuad(medium(1)),
      none = await scatterQuad(diffuse),
      solid = await scatterQuad({}, { base: color });
    for (let k = 0; k < 3; k++) {
      // One rounding of each picture.
      assert.ok(Math.abs(dense[k] - solid[k]) <= 2, `dense ${dense} against the diffuse surface ${solid}`);
      assert.ok(Math.abs(thin[k] - none[k]) <= 2, `thin ${thin} against none ${none}`);
    }
    assert.ok(solid[0] > none[0] + 40, `the lobe shows: ${solid} against ${none}`);
    // Light adds: the scene light between lies at the formula's share of the way, up to half a level in each of three
    // pictures, a level being what one more of it in every channel means in scene light there.
    const { scatterExtinction, scatterShares } = await import('../../shared/volume-scatter.js');
    const [low, high, seen, next] = [none, solid, between, between.map((v) => v + 1)].map(sceneLight);
    for (let k = 0; k < 3; k++) {
      const [w] = scatterShares(scatterExtinction(0.5, 1), color[k], 0, 1),
        expected = low[k] + w * (high[k] - low[k]);
      assert.ok(Math.abs(seen[k] - expected) <= 1.5 * Math.abs(next[k] - seen[k]), `channel ${k}: ${seen} against ${expected}`);
    }
  },
  // Milky glass through install: dense, nothing of the black page comes through and the lobe is all there is. IOR 1
  // takes the specular away, so only the lobe is left to light it, and a plain surface of that colour matches it.
  async 'scatter: install(model) lights the scattered share of transmission'() {
    const color = [0.6, 0.3, 0.15],
      ior = { KHR_materials_ior: { ior: 1 } },
      glass = (scatter) => ({
        ...ior,
        KHR_materials_transmission: { transmissionFactor: 1 },
        KHR_materials_volume: { attenuationColor: [0.5, 0.5, 0.5], attenuationDistance: 0.01, thicknessFactor: 1 },
        ...(scatter ? { KHR_materials_volume_scatter: { multiscatterColorFactor: color } } : {}),
      }),
      milky = await scatterQuad(glass(true), { installed: true }),
      clear = await scatterQuad(glass(false), { installed: true }),
      solid = await scatterQuad(ior, { base: color, installed: true });
    assert.ok(Math.max(...clear) <= 2, `dense clear glass is dark: ${clear}`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(milky[k] - solid[k]) <= 2, `${milky} against ${solid}`);
  },
  // Its material as the file states it, and with the extension taken out: the skull's lit pixels leave the colour of the
  // diffuse transmission's back lobe for the file's multi-scatter colour, which has more blue than red.
  async 'scatter: the real Khronos ScatteringSkull draws'() {
    const folder = process.env.MARGO_SPLAT_SAMPLES;
    if (!folder || !existsSync(join(folder, 'skull/ScatteringSkull.gltf'))) {
      console.log('ScatteringSkull absent: set MARGO_SPLAT_SAMPLES (tests/fixtures/scatter/NOTICE.md)');
      return;
    }
    const read = (name) => readFileSync(join(folder, 'skull', name)).toString('base64'),
      png = read('ScatteringSkull_images/aoThickness.png'),
      bin = read('ScatteringSkull_binary.bin'),
      json = JSON.parse(readFileSync(join(folder, 'skull/ScatteringSkull.gltf'), 'utf8')),
      draw = async (doc) => {
        await open();
        await page.evaluate(
          async ({ doc, bin, png }) => {
            const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
              { extendedMaterials } = await import('/packages/gltf-pro/dist/extended.js'),
              { engine } = window.check,
              bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
              image = await createImageBitmap(new Blob([bytes(png)], { type: 'image/png' }), {
                colorSpaceConversion: 'none',
                premultiplyAlpha: 'none',
              }),
              model = await parseGLTFAsync(engine, doc, [bytes(bin)], [image], { materials: extendedMaterials }),
              b = model.bounds;
            engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
          },
          { doc, bin, png },
        );
        const image = await pixels();
        await close();
        return image;
      },
      mean = (image) => {
        const sum = [0, 0, 0];
        let count = 0;
        for (let i = 0; i < image.data.length; i += 4)
          if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 24) {
            count++;
            for (let k = 0; k < 3; k++) sum[k] += image.data[i + k];
          }
        return { count, mean: sum.map((v) => v / count) };
      },
      without = structuredClone(json);
    delete without.materials[0].extensions.KHR_materials_volume_scatter;
    const scattered = mean(await draw(json)),
      plain = mean(await draw(without));
    console.log(`skull: ${scattered.count} pixels lit, mean ${scattered.mean.map((v) => v.toFixed(1))}; no scatter ${plain.mean.map((v) => v.toFixed(1))}`);
    assert.ok(scattered.count > 5000, 'the skull draws');
    // The file's colour is 0.17, 0.53, 0.59.
    assert.ok(scattered.mean[2] > scattered.mean[0] + 10, `blue over red: ${scattered.mean}`);
    assert.ok(plain.mean[2] < plain.mean[0] + 10, `not without the extension: ${plain.mean}`);
  },
  // The parse worker and the progressive stream each carry the second vertex buffer's array across a worker.
  async 'uv: the worker and progressive loaders keep later sets'() {
    const url = '/packages/gltf-pro/tests/fixtures/uv/FourUV.glb',
      plain = await drawGLB(readFileSync('packages/gltf-pro/tests/fixtures/uv/FourUV.glb')),
      through = async (load) => {
        await open();
        await page.evaluate(
          async ({ load, url }) => {
            const { engine } = window.check;
            if (load === 'worker') {
              const { loadGLTFInWorker } = await import('/packages/gltf-pro/dist/worker.js');
              await loadGLTFInWorker(engine, url);
            } else {
              const { loadGLTFProgressive } = await import('/packages/gltf-pro/dist/progressive.js');
              await loadGLTFProgressive(engine, url).complete;
            }
            engine.camera.position = [0, 0, 4];
            engine.camera.target = [0, 0, 0];
          },
          { load, url },
        );
        const image = await pixels();
        await close();
        return image;
      };
    assert.equal(difference(await through('worker'), plain), 0, 'parse worker');
    assert.equal(difference(await through('progressive'), plain), 0, 'progressive stream');
  },
  // Blender's quad: base colour on its third UV map (mirrored left to right), emission on its fourth (mirrored top to
  // bottom). Set 0 and 1 are plain, so a shader that fell back to them shows red on the left and glow on top.
  async 'uv: Blender file with four UV sets draws each map on its own set'() {
    const file = fourUV();
    assert.equal(file.json.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord, 2);
    assert.equal(file.json.materials[0].emissiveTexture.texCoord, 3);
    const shot = await drawGLB(readFileSync('packages/gltf-pro/tests/fixtures/uv/FourUV.glb')),
      left = 100,
      right = 156,
      top = 100,
      bottom = 156,
      topLeft = shot.at(left, top),
      topRight = shot.at(right, top),
      bottomLeft = shot.at(left, bottom);
    assert.ok(topLeft[2] > topLeft[0] + 40, `blue on the left: ${topLeft}`);
    assert.ok(topRight[0] > topRight[2] + 40, `red on the right: ${topRight}`);
    assert.ok(bottomLeft[1] > topLeft[1] + 80, `glow along the bottom: ${bottomLeft} against ${topLeft}`);
    // The same maps on sets 0 and 1 give the same picture, bit for bit: nothing but the set's place changed.
    const moved = firstTwoSets(file),
      same = await drawGLB(glb(moved.json, moved.bin));
    assert.equal(difference(shot, same), 0);
  },
  // The second vertex buffer sits past the instance buffer, and each instance's copy still reads its own later sets.
  async 'uv: later sets under EXT_mesh_gpu_instancing and the physical shader'() {
    const file = fourUV(),
      physical = (doc) => {
        const m = doc.json.materials[0];
        m.extensions = { KHR_materials_clearcoat: { clearcoatFactor: 0.5 } };
        doc.json.extensionsUsed = ['KHR_materials_clearcoat'];
        return doc;
      },
      instanced = ({ json, bin }) => {
        const edited = structuredClone(json),
          row = Buffer.from(new Float32Array([0, 0, 0]).buffer);
        edited.buffers[0].byteLength = Math.ceil(bin.length / 4) * 4 + row.length;
        edited.bufferViews.push({ buffer: 0, byteOffset: Math.ceil(bin.length / 4) * 4, byteLength: row.length });
        edited.accessors.push({ bufferView: edited.bufferViews.length - 1, componentType: 5126, count: 1, type: 'VEC3' });
        edited.nodes[0].extensions = {
          EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: edited.accessors.length - 1 } },
        };
        edited.extensionsUsed = [...(edited.extensionsUsed ?? []), 'EXT_mesh_gpu_instancing'];
        return { json: edited, bin: Buffer.concat([Buffer.alloc(Math.ceil(bin.length / 4) * 4, 0).fill(bin, 0, bin.length), row]) };
      };
    const draw = (doc, instances) => drawGLB(glb(doc.json, doc.bin), instances);
    assert.equal(difference(await draw(instanced(file), true), await draw(file)), 0, 'one instance at the origin');
    const lobes = physical({ json: structuredClone(file.json), bin: file.bin }),
      moved = firstTwoSets(physical({ json: structuredClone(file.json), bin: file.bin }));
    assert.equal(difference(await draw(lobes), await draw(moved)), 0, 'the physical shader reads later sets alike');
  },
  // The file's own triangle under its own height map, against the same file with the extension removed: its 2 x 2 map is
  // not flat, so the normal, and the light, must change wherever the map's gradient is not zero.
  async 'bump: the luma.gl EXT_materials_bump file shades through the default loader'() {
    const shot = async (strip) => {
      await open();
      await page.evaluate(async (strip) => {
        const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
          { engine } = window.check,
          doc = await (await fetch('/packages/gltf-pro/tests/fixtures/bump/BumpMaterial.gltf')).json();
        if (strip) {
          delete doc.materials[0].extensions;
          delete doc.extensionsRequired;
        }
        const model = await parseGLTFAsync(engine, doc, {}),
          b = model.bounds;
        window.check.bumped = !!model.primitives[0].material.extended?.bump;
        engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
      }, strip);
      const image = await pixels(),
        bumped = await page.evaluate(() => window.check.bumped);
      await close();
      return { image, bumped };
    };
    const on = await shot(false),
      off = await shot(true);
    assert.equal(on.bumped, true, 'the default loader picks the extended decoder');
    assert.equal(off.bumped, false);
    assert.ok(lit(on.image) > 1000, 'the triangle draws');
    let changed = 0;
    for (let i = 0; i < on.image.data.length; i += 4) if (on.image.data[i] !== off.image.data[i]) changed++;
    assert.ok(changed > 1000, `the bump changes the light on ${changed} pixels`);
  },
  // A ramp over a flat quad must shade as a flat quad whose vertex normals are the spec's n_b = normalize(n - grad d). The
  // bound: 8-bit texels with an 8-bit filter fraction leave the per-pixel height step within 1%, under 1 output code on this
  // surface, and each 8-bit picture rounds by half a code, so 3 codes covers it; the unbumped light differs by far more.
  async 'bump: a height ramp shades as the tilted normal the spec gives'() {
    const slope = 256 / 255 / 2,
      bumped = await bumpQuad({ ramp: true, bump: { heightSpace: 'world' } }),
      tilted = await bumpQuad({ ramp: false, normal: unit(-slope, 0, 1) }),
      flat = await bumpQuad({ ramp: false });
    assert.ok(difference(tilted, flat) > 12, `the tilt shows: ${difference(tilted, flat)}`);
    assert.ok(difference(bumped, tilted) <= 3, `bump against tilted normal: ${difference(bumped, tilted)}`);
    // Seen from behind the height still stands on the front, so the back face is the front's normal turned round.
    const back = await bumpQuad({ ramp: true, bump: { heightSpace: 'world' }, back: true }),
      backTilted = await bumpQuad({ ramp: false, normal: unit(-slope, 0, 1), back: true });
    assert.ok(difference(back, backTilted) <= 3, `the back face: ${difference(back, backTilted)}`);
    assert.ok(difference(back, bumped) > 12, 'the camera did go round');
  },
  // Scale 2 doubles the world width: a world height keeps its size, so its slope halves; a node-space height doubles with
  // the width, so its slope stays. Scale 3 along z alone stretches only the height: 3 x the slope, normal (-3s, 0, 1) in the
  // world, which is M^T n_w = (-3s, 0, 3) as a vertex normal.
  async 'bump: heightSpace object follows the node scale, world does not'() {
    const slope = 256 / 255 / 2,
      scale = [2, 2, 2],
      object = await bumpQuad({ ramp: true, scale, bump: { heightSpace: 'object' } }),
      world = await bumpQuad({ ramp: true, scale, bump: { heightSpace: 'world' } }),
      objectTilt = await bumpQuad({ ramp: false, scale, normal: unit(-slope, 0, 1) }),
      worldTilt = await bumpQuad({ ramp: false, scale, normal: unit(-slope / 2, 0, 1) });
    assert.ok(difference(objectTilt, worldTilt) > 6, 'the two spaces differ');
    assert.ok(difference(object, objectTilt) <= 3, `object space: ${difference(object, objectTilt)}`);
    assert.ok(difference(world, worldTilt) <= 3, `world space: ${difference(world, worldTilt)}`);
    const tall = [1, 1, 3],
      stretched = await bumpQuad({ ramp: true, scale: tall, bump: { heightSpace: 'object' } }),
      stretchedTilt = await bumpQuad({ ramp: false, scale: tall, normal: unit(-3 * slope, 0, 3) });
    assert.ok(difference(stretched, stretchedTilt) <= 3, `uneven scale: ${difference(stretched, stretchedTilt)}`);
  },
  async 'splats: a real SPZ glTF from CesiumJS reaches the renderer through loadGLTF'() {
    await open();
    const result = await page.evaluate(async () => {
      const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { engine } = window.check,
        model = await loadGLTF(engine, '/packages/gltf-pro/tests/fixtures/splats/sh_unit_cube.glb');
      window.check.model = model;
      const b = model.bounds;
      engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
      return {
        clouds: model.splats.length,
        count: model.splats[0].cloud.count,
        drawn: model.primitives.length + model.pointsAndLines.length,
        bounds: [...b],
      };
    });
    assert.equal(result.clouds, 1);
    assert.equal(result.count, 27);
    assert.equal(result.drawn, 0, 'the splat primitive is not drawn as points too');
    // The payload's cube spans -50 to 50; the file's node matrix turns it and moves it to (50, -50, 50).
    result.bounds.forEach((v, i) => assert.ok(Math.abs(v - [0, -100, 0, 100, 0, 100][i]) < 1e-3, `bounds ${result.bounds}`));
    assert.ok(lit(await pixels()) > 200, 'the splats draw');
    await page.evaluate(() => {
      window.check.model.dispose();
      if (window.check.model.splats[0].cloud.gpuState) throw new Error('a disposed cloud still has GPU state');
    }).catch((error) => assert.match(error.message, /disposed|attach/i));
    await close();
  },
  async 'splats: the real tower capture draws'() {
    const folder = process.env.MARGO_SPLAT_SAMPLES;
    if (!folder || !existsSync(join(folder, 'tower.glb'))) {
      console.log('tower.glb absent: set MARGO_SPLAT_SAMPLES (tests/fixtures/splats/NOTICE.md)');
      return;
    }
    await open();
    const bytes = readFileSync(join(folder, 'tower.glb')).toString('base64'),
      count = await page.evaluate(async (base64) => {
        const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
          { engine } = window.check,
          data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
          model = await parseGLTFAsync(engine, data, { maxDownloadBytes: 2 ** 26 }),
          b = model.bounds;
        engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
        return model.splats[0].cloud.count;
      }, bytes);
    assert.equal(count, 286868);
    const image = await pixels();
    console.log(`tower: ${lit(image)} of ${size * size} pixels lit`);
    // A thin mast about 150 px tall on a base about 60 px wide, fitted with its floaters into 256 px.
    assert.ok(lit(image) > 1500, 'the capture draws');
    await close();
  },
  async 'splats: a mesh and splats from one file share the depth buffer (stand-in file)'() {
    await open();
    const result = await page.evaluate(async () => {
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js'),
        { engine } = window.check,
        N = 'KHR_gaussian_splatting',
        // Two green splats, the left one in front of a red wall at z = 0 and the right one behind it.
        floats = new Float32Array([
          ...[-0.5, 0, 0.5, 0.5, 0, -0.5], // centres
          ...[0, 0, 0, 1, 0, 0, 0, 1], // rotations
          ...[0.1, 0.1, 0.1, 0.1, 0.1, 0.1], // scales
          ...[1, 1], // opacities
          ...[-1.7, 1.7, -1.7, -1.7, 1.7, -1.7], // SH 0: green
          ...[-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], // wall positions
          ...[0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], // wall normals
        ]),
        wall = new Uint16Array([0, 1, 2, 0, 2, 3]),
        bytes = new Uint8Array(floats.byteLength + wall.byteLength);
      bytes.set(new Uint8Array(floats.buffer));
      bytes.set(new Uint8Array(wall.buffer), floats.byteLength);
      const view = (offset, length) => ({ buffer: 0, byteOffset: offset * 4, byteLength: length * 4 }),
        accessor = (bufferView, count, type) => ({ bufferView, componentType: 5126, count, type });
      const doc = {
        asset: { version: '2.0' },
        extensionsUsed: [N, 'KHR_materials_unlit'],
        buffers: [{ byteLength: bytes.length }],
        bufferViews: [
          view(0, 6),
          view(6, 8),
          view(14, 6),
          view(20, 2),
          view(22, 6),
          view(28, 12),
          view(40, 12),
          { buffer: 0, byteOffset: floats.byteLength, byteLength: wall.byteLength },
        ],
        accessors: [
          { ...accessor(0, 2, 'VEC3'), min: [-0.5, 0, -0.5], max: [0.5, 0, 0.5] },
          accessor(1, 2, 'VEC4'),
          accessor(2, 2, 'VEC3'),
          accessor(3, 2, 'SCALAR'),
          accessor(4, 2, 'VEC3'),
          { ...accessor(5, 4, 'VEC3'), min: [-1, -1, 0], max: [1, 1, 0] },
          accessor(6, 4, 'VEC3'),
          { bufferView: 7, componentType: 5123, count: 6, type: 'SCALAR' },
        ],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] }, extensions: { KHR_materials_unlit: {} } }],
        meshes: [
          {
            primitives: [
              { attributes: { POSITION: 5, NORMAL: 6 }, indices: 7, material: 0 },
              {
                mode: 0,
                attributes: {
                  POSITION: 0,
                  [N + ':ROTATION']: 1,
                  [N + ':SCALE']: 2,
                  [N + ':OPACITY']: 3,
                  [N + ':SH_DEGREE_0_COEF_0']: 4,
                },
                extensions: { [N]: { kernel: 'ellipse', colorSpace: 'srgb_rec709_display' } },
              },
            ],
          },
        ],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
      };
      const model = await parseGLTFAsync(engine, doc, { buffers: [bytes] });
      return { primitives: model.primitives.length, clouds: model.splats.length };
    });
    assert.deepEqual(result, { primitives: 1, clouds: 1 });
    const image = await pixels(),
      // Camera at z = 3 with the default field of view: find each splat's side by the most green on its half.
      half = (from) => {
        let green = 0;
        for (let y = 0; y < size; y++)
          for (let x = from; x < from + size / 2; x++) {
            const [r, g] = image.at(x, y);
            if (g > r + 40) green++;
          }
        return green;
      };
    assert.ok(half(0) > 50, `the splat in front of the wall shows: ${half(0)}`);
    assert.equal(half(size / 2), 0, 'the splat behind the wall is hidden');
    await close();
  },
  async 'splats: decoders.splats false draws the point fallback, and the worker loader reads splats'() {
    await open();
    const result = await page.evaluate(async () => {
      const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { loadGLTFInWorker } = await import('/packages/gltf-pro/dist/worker.js'),
        { engine } = window.check,
        fixtures = '/packages/gltf-pro/tests/fixtures/splats/',
        points = await loadGLTF(engine, fixtures + 'minimal_point.gltf', { decoders: { splats: false } }),
        worker = await loadGLTFInWorker(engine, new URL(fixtures + 'sh_unit_cube.glb', location.href));
      return {
        points: points.pointsAndLines.length,
        fallbackClouds: points.splats.length,
        workerClouds: worker.splats.length,
        workerCount: worker.splats[0].cloud.count,
      };
    });
    assert.deepEqual(result, { points: 1, fallbackClouds: 0, workerClouds: 1, workerCount: 27 });
    await close();
  },
};

try {
  assert.equal(hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const only = process.argv[2];
  for (const [name, check] of Object.entries(checks)) {
    if (only && !name.includes(only)) continue;
    await check();
    console.log('ok -', name);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
