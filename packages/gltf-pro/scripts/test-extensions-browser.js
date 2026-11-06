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

const checks = {
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
