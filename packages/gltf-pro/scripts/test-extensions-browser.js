// Real-GPU checks of gltf-pro's file extensions, each through the real loaders on a physical adapter. Run from the
// repository root after `npm run build:packages`: `npm run test:extensions:browser --workspace packages/gltf-pro`.
// MARGO_SPLAT_SAMPLES names a folder holding the large tower.glb capture (tests/fixtures/splats/NOTICE.md).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

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

const checks = {
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
