// The real-GPU check of the @margoengine/gltf entries that draw. Fake devices cannot show that a texture reads as sRGB,
// that a cut-out shows what is behind it, or that the claimed batch tracks core's instances. It takes the GPU lock itself:
//   npm run test:gpu --workspace @margoengine/gltf
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const release = await acquire({ owner: 'gltf-browser' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/browser/stats-native-passes.html', port: 5367 });
  const { page, hardware } = browser,
    errors = [];
  assert.equal(hardware.webgpu?.fallback, false);
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  const proof = await page.evaluate(async () => {
    const { EngineKernel, box } = await import('/packages/core/dist/index.js');
    const { engineRuntime, PbrMaterial, Camera } = await import('/packages/core/dist/extension.js');
    const { parseGLTFAsync } = await import('/packages/gltf/dist/index.js');
    const { textured } = await import('/packages/gltf/dist/textured.js');
    const { instancing } = await import('/packages/gltf/dist/instancing.js');
    const { loadAuto } = await import('/packages/gltf/dist/auto.js');
    const ensure = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const size = 64,
      canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${size}px;height:${size}px`;
    canvas.width = canvas.height = size;
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        exactSize: [size, size],
        camera: { position: [0, 0, 3], target: [0, 0, 0], near: 0.1, far: 100 },
      }),
      engine = engineRuntime(instance),
      gpuErrors = [];
    engine.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const copy = document.createElement('canvas');
    copy.width = copy.height = size;
    const context = copy.getContext('2d', { willReadFrequently: true });
    // [x, y] in pixels of the rendered frame, read in the task that drew it.
    const pixels = (...points) => {
      engine.render();
      context.drawImage(canvas, 0, 0);
      return points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]);
    };
    const near = (a, b, tolerance = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

    // Left half opaque #8040c0, right half fully transparent.
    const paint = new OffscreenCanvas(8, 8),
      brush = paint.getContext('2d');
    brush.fillStyle = '#8040c0';
    brush.fillRect(0, 0, 4, 8);
    const png = new Uint8Array(await (await paint.convertToBlob({ type: 'image/png' })).arrayBuffer());

    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
      indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const parts = [positions, normals, uvs, indices, png],
      length = parts.reduce((sum, part) => sum + ((part.byteLength + 3) & ~3), 0),
      bytes = new Uint8Array(length),
      bufferViews = [];
    let offset = 0;
    for (const part of parts) {
      bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: part.byteLength });
      offset += (part.byteLength + 3) & ~3;
    }
    const file = (material, attributes = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, nodes = [{ mesh: 0 }]) => ({
      asset: { version: '2.0' },
      buffers: [{ byteLength: length }],
      bufferViews,
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
        { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
      ],
      images: [{ bufferView: 4, mimeType: 'image/png' }],
      samplers: [{ magFilter: 9728, minFilter: 9728 }],
      textures: [{ source: 0, sampler: 0 }],
      materials: [material],
      meshes: [{ primitives: [{ attributes, indices: 3, material: 0 }] }],
      nodes,
    });
    const pbr = (rest = {}) => ({ metallicFactor: 0, roughnessFactor: 1, ...rest }),
      map = { index: 0 },
      load = (doc) => parseGLTFAsync(instance, doc, [bytes], { extensions: [textured] }),
      left = [16, 32],
      right = [48, 32],
      result = {};

    // The reference: the same quad in core's constant colour.
    const flat = await load(file({ pbrMetallicRoughness: pbr({ baseColorFactor: [0.2158, 0.0513, 0.5271, 1] }) }));
    const [expected] = pixels(left);
    flat.dispose();

    // A texel reads through sRGB to the same linear colour core's material holds, and an unmasked map draws its right
    // half as what the file stored.
    const opaque = await load(file({ pbrMetallicRoughness: pbr({ baseColorTexture: map }) }));
    const [lit] = pixels(left);
    ensure(near(lit, expected), `Texel ${lit} matches core's colour ${expected}`);
    result.texel = { lit, expected };
    opaque.dispose();

    // Behind the cut-out, a core box in its own colour; the depth of the discarded half stays the box's.
    const back = engine.createMesh().setGeometry(box(3, 3, 0.1));
    back.setMaterial(new PbrMaterial({ color: '#20c040', roughness: 1, doubleSided: false }));
    back.setPosition([0, 0, -1]);
    const [boxOnly] = pixels(right);
    const masked = await load(file({ alphaMode: 'MASK', pbrMetallicRoughness: pbr({ baseColorTexture: map }) }));
    const [solid, hole] = pixels(left, right);
    ensure(near(solid, expected), `MASK keeps ${solid}, expected ${expected}`);
    ensure(near(hole, boxOnly, 0), `The cut-out shows the box: ${hole} vs ${boxOnly}`);
    result.mask = { solid, hole };

    // baseColorFactor multiplies, and its alpha takes part in the test.
    masked.dispose();
    const tinted = await load(
      file({
        alphaMode: 'MASK',
        alphaCutoff: 0.6,
        pbrMetallicRoughness: pbr({ baseColorTexture: map, baseColorFactor: [0, 1, 1, 0.5] }),
      }),
    );
    ensure(near(pixels(left)[0], boxOnly, 0), 'alpha 0.5 under cutoff 0.6 cuts the whole quad');
    tinted.dispose();
    const halved = await load(
      file({ pbrMetallicRoughness: pbr({ baseColorTexture: map, baseColorFactor: [0, 1, 1, 1] }) }),
    );
    const [red] = pixels(left);
    ensure(red[0] < 8 && red[2] > lit[2] - 3, `The factor multiplies the map: ${red}`);
    halved.dispose();

    // Generated normals expand the vertices; the UVs follow.
    const expanded = await load(
      file({ alphaMode: 'MASK', pbrMetallicRoughness: pbr({ baseColorTexture: map }) }, { POSITION: 0, TEXCOORD_0: 2 }),
    );
    const [faceLeft, faceRight] = pixels(left, right);
    ensure(near(faceRight, boxOnly, 0) && !near(faceLeft, boxOnly, 4), 'UVs follow generated normals');
    expanded.dispose();

    // Two nodes on one mesh are one claimed batch of two, and moving one sends only what moved.
    const pair = await load(
      file({ alphaMode: 'MASK', pbrMetallicRoughness: pbr({ baseColorTexture: map }) }, undefined, [
        { mesh: 0, translation: [-1, 0, 0] },
        { mesh: 0, translation: [1, 0, 0] },
      ]),
    );
    pixels(left); // The claim lands during the first frame, after core counted its draws.
    const row = Array.from({ length: size }, (_, x) => [x, 32]),
      first = pixels(...row).findIndex((pixel) => near(pixel, expected));
    ensure(first >= 0 && first < left[0], `The left instance draws left of the quad's place: ${first}`);
    ensure(engine.stats.drawCalls === 1, `Only the box is core's draw: ${engine.stats.drawCalls}`);
    pair.nodes[0].setPosition([-1, 5, 0]);
    pair.nodes[1].setPosition([0, 0, 0]);
    const [moved, emptied] = pixels(left, [first, 32]);
    ensure(near(moved, expected), `The moved instance draws there: ${moved}`);
    ensure(!near(emptied, expected, 8), `Nothing stays where it was: ${emptied}`);

    // Core still picks the mesh.
    const hit = await engine.pick(left[0], left[1]);
    ensure(pair.meshes.includes(hit), 'A claimed batch picks');
    pair.dispose();
    ensure(!engine.plugins.has('gltf-textured'), 'The plugin leaves with its last part');
    ensure(near(pixels(left)[0], boxOnly, 0), 'A disposed model draws nothing');

    // EXT_mesh_gpu_instancing: placements of one mesh are one core draw, each at its own place, the node's scale over them.
    const offsets = new Float32Array([-1.5, 0, 0, 1.5, 0, 0, 0, 9, 0]),
      forest = file({ pbrMetallicRoughness: pbr({ baseColorFactor: [0.2158, 0.0513, 0.5271, 1] }) }, undefined, [
        { mesh: 0, scale: [0.5, 0.5, 0.5], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 4 } } } },
      ]);
    forest.extensionsRequired = ['EXT_mesh_gpu_instancing'];
    forest.buffers = [...forest.buffers, { byteLength: offsets.byteLength }];
    forest.bufferViews = [...bufferViews, { buffer: 1, byteLength: offsets.byteLength }];
    forest.accessors.push({ bufferView: 5, componentType: 5126, count: 3, type: 'VEC3' });
    const grove = await parseGLTFAsync(instance, forest, [bytes, offsets], { extensions: [instancing] });
    const [west, middle, east] = pixels(left, [32, 32], right);
    ensure(near(west, expected) && near(east, expected), `Instances draw at their places: ${west} and ${east}`);
    ensure(near(middle, boxOnly, 0), `Nothing draws between them: ${middle}`);
    ensure(engine.stats.drawCalls === 2, `The box and one instanced draw: ${engine.stats.drawCalls}`);
    result.instancing = { west, east, drawCalls: engine.stats.drawCalls };
    grove.dispose();

    // loadAuto: a masked map stays light; emission needs gltf-pro, whose real loader draws the file from the same bytes.
    const serve = (doc) => {
      const asked = [],
        embedded = { ...doc, buffers: [{ byteLength: length, uri: 'quad.bin' }] };
      return {
        asked,
        fetch: async (url) => {
          asked.push(String(url));
          return new Response(String(url).endsWith('.bin') ? bytes : JSON.stringify(embedded));
        },
      };
    };
    const url = `${location.origin}/virtual/quad.gltf`,
      lightFile = serve(file({ alphaMode: 'MASK', pbrMetallicRoughness: pbr({ baseColorTexture: map }) })),
      light = await loadAuto(instance, url, lightFile);
    ensure(light.loader === 'gltf', `A masked map stays light: ${light.loader}`);
    ensure(near(pixels(left)[0], expected), 'The light result draws');
    light.model.dispose();
    const proFile = serve(file({ emissiveFactor: [0, 1, 0], pbrMetallicRoughness: pbr({ baseColorFactor: [0, 0, 0, 1] }) })),
      pro = await loadAuto(instance, url, proFile);
    ensure(pro.loader === 'gltf-pro', `Emission moves to gltf-pro: ${pro.loader}`);
    ensure(proFile.asked.length === 2, `Each URL once: ${proFile.asked}`);
    const [glow] = pixels(left);
    ensure(glow[1] > 200 && glow[0] < 60 && glow[2] < 60, `gltf-pro draws the file: ${glow}`);
    result.auto = { light: light.loader, pro: pro.loader, reason: pro.reason, glow };
    pro.model.dispose();

    // Two views: each camera sees the quad from its own side of the frame.
    const views = await load(file({ alphaMode: 'MASK', pbrMetallicRoughness: pbr({ baseColorTexture: map }) }));
    const camera = new Camera({ position: [0, 0, 3], target: [0, 0, 0], near: 0.1, far: 100 });
    engine.render({
      views: [
        { camera, viewport: [0, 0, 0.5, 1] },
        { camera, viewport: [0.5, 0, 0.5, 1] },
      ],
    });
    context.drawImage(canvas, 0, 0);
    const a = [...context.getImageData(14, 32, 1, 1).data.slice(0, 3)],
      b = [...context.getImageData(46, 32, 1, 1).data.slice(0, 3)];
    ensure(near(a, b, 2) && !near(a, boxOnly, 4), `Both views draw it: ${a} and ${b}`);
    // A lost device: the textures, UVs and pipelines come back from what the plugin kept.
    const previous = engine.gpu;
    previous.destroy();
    await previous.lost;
    await engine.rebootDevice();
    ensure(engine.gpu !== previous, 'The device came back');
    engine.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const [restored, restoredHole] = pixels(left, right);
    ensure(near(restored, expected), `Restored texel: ${restored}`);
    ensure(near(restoredHole, boxOnly, 0), `Restored cut-out: ${restoredHole}`);
    views.dispose();
    await engine.gpu.queue.onSubmittedWorkDone();
    // fixed-wait: uncapturederror events have no completion signal to await after the queue drains
    await new Promise((resolve) => setTimeout(resolve, 50));
    result.errors = gpuErrors;
    instance.dispose();
    canvas.remove();
    return result;
  });
  assert.deepEqual(proof.errors, []);
  assert.deepEqual(errors, []);
  console.log('gltf browser', JSON.stringify(proof));
} finally {
  await browser?.close();
  await release();
}
