// A lost WebGL2 context is the device's loss, never a layer bug or a validation error (run by `npm run test:gpu`;
// KB-BOUNCE-COMPATUNITS1). The context is lost at once, its webglcontextlost event only in a later task: so the first
// present after it (the layer builds its own present program then), or a pipeline linked after it, saw a program that
// did not link and threw "The compatibility layer's own present program did not link (a bug: report it)", or reported
// the pipeline as refused. Now the device is lost ('unknown'), nothing throws, and no error is raised.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/features.html', port: 'free' });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(async () => {
    const { CompatCanvasContext, createCompatGPU } = await import('/packages/webgl2-compat/dist/device.js');
    const adapter = await createCompatGPU().requestAdapter(),
      device = await adapter.requestDevice(),
      canvas = Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    document.body.append(canvas);
    const errors = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const gpuContext = new CompatCanvasContext(canvas, HTMLCanvasElement.prototype.getContext);
    gpuContext.configure({ device, format: 'rgba8unorm' });
    const module = device.createShaderModule({
      code: `@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn f() -> @location(0) vec4f { return vec4f(0.2, 0.4, 0.8, 1.0); }`,
    });
    const descriptor = {
      layout: 'auto',
      vertex: { module, entryPoint: 'v' },
      fragment: { module, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] },
    };
    device.gl.getExtension('WEBGL_lose_context').loseContext();
    let thrown = null;
    device.pushErrorScope('validation');
    try {
      const pipeline = device.createRenderPipeline(descriptor),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: gpuContext.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 1],
            },
          ],
        });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    } catch (e) {
      thrown = String(e?.message ?? e);
    }
    const scoped = await device.popErrorScope().then((e) => e?.message ?? null);
    // The layer's own helper programs (clears drawn as triangles, stencil and depth readback) are built at first use:
    // one built after the loss returns, unlinked, instead of throwing a layer fault.
    let helperThrown = null;
    try {
      device.replayer.helper('lost-context-test', 'out vec4 c;\nvoid main() { c = vec4(1.0); }');
    } catch (e) {
      helperThrown = String(e?.message ?? e);
    }
    let rejected = null;
    const asyncPipeline = await device.createRenderPipelineAsync(descriptor).catch((e) => (rejected = e.message));
    const lost = await Promise.race([device.lost, new Promise((r) => setTimeout(() => r(null), 5000))]);
    // fixed-wait: observe any delayed uncaptured-error task after the device has reported its loss.
    await new Promise((r) => setTimeout(r, 50));
    canvas.remove();
    return {
      thrown,
      scoped,
      helperThrown,
      rejected,
      resolved: !!asyncPipeline,
      lost: lost && { reason: lost.reason },
      errors,
    };
  });
  assert.equal(r.thrown, null, 'nothing throws on a lost context');
  assert.equal(r.scoped, null, 'a pipeline linked after the loss is not reported as refused');
  assert.equal(r.helperThrown, null, "the layer's own helper program does not throw on a lost context");
  assert.equal(r.rejected, null, 'createRenderPipelineAsync resolves on a lost device');
  assert.ok(r.resolved);
  assert.deepEqual(r.lost, { reason: 'unknown' }, 'device.lost resolves');
  assert.deepEqual(r.errors, [], 'no uncaptured error');
  assert.deepEqual(pageErrors, []);
  console.log('webgl2-compat: a lost WebGL2 context loses the device, with no layer fault and no validation error');
} finally {
  await context.close();
}
