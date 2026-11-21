// KB6016e side finding (2026-11-21): on ANGLE Direct3D 11 a WebGL2 program pays its shader compile at its first draw,
// for one colour output as for several, and LinkedProgram.warmed warmed only programs with 2 or more targets, so a
// 1-output async pipeline resolved before its compile and the first frame after `ready` stalled on it. This makes a
// 1-output async pipeline from new shader text and checks, by a count of rasterizer-discard draws (a work count; no
// time is asserted), that on Direct3D it drew its warm draw before it resolved and none elsewhere, and that its first
// real draw writes the same pixels as a pipeline made without a warm draw. The first draw's time on each is printed.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const limit = setTimeout(() => {
  console.error('webgl2-compat first-draw check exceeded its 120 second limit');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 120000);
const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/features.html', port: 'free' });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await page.evaluate(async () => {
    const { createCompatGPU } = await import('/packages/webgl2-compat/dist/device.js');
    const device = await (await createCompatGPU().requestAdapter()).requestDevice();
    const gl = device.gl,
      draw = gl.drawArrays;
    let warmDraws = 0;
    gl.drawArrays = function (...args) {
      if (gl.isEnabled(gl.RASTERIZER_DISCARD)) warmDraws++;
      return draw.apply(this, args);
    };
    const target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 16 | 1 });
    const buffer = device.createBuffer({ size: 256 * 4, usage: 1 | 8 });
    // New text each run (ANGLE caches programs by their source), the same pixels: K is folded away.
    const code = (k) => `
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p = array(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  return vec4f(p[i], 0, 1);
}
@fragment fn f(@builtin(position) q:vec4f)->@location(0) vec4f {
  var c = vec4f(0);
  for (var i = 0u; i < 64u; i++) { c = fract(c * 1.37 + vec4f(f32(i) * 0.011, 0.02, 0.03, 0.04) + q * 0.0); }
  return vec4f(0.25, 0.5, 0.75, 1) + c * ${k} * 0.0;
}`;
    const describe = (k) => {
      const module = device.createShaderModule({ code: code(k) });
      return {
        layout: 'auto',
        vertex: { module, entryPoint: 'v' },
        fragment: { module, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] },
      };
    };
    const firstDraw = async (pipeline) => {
      const started = performance.now(),
        e = device.createCommandEncoder(),
        pass = e.beginRenderPass({
          colorAttachments: [
            { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
          ],
        });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      e.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [4, 4]);
      device.queue.submit([e.finish()]);
      await buffer.mapAsync(1);
      const pixel = [...new Uint8Array(buffer.getMappedRange(), 0, 4)];
      buffer.unmap();
      return { ms: performance.now() - started, pixel };
    };
    const nonce = (Date.now() % 100000) + Math.random();
    const plain = device.createRenderPipeline(describe(nonce + 1));
    const plainWarmDraws = warmDraws;
    const unwarmed = await firstDraw(plain);
    warmDraws = 0;
    const asyncPipeline = await device.createRenderPipelineAsync(describe(nonce + 2));
    const asyncWarmDraws = warmDraws;
    const warmed = await firstDraw(asyncPipeline);
    const renderer = device.adapter.capabilities.renderer;
    device.destroy();
    return { renderer, plainWarmDraws, asyncWarmDraws, unwarmed, warmed };
  });
  const d3d = /Direct3D|D3D11/.test(result.renderer);
  assert.equal(result.plainWarmDraws, 0, 'createRenderPipeline makes no warm draw');
  assert.equal(result.asyncWarmDraws, d3d ? 1 : 0, `a 1-output async pipeline's warm draws on ${result.renderer}`);
  assert.deepEqual(result.unwarmed.pixel, [64, 128, 191, 255]);
  assert.deepEqual(result.warmed.pixel, result.unwarmed.pixel, 'the warm draw changes nothing a draw renders');
  assert.deepEqual(pageErrors, []);
  console.log(
    `webgl2-compat first draw (${result.renderer}): 1-output async pipeline, ${result.asyncWarmDraws} warm draw before ` +
      `it resolved; first draw ${result.warmed.ms.toFixed(1)} ms, against ${result.unwarmed.ms.toFixed(1)} ms for a ` +
      'pipeline made with createRenderPipeline (no warm draw)',
  );
} finally {
  clearTimeout(limit);
  await context.close();
}
