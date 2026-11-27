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

  // KB-COMPAT-LOSSREPORT1: a real GPU reset. Chrome learns of it in the synchronous query that waited for it (a link,
  // checkFramebufferStatus) but sets isContextLost() and fires webglcontextlost only in a later task, so a failure read
  // before then was reported as the layer's own program that did not link or as an incomplete framebuffer. The GPU
  // process of this browser is crashed (its own process, not the driver), then each device does its work in one
  // synchronous block that ends with isContextLost() still false on every context.
  await page.evaluate(async () => {
    const { createCompatGPU } = await import('/packages/webgl2-compat/dist/device.js');
    window.lossDevices = [];
    for (let i = 0; i < 2; i++) {
      const device = await (await createCompatGPU().requestAdapter()).requestDevice(),
        errors = [];
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      window.lossDevices.push({ device, errors });
    }
  });
  const cdp = await page.context().browser().newBrowserCDPSession();
  await cdp.send('Browser.crashGpuProcess');
  const reset = await page.evaluate(async () => {
    const [a, b] = window.lossDevices;
    const out = {};
    // The layer's own helper program, built after the reset.
    try {
      a.device.replayer.helper('gpu-reset-test', 'out vec4 c;\nvoid main() { c = vec4(1.0); }');
      out.helperThrown = null;
    } catch (e) {
      out.helperThrown = String(e?.message ?? e);
    }
    // A render pass into a texture made after the reset: its framebuffer's completeness is read at the submit.
    b.device.pushErrorScope('validation');
    const target = b.device.createTexture({
        size: [4, 4],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      encoder = b.device.createCommandEncoder();
    encoder
      .beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] })
      .end();
    b.device.queue.submit([encoder.finish()]);
    const passScoped = b.device.popErrorScope();
    out.lostAtEnd = [a, b].map((d) => d.device.gl.isContextLost());
    out.passScoped = await passScoped.then((e) => e?.message ?? null);
    const timeout = new Promise((r) => setTimeout(() => r(null), 5000));
    out.lost = await Promise.all([a, b].map((d) => Promise.race([d.device.lost.then((l) => l.reason), timeout])));
    // fixed-wait: observe any delayed uncaptured-error task after the devices have reported their loss.
    await new Promise((r) => setTimeout(r, 50));
    out.errors = [a, b].flatMap((d) => d.errors);
    return out;
  });
  await cdp.detach();
  assert.deepEqual(reset.lostAtEnd, [false, false], 'the work ran before isContextLost() showed the reset');
  assert.equal(reset.helperThrown, null, "the layer's own helper program does not throw after a GPU reset");
  assert.equal(reset.passScoped, null, 'a framebuffer made after a GPU reset is not reported as incomplete');
  assert.deepEqual(reset.lost, ['unknown', 'unknown'], 'every device is lost');
  assert.deepEqual(reset.errors, [], 'no uncaptured error');
  assert.deepEqual(pageErrors, []);
  console.log('webgl2-compat: a GPU reset before isContextLost() shows it loses the device, with no fault or error');
} finally {
  await context.close();
}
