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
    const { webglRenderer } = await import('/packages/webgl2-compat/dist/preview.js');
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
    const counts = async (effect = tiles) => {
      const d = engine.gpu, target = d.createBuffer({ size: 60, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(effect.commands, 0, target, 0, 60);
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
    tiles.dispose(); tiles.dispose();
    // Fresh buffers start at capacity one: reusing an already grown ring would hide underallocation.
    const { box } = await import('/packages/core/dist/index.js');
    const records = new Uint8Array(64 * 8);
    for (let i = 0; i < 64; i++) records[i * 8 + 5] = 128;
    const budgets = [];
    for (const test of [
      { name: 'far endpoint', origin: [0, 0], eye: [0, 0, -4], expected: [0, 0, 64] },
      { name: 'f32 origin', origin: [16777217, 0], eye: [16777216, 0, 0], expected: [64, 0, 0] },
      { name: 'f32 origin control', origin: [16777216, 0], eye: [16777216, 0, 0], expected: [64, 0, 0] },
      { name: 'f32 camera', origin: [16777216, 0], side: 0.125, eye: [16777217, 0, 0], expected: [64, 0, 0] },
      { name: 'rounded upper edge', origin: [16777216, 0], side: 1.1, packed: 65535, eye: [16777218, 0, 0], expected: [64, 0, 0] },
      { name: 'rounded distance', origin: [0, 0], eye: [-3.000000238418579, 0, -Math.fround(Math.sqrt(7))], reference: true, expected: [0, 0, 64] },
      { name: 'near hard endpoint', origin: [0, 0], eye: [0, 0, -0.5], expected: [0, 64, 0] },
      { name: 'middle hard endpoint', origin: [0, 0], eye: [0, 0, -2], expected: [0, 0, 64] },
      { name: 'near fade', origin: [0, 0], eye: [0, 0, -0.625], fade: 0.5, expected: [64, 64, 0] },
      { name: 'middle fade', origin: [0, 0], eye: [0, 0, -2.125], fade: 0.5, expected: [0, 64, 64] },
      { name: 'outside far', origin: [0, 0], eye: [0, 0, -4.01], expected: [0, 0, 0] },
      { name: 'explicit cap', origin: [0, 0], eye: [0, 0, -4], drawn: 32, expected: [0, 0, 32] },
    ]) {
      engine.camera.position = test.eye;
      engine.camera.target = test.eye[0] === test.origin[0] && test.eye[2] === test.origin[1]
        ? [test.eye[0], test.eye[1], test.eye[2] + 1] : [test.origin[0], 0, test.origin[1]];
      // The f32-camera probe's root can differ from the f64 frustum eye; its mesh covers that difference.
      const size = test.name === 'f32 camera' ? 10 : 0.01;
      const effect = ScatterTiles.attach(engine, [box(size), box(size * 2), box(size * 3)], {
        bounds: test.origin[0] > 1000000 ? [16777200, -32, 16777232, 32] : [-32, -32, 32, 32],
        lod: [0.5, 2, 4], lodFade: test.fade ?? 0, drawn: test.drawn,
      });
      const packed = records.slice();
      for (let i = 0; i < 64; i++) { packed[i * 8] = (test.packed ?? 0) & 255; packed[i * 8 + 1] = (test.packed ?? 0) >> 8; }
      effect.setTile('boundary', test.origin, test.side ?? 1, packed);
      await frame();
      const actual = await counts(effect), capacities = effect.instances.map(b => b.size / 32);
      check(capacities.every((n, i) => n >= actual[i]), `${test.name}: ring capacity`);
      let expected = test.expected;
      if (test.reference) {
        // WGSL distance has an implementation-dependent error allowance. Compare the fresh ring with this same
        // GPU's decision after preallocating ample space, so an allowed upward rounding is not a false failure.
        effect.setTile('warm', [Math.fround(test.eye[0]), Math.fround(test.eye[2])], 1, records);
        await frame(); effect.removeTile('warm'); await frame();
        expected = await counts(effect);
        check(expected[0] === 0 && expected[1] === 0 && [0, 64].includes(expected[2]), 'untruncated distance control');
      }
      budgets.push({ name: test.name, counts: actual, expected, capacities });
      effect.dispose();
    }
    for (const module of modules) check(!(await module.getCompilationInfo()).messages.some(m => m.type === 'error'), 'tile boundary shader compilation');
    engine.dispose();
    return { rounds, added, removed, restored, empty, refused, errors, shaders: modules.length, budgets };
  });
  assert.deepEqual(result.rounds, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.deepEqual(result.added, [0, 0, 2]);
  assert.deepEqual(result.removed, [0, 0, 1]);
  assert.deepEqual(result.restored, [0, 0, 1]);
  assert.deepEqual(result.empty, [0, 0, 0]);
  assert.deepEqual(result.errors, []);
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }));
  assert.deepEqual(result.budgets.map(b => [b.name, b.counts]), result.budgets.map(b => [b.name, b.expected]));
} finally { await browser.close(); }
