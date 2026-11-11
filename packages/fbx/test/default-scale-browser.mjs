// The default-limit FBX mesh (996,004 vertices, test/default-scale.js) loads with default options and renders, on
// native WebGPU and (MARGO_COMPAT=1) the WebGL2 layer. Work counts are the assertions: one primitive, one geometry
// upload, a steady frame that creates no buffer and re-uploads no geometry, a fixed draw count. Load time and GPU frame
// time (timestamp-query, when the adapter has it) are printed as diagnostics; their targets live in
// docs/work-lists/speed-phase.md for the quiet run.
// node scripts/gpu-lock.mjs run --owner=<you> --max=10 -- node packages/fbx/test/default-scale-browser.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { defaultScaleMesh } from './default-scale.js';

const { bytes, corners } = defaultScaleMesh();
const browser = await openBrowser({ startPath: '/packages/fbx/test/textures.html', port: 'free' });
try {
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  const result = await browser.page.evaluate(async (base64) => {
    const [{ Engine }, { parseFBX }, { Stats }, { readPixels, createHeadlessCanvas }] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/fbx/dist/index.js'),
      import('/packages/stats/dist/index.js'),
      import('/packages/headless/dist/index.js'),
    ]);
    const input = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const engine = await Engine.create(createHeadlessCanvas({ width: 256, height: 256 }), {
      camera: { position: [0.5, 0.5, 1.6], target: [0.5, 0.5, 0], near: 0.01, far: 10 },
      features: ['timestamp-query'],
    });
    const device = engine.gpu,
      counts = { buffers: 0, bufferBytes: 0, writes: 0, writeBytes: 0 };
    const createBuffer = device.createBuffer.bind(device),
      writeBuffer = device.queue.writeBuffer.bind(device.queue);
    device.createBuffer = (descriptor) => {
      counts.buffers++;
      counts.bufferBytes += descriptor.size;
      return createBuffer(descriptor);
    };
    device.queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size) => {
      counts.writes++;
      const unit = data.BYTES_PER_ELEMENT ?? 1;
      counts.writeBytes += size !== undefined ? size * unit : data.byteLength - dataOffset * unit;
      return writeBuffer(buffer, offset, data, dataOffset, size);
    };
    const snapshot = () => ({ ...counts });
    device.pushErrorScope('validation');
    const stats = Stats.attach(engine, { profiling: true });
    const t0 = performance.now();
    const model = await parseFBX(engine, input);
    const loadMs = performance.now() - t0;
    const afterLoad = snapshot();
    engine.render();
    await device.queue.onSubmittedWorkDone();
    const firstFrameMs = performance.now() - t0 - loadMs;
    const afterFirst = snapshot();
    const frames = 60,
      draws = [];
    const t1 = performance.now();
    for (let i = 0; i < frames; i++) {
      engine.render();
      draws.push(engine.stats.drawCalls);
      await device.queue.onSubmittedWorkDone();
    }
    const steadyMs = (performance.now() - t1) / frames;
    const afterSteady = snapshot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    engine.render();
    await device.queue.onSubmittedWorkDone();
    const gpuMs = stats.gpuElapsedMilliseconds;
    const { data } = await readPixels(engine);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
    const error = await device.popErrorScope();
    const primitives = model.primitives.length,
      vertices = model.primitives.reduce((n, p) => n + p.vertices.length / 20, 0);
    stats.dispose();
    model.dispose();
    engine.dispose();
    return {
      compat: !!device.gl,
      loadMs,
      firstFrameMs,
      steadyMs,
      gpuMs,
      lit,
      error: error?.message,
      primitives,
      vertices,
      draws: [...new Set(draws)],
      load: afterLoad,
      first: { buffers: afterFirst.buffers - afterLoad.buffers, writeBytes: afterFirst.writeBytes - afterLoad.writeBytes },
      steady: {
        buffers: afterSteady.buffers - afterFirst.buffers,
        writeBytesPerFrame: (afterSteady.writeBytes - afterFirst.writeBytes) / frames,
        writesPerFrame: (afterSteady.writes - afterFirst.writes) / frames,
      },
    };
  }, Buffer.from(bytes).toString('base64'));
  console.log(JSON.stringify(result));
  assert.equal(result.error, undefined);
  assert.deepEqual(errors, []);
  assert.equal(result.primitives, 1);
  assert.equal(result.vertices, corners);
  assert.ok(result.lit > 256 * 256 * 0.2, `the grid covers the view: ${result.lit} lit pixels`);
  // One upload of the geometry: 80 B per PBR vertex and 4 B per index (1.5 triangles' worth of 3 per quad corner).
  assert.equal(result.load.writeBytes, corners * 80 + (corners / 4) * 6 * 4, 'the geometry is uploaded once, whole');
  assert.deepEqual(result.draws, [1], 'one draw a frame for one primitive');
  assert.equal(result.steady.buffers, 0, 'a steady frame creates no buffer');
  assert.ok(result.steady.writeBytesPerFrame <= 256, `a steady frame uploads only uniforms: ${result.steady.writeBytesPerFrame} B`);
  console.log(
    `FBX default-scale mesh (${corners.toLocaleString('en-US')} vertices, ${result.compat ? 'WebGL2 layer' : 'WebGPU'}): ` +
      `one ${(result.load.writeBytes / 1048576).toFixed(1)} MiB upload, ${result.draws[0]} draw, ` +
      `${result.steady.writeBytesPerFrame} B per steady frame; diagnostic on a busy machine: load ${result.loadMs.toFixed(0)} ms, ` +
      `first frame ${result.firstFrameMs.toFixed(0)} ms, steady ${result.steadyMs.toFixed(1)} ms wall, GPU ${result.gpuMs?.toFixed(2) ?? 'n/a'} ms`,
  );
} finally {
  await browser.close();
}
