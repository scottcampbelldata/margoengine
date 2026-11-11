// The default-limit FBX mesh (996,004 vertices, test/default-scale.js) loads with default options and renders, on
// native WebGPU and (MARGO_COMPAT=1) the WebGL2 layer. gltf-pro draws its one glTF primitive as parts of at most
// 262,144 vertices (its default maxPartVertices), so the assertions are: the parts cover the mesh exactly (every vertex,
// every triangle once, test/part-coverage.js), one upload of the parts' geometry, one draw per part, a steady frame
// that creates no buffer and re-uploads no geometry. Load time and GPU frame
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
  const result = await browser.page.evaluate(async ([base64, corners]) => {
    const [{ Engine }, { parseFBX }, { Stats }, { readPixels, createHeadlessCanvas }, { partCoverage }] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/fbx/dist/index.js'),
      import('/packages/stats/dist/index.js'),
      import('/packages/headless/dist/index.js'),
      import('/packages/fbx/test/part-coverage.js'),
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
    // The GPU time is read back asynchronously: draw until a timestamp sample has arrived (a device with no
    // timestamp-query has none to wait for), failing after 10 s.
    const timed = device.features.has('timestamp-query'),
      deadline = performance.now() + 10000;
    do {
      engine.render();
      await device.queue.onSubmittedWorkDone();
      if (!timed || stats.gpuElapsedMilliseconds !== null) break;
      if (performance.now() > deadline) throw new Error('no GPU timestamp sample arrived in 10 s');
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (true);
    const gpuMs = stats.gpuElapsedMilliseconds;
    const { data } = await readPixels(engine);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
    const error = await device.popErrorScope();
    const primitives = model.primitives.length,
      vertices = model.primitives.reduce((n, p) => n + p.vertices.length / 20, 0),
      indices = model.primitives.reduce((n, p) => n + p.indices.length, 0),
      coverage = partCoverage(
        model.primitives.map((p) => ({ indices: p.indices, vertexMap: p.part?.vertexMap })),
        corners,
      );
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
      indices,
      coverage,
      draws: [...new Set(draws)],
      load: afterLoad,
      first: { buffers: afterFirst.buffers - afterLoad.buffers, writeBytes: afterFirst.writeBytes - afterLoad.writeBytes },
      steady: {
        buffers: afterSteady.buffers - afterFirst.buffers,
        writeBytesPerFrame: (afterSteady.writeBytes - afterFirst.writeBytes) / frames,
        writesPerFrame: (afterSteady.writes - afterFirst.writes) / frames,
      },
    };
  }, [Buffer.from(bytes).toString('base64'), corners]);
  console.log(JSON.stringify(result));
  assert.equal(result.error, undefined);
  assert.deepEqual(errors, []);
  const { coverage } = result;
  assert.equal(coverage.parts, result.primitives);
  assert.ok(coverage.largest <= 262_144, `every part within the default 262,144 vertices: ${coverage.largest}`);
  assert.deepEqual(
    [coverage.wrong, coverage.repeated, coverage.missingVertices, coverage.missingTriangles],
    [0, 0, 0, 0],
    'every vertex and every triangle of the mesh is drawn, each triangle once',
  );
  assert.equal(result.vertices, coverage.stored);
  assert.ok(result.vertices < corners * 1.01, `cut vertices stay under 1%: ${result.vertices} for ${corners}`);
  assert.equal(result.indices, (corners / 4) * 6, 'no triangle is added or lost');
  assert.ok(result.lit > 256 * 256 * 0.2, `the grid covers the view: ${result.lit} lit pixels`);
  // One upload of the parts' geometry: 80 B per stored PBR vertex and 4 B per index.
  assert.equal(result.load.writeBytes, result.vertices * 80 + result.indices * 4, 'the geometry is uploaded once');
  assert.deepEqual(result.draws, [result.primitives], 'one draw a frame per part');
  assert.equal(result.steady.buffers, 0, 'a steady frame creates no buffer');
  assert.ok(result.steady.writeBytesPerFrame <= 256, `a steady frame uploads only uniforms: ${result.steady.writeBytesPerFrame} B`);
  console.log(
    `FBX default-scale mesh (${corners.toLocaleString('en-US')} vertices, ${result.compat ? 'WebGL2 layer' : 'WebGPU'}): ` +
      `${result.primitives} parts, one ${(result.load.writeBytes / 1048576).toFixed(1)} MiB upload, ${result.draws[0]} draws, ` +
      `${result.steady.writeBytesPerFrame} B per steady frame; diagnostic on a busy machine: load ${result.loadMs.toFixed(0)} ms, ` +
      `first frame ${result.firstFrameMs.toFixed(0)} ms, steady ${result.steadyMs.toFixed(1)} ms wall, GPU ${result.gpuMs?.toFixed(2) ?? 'n/a'} ms`,
  );
} finally {
  await browser.close();
}
