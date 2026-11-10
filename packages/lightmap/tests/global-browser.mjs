// Draw the global baker's back-face visibility regression on either rendering backend.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { bakeGlobalLightmap } from '../dist/global.js';

const floor = [-0.25, 0, -0.25, -0.25, 0, 0.25, 0.25, 0, 0.25, 0.25, 0, -0.25],
  cover = [-4, 1, -4, -4, 1, 4, 4, 1, 4, 4, 1, -4],
  options = {
    radiometry: 'physical', texelsPerUnit: 2, padding: 1, aoRays: 1,
    bounceMode: 'path', bounces: 2, bounceRays: 32,
    areaLights: [{ position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1 }],
    areaSamples: 16, seed: 1,
  },
  clear = await bakeGlobalLightmap({ positions: new Float32Array(floor) }, options),
  blocked = await bakeGlobalLightmap({
    positions: new Float32Array([...floor, ...cover]), emission: new Float32Array([0, 0, 0, 10, 10, 10]),
  }, options),
  record = (b) => ({ width: b.width, height: b.height, lightmap: Array.from(b.textures.lightmap),
    lightmapScale: b.lightmapScale, radiometry: b.radiometry, uv: Array.from(b.uv.slice(0, 8)) }),
  browser = await openBrowser({ port: 'free', startPath: '/tests/modern-extension.html' }),
  errors = [];
browser.page.on('pageerror', e => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async ({ floor, clear, blocked }) => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { PbrMaterial, createMesh } = await import('/packages/materials/dist/index.js');
    const { applyLightmap } = await import('/packages/lightmap/dist/apply.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    canvas.style.cssText = 'width:64px;height:64px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 1, 0.001], target: [0, 0, 0] } });
    engine.stop(); engine.camera.up = [0, 0, -1];
    engine.lighting.direction[3] = 0;
    engine.lighting.ambient = [0, 0, 0];
    engine.lighting.radiance.set([0, 0, 0, 0]);
    engine.gpu.pushErrorScope('validation');
    const images = [];
    try {
      for (const bake of [clear, blocked]) {
        const mesh = createMesh(engine, { positions: new Float32Array(floor),
          normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs1: new Float32Array(bake.uv), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
        new PbrMaterial({ color: [1, 1, 1], roughness: 1, metalness: 0 }));
        const applied = applyLightmap(mesh, { ...bake, lightmap: new Uint8Array(bake.lightmap) });
        try {
          await waitForPipelines(async () => { engine.render({ culling: false }); await engine.gpu.queue.onSubmittedWorkDone(); });
          engine.render({ culling: false }); images.push(canvas.toDataURL());
        } finally { applied.dispose(); mesh.destroy(); }
      }
      return { images, validation: (await engine.gpu.popErrorScope())?.message ?? null, remaining: engine.meshes.size };
    } finally { engine.dispose(); canvas.remove(); }
  }, { floor, clear: record(clear), blocked: record(blocked) });
  const pixels = await Promise.all(result.images.map(async u => {
    const image = await decodePNG(Buffer.from(u.split(',')[1], 'base64'));
    return Array.from(image.data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 3));
  }));
  assert.ok(pixels[0].every(v => v > 10), `unblocked light reaches receiver: ${pixels[0]}`);
  assert.deepEqual(pixels[1], [0, 0, 0], 'opaque back face blocks direct light and emission');
  assert.equal(result.validation, null); assert.equal(result.remaining, 0); assert.deepEqual(errors, []);
  console.log('global lightmap back-face pixels', JSON.stringify(pixels));
} finally { await browser.close(); }
