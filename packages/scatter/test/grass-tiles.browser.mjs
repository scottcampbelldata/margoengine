// Generated grass clumps and packed records are stand-ins; execute on a real GPU.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Engine } = await import('/packages/core/dist/extension.js');
    const { webglRenderer } = await import('/packages/webgl/dist/index.js');
    const { ScatterTiles } = await import('/packages/scatter/dist/tiles.js');
    const { generateGrassMesh } = await import('/packages/procedural/dist/index.js');
    const { toGeometry } = await import('/packages/geometry/dist/index.js');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const geometries = [7, 3, 1].map(n => toGeometry(generateGrassMesh(n)));
    const fallback = await Engine.create(canvas, { backend: 'webgl2', fallback: webglRenderer });
    let refused = false;
    try { ScatterTiles.attach(fallback, geometries, { bounds: [-32, -32, 32, 32] }); }
    catch (e) { refused = e.code === 'unsupported' && /https:/.test(e.message); }
    fallback.dispose();
    check(refused, 'native WebGL2 refusal with help link');
    const webgpuCanvas = document.createElement('canvas');
    webgpuCanvas.width = webgpuCanvas.height = 128;
    const engine = await EngineKernel.create(webgpuCanvas, { backend: 'webgpu' });
    const errors = [], modules = [];
    const instrument = () => {
      const d = engine.gpu, create = d.createBuffer.bind(d), shader = d.createShaderModule.bind(d);
      d.addEventListener('uncapturederror', e => errors.push(e.error.message));
      d.createBuffer = desc => create({ ...desc, usage: desc.usage | (desc.usage & GPUBufferUsage.STORAGE ? GPUBufferUsage.COPY_SRC : 0) });
      d.createShaderModule = desc => { const m = shader(desc); modules.push(m); return m; };
    };
    instrument();
    engine.use({ name: 'grass-tile-test', setup() {}, onDeviceRestored: instrument });
    const tiles = ScatterTiles.attach(engine, geometries, { bounds: [-32, -32, 32, 32], lod: [8, 16, 32], lodFade: 0, blades: {}, wind: [0.1, 0, 0.1] });
    // Deliberately unaligned byte subarray, at the tile origin, scale 1.
    const data = Uint8Array.from([99, 0, 0, 0, 0, 0, 128, 0, 0]).subarray(1);
    tiles.setTile('a', [0, 0], 16, data);
    const frame = async () => { engine.render({ delta: 0, culling: false }); await engine.gpu.queue.onSubmittedWorkDone(); };
    const counts = async () => {
      const d = engine.gpu, target = d.createBuffer({ size: 60, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(tiles.commands, 0, target, 0, 60);
      d.queue.submit([encoder.finish()]);
      await target.mapAsync(GPUMapMode.READ);
      const values = new Uint32Array(target.getMappedRange().slice(0));
      target.unmap(); target.destroy();
      return [values[1], values[6], values[11]];
    };
    const rounds = [];
    for (const distance of [3, 12, 24]) {
      engine.camera.position = [0, 1, -distance]; engine.camera.target = [0, 0, 0];
      await frame(); rounds.push(await counts());
    }
    tiles.setTile('b', [1, 0], 16, data);
    await frame(); const added = await counts();
    tiles.removeTile('a'); await frame(); const removed = await counts();
    await engine.rebootDevice(); await frame(); const restored = await counts();
    tiles.removeTile('b'); await frame(); const empty = await counts();
    for (const module of modules) check(!(await module.getCompilationInfo()).messages.some(m => m.type === 'error'), 'grass tile shader compilation');
    tiles.dispose(); tiles.dispose(); engine.dispose();
    return { rounds, added, removed, restored, empty, refused, errors, shaders: modules.length };
  });
  assert.deepEqual(result.rounds, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.deepEqual(result.added, [0, 0, 2]);
  assert.deepEqual(result.removed, [0, 0, 1]);
  assert.deepEqual(result.restored, [0, 0, 1]);
  assert.deepEqual(result.empty, [0, 0, 0]);
  assert.deepEqual(result.errors, []);
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }));
} finally { await browser.close(); }
