// Functional hardware proof only. No timing measurements or benchmark claims.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { backendPlacementModuleCode } from './gpu-backend-placement-entry.mjs';
import { requireHardwareAdapter } from './gpu-fixed-lerp-cases.mjs';
import { endTree, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

export { backendPlacementModuleCode };

async function check() {
  const deadline = setTimeout(() => {
    console.error('BiomePlacement/hydrology WebGPU correctness check exceeded its 290 second deadline');
    void endTree(process.pid, { waitMs: 10000 }).finally(() => process.exit(1));
  }, 290000);
  let context;
  const pageErrors = [];
  try {
    const root = new URL('../../../', import.meta.url);
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(git(['status', '--porcelain']), '', 'Hardware proof requires a clean committed head');
    const head = git(['rev-parse', 'HEAD']);
    console.log(`BiomePlacement/hydrology WebGPU correctness head: ${head}`);
    const moduleCode = await backendPlacementModuleCode();
    const result = await runSuite(
      async () => {
        const { openBrowser } = await import('../../../scripts/browser.js');
        context = await openBrowser({
          startPath: '/tests/wgsl-check.html',
          port: 'free',
          compat: false,
          args: ['--enable-webgpu-developer-features'],
        });
        const { page } = context;
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') pageErrors.push(message.text());
        });
        await page.addScriptTag({ content: moduleCode });
        const identity = await page.evaluate(async () => {
          const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
          if (!adapter) throw Error('No hardware WebGPU adapter available');
          const info = adapter.info,
            canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
          const ext = gl?.getExtension('WEBGL_debug_renderer_info');
          const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
          gl?.getExtension('WEBGL_lose_context')?.loseContext();
          globalThis.__margoBackendPlacementAdapter = adapter;
          return {
            name: info?.description?.trim(),
            nameSource: 'webgpu',
            vendor: info?.vendor,
            architecture: info?.architecture,
            device: info?.device,
            renderer,
            fallback: info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
          };
        });
        // Validate the selected adapter before requesting its device or executing shaders.
        const adapter = requireHardwareAdapter(identity);
        console.log('BiomePlacement/hydrology WebGPU selected adapter: ' + JSON.stringify(identity));
        const expected = process.env.AGENT_FACTORY_GPU_ADAPTER ?? process.env.GPU_VENDOR;
        if (expected)
          assert.ok(
            adapter.toLowerCase().includes(expected.toLowerCase()),
            'Selected adapter differs from expected hardware',
          );
        const proof = await page.evaluate(async () => {
          const selected = globalThis.__margoBackendPlacementAdapter;
          const device = await selected.requestDevice({
            requiredLimits: {
              maxStorageBufferBindingSize: selected.limits.maxStorageBufferBindingSize,
              maxBufferSize: selected.limits.maxBufferSize,
            },
          });
          const module = globalThis.__margoBackendPlacementProof,
            stages = module.watchStages(device);
          const errors = [];
          let destroying = false;
          device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
          void device.lost.then((loss) => {
            if (!destroying) errors.push(`device lost: ${loss.message}`);
          });
          try {
            if (module.BACKEND_PLACEMENT_CASE_COUNT !== 14) throw Error('Backend case matrix changed');
            const gpuCases = await module.runBackendPlacementCases(device);
            for (const stage of ['counts', 'emit', 'accept', 'kill', 'd8', 'accumulate'])
              if (!stages.has(stage))
                throw Error('GPU stage was not exercised: ' + stage + " (backend 'gpu' work ran on the CPU)");
            await device.queue.onSubmittedWorkDone();
            return { gpuCases, errors };
          } finally {
            destroying = true;
            device.destroy();
          }
        });
        assert.deepEqual(proof.errors, [], 'WebGPU compilation, validation or uncaptured errors');
        assert.equal(proof.gpuCases, 14, 'GPU cases were skipped');
        return { status: 'pass', backend: 'webgpu', adapter, gpuCases: proof.gpuCases, skipped: 0 };
      },
      async () => context?.close(),
    );
    assert.deepEqual(pageErrors, [], 'Browser errors');
    assert.equal(git(['rev-parse', 'HEAD']), head, 'Committed head changed during hardware proof');
    assert.equal(git(['status', '--porcelain']), '', 'Worktree changed during hardware proof');
    watchExit();
    console.log(`AGENT_FACTORY_GPU_CHECK:${JSON.stringify(result)}`);
  } finally {
    clearTimeout(deadline);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await check();
