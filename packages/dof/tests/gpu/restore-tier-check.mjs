// Actual device loss and replacement: a refused HDR effect must leave no live frame passes behind.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';

const context = await openBrowser({
  startPath: '/packages/webgl2-compat/test/tier-packages.html',
  port: 'free',
  compat: false,
});
const errors = [];
context.page.on('pageerror', (error) => errors.push(error.message));
try {
  const rows = await context.page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { DOF } = await import('/packages/dof/dist/index.js');
    const { Bloom, SSAO, GTAO, PostStack } = await import('/packages/post/dist/index.js');
    const { installTiers } = await import('/packages/webgl2-compat/dist/tiers.js');
    const { uninstall } = await import('/packages/webgl2-compat/dist/index.js');
    const { maskTier } = await import('/packages/webgl2-compat/test/support/mask-tier.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const rows = [];
    for (const start of ['full', 'half-float'])
      for (const name of ['dof', 'dof-temporal', 'bloom', 'ssao', 'stack']) {
        let tier = start;
        await installTiers({
          force: true,
          createContext(attributes) {
            const gl = new OffscreenCanvas(1, 1).getContext('webgl2', attributes);
            maskTier(gl, tier);
            return gl;
          },
        });
        const canvas = document.createElement('canvas');
        document.body.append(canvas);
        const kernel = await Engine.create(canvas, { backend: 'webgpu', exactSize: [16, 16] });
        const engine = engineRuntime(kernel),
          faults = [],
          gpuErrors = [];
        let timer;
        try {
          const effect =
            name === 'dof'
              ? new DOF()
              : name === 'dof-temporal'
                ? new DOF({ temporal: true })
                : name === 'bloom'
                  ? new Bloom()
                  : name === 'ssao'
                    ? new SSAO()
                    : new PostStack([new GTAO(), new DOF(), new Bloom()]);
          engine.use(effect);
          await waitForPipelines(
            async () => {
              kernel.render({ delta: 0 });
              await engine.gpu.queue.onSubmittedWorkDone();
            },
            { timeoutMs: 60000 },
          );
          const reported = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('device restoration did not report its refusal')), 30000);
            engine.onError = (error) => {
              faults.push({ code: error.code, message: error.message });
              resolve();
            };
          });
          tier = 'ldr';
          engine.gpu.destroy();
          await reported;
          clearTimeout(timer);
          engine.gpu.addEventListener('uncapturederror', (event) => {
            gpuErrors.push(event.error.message);
            event.preventDefault();
          });
          for (let i = 0; i < 3; i++) {
            kernel.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
          }
          rows.push({
            start,
            name,
            tier: engine.gpu.adapter.capabilities.tier,
            attached: engine.hasPlugin(effect.name),
            stackChildren: ['gtao', 'dof', 'bloom'].filter((name) => engine.hasPlugin(name)),
            faults,
            gpuErrors,
            gl: engine.gpu.gl.getError(),
          });
        } finally {
          clearTimeout(timer);
          kernel.dispose();
          canvas.remove();
          uninstall();
        }
      }
    return rows;
  });
  for (const row of rows) {
    assert.equal(row.tier, 'ldr');
    assert.equal(row.attached, false);
    assert.deepEqual(row.stackChildren, []);
    assert.equal(row.faults.length, 1, 'one engine error event per replacement');
    assert.equal(row.faults[0].code, 'unsupported');
    assert.match(row.faults[0].message, /half-float.*ldr.*https:\/\//);
    assert.deepEqual(row.gpuErrors, []);
    assert.equal(row.gl, 0);
    console.log(`${row.start} -> LDR ${row.name}: detached, one coded error, three clean frames`);
  }
  assert.deepEqual(errors, []);
} finally {
  await context.close();
}
