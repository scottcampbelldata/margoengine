// Functional hardware proof only: node packages/biomes/tests/gpu-region-fields-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { requireHardwareAdapter } from './gpu-fixed-lerp-cases.mjs';
import { regionFieldCases, fieldNames, oracleFields, oracleStored, storedCPU } from './gpu-region-fields-cases.mjs';

// Non-entry modules are not emitted by the package build. Bundle the actual sources in memory, without adding
// package exports, changing build configuration, or maintaining a second implementation for the hardware runner.
async function regionModuleURL() {
  const entry = '\0region-field-test-entry';
  const sources = ['gpu-region-fields', 'fields', 'climate', 'layers'];
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'internal-region-fixture',
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? sources
                .map(
                  (name) =>
                    `export * from ${JSON.stringify(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)).replaceAll('\\', '/'))};`,
                )
                .join('\n')
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { format: 'es' } },
    },
  });
  if (Array.isArray(result) || result.output.length !== 1 || result.output[0].type !== 'chunk')
    throw new Error('Internal region fixture must bundle to one module; keep the fixture self-contained');
  return `data:text/javascript;base64,${Buffer.from(result.output[0].code).toString('base64')}`;
}

async function check() {
  const { endTree, runSuite, watchExit } = await import('../../../scripts/support/shutdown.mjs');
  // Deadline only. No timing, repetitions, benchmark or machine quietness requirement.
  const deadline = setTimeout(() => {
    console.error('Region WebGPU correctness check exceeded its five-minute bound');
    void endTree(process.pid, { waitMs: 10000 }).finally(() => process.exit(1));
  }, 290000);
  let context;
  const pageErrors = [];
  try {
    const root = new URL('../../../', import.meta.url);
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim(),
      '',
      'Hardware proof requires a clean committed head',
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    console.log(`Region WebGPU correctness head: ${head}`);
    const moduleURL = await regionModuleURL(),
      module = await import(moduleURL),
      cases = regionFieldCases();
    const inputs = cases.map((c) => ({
      ...c,
      region: {
        ...c.region,
        height: [],
        ...Object.fromEntries(fieldNames.map((name) => [name, Array.from(c.region[name])])),
      },
    }));
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
        const result = await page.evaluate(
          async ({ moduleURL, inputs, fieldNames }) => {
            // Identity must describe the adapter that actually runs WGSL, never a WebGL fallback name:
            // https://www.w3.org/TR/2026/CRD-webgpu-20260915/#gpuadapterinfo
            const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) throw new Error('No hardware WebGPU adapter; run on DEV with its NVIDIA RTX A6000');
            const info = adapter.info;
            const canvas = document.createElement('canvas'),
              gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
            const identity = {
              name: info?.description?.trim(),
              nameSource: 'webgpu',
              vendor: info?.vendor,
              architecture: info?.architecture,
              device: info?.device,
              renderer,
              fallback: info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
            };
            const module = await import(moduleURL),
              device = await adapter.requestDevice(),
              errors = [];
            let destroying = false;
            device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
            void device.lost.then((loss) => {
              if (!destroying) errors.push(`device lost: ${loss.message}`);
            });
            const values = [];
            try {
              for (const c of inputs) {
                const region = {
                  ...c.region,
                  ...Object.fromEntries(fieldNames.map((name) => [name, Int32Array.from(c.region[name])])),
                };
                // This calls the production wrapper and its actual WGSL. It rejects any compilation message,
                // validation error, loss, uncaptured error or missing per-cell executed marker.
                const raw = await module.upsampleRegionFieldsGPU(device, region, c.cell, c.ox, c.oz, c.width, c.depth);
                const stored = module.storedRegionLayers(raw);
                values.push({
                  raw: Object.fromEntries(fieldNames.map((name) => [name, Array.from(raw[name])])),
                  stored: Object.fromEntries(
                    Object.entries(stored).map(([name, data]) => [
                      name,
                      Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
                    ]),
                  ),
                });
              }
              await device.queue.onSubmittedWorkDone();
              return { identity, values, errors };
            } finally {
              destroying = true;
              device.destroy();
            }
          },
          { moduleURL, inputs, fieldNames },
        );
        const adapter = requireHardwareAdapter(result.identity);
        if (hostname().toUpperCase() === 'DEV') assert.match(adapter, /NVIDIA.*RTX A6000/i);
        assert.deepEqual(result.errors, [], 'WebGPU errors');
        assert.ok(cases.length > 0);
        assert.equal(result.values.length, cases.length, 'GPU rectangles were skipped');
        let gpuCases = 0;
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i],
            gpu = result.values[i],
            oracle = oracleFields(c),
            ref = module.regionFieldsRef(c.region, c.cell, c.ox, c.oz, c.width, c.depth),
            cpuStored = storedCPU(module, c),
            clamped = oracleStored(oracle);
          for (const name of fieldNames) {
            assert.deepEqual(gpu.raw[name], Array.from(oracle[name]), `WGSL raw ${name} rectangle ${i}`);
            assert.deepEqual(gpu.raw[name], Array.from(ref[name]), `CPU raw ${name} rectangle ${i}`);
          }
          for (const name of ['rainfall', 'exposure', 'waterDistance']) {
            const bytes = (data) => Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            assert.deepEqual(gpu.stored[name], bytes(cpuStored[name]), `rectFields bytes ${name} rectangle ${i}`);
            assert.deepEqual(gpu.stored[name], bytes(clamped[name]), `oracle clamp bytes ${name} rectangle ${i}`);
          }
          gpuCases++;
        }
        return { status: 'pass', backend: 'webgpu', adapter, gpuCases, skipped: 0 };
      },
      async () => context?.close(),
    );
    assert.deepEqual(pageErrors, [], 'Browser errors');
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim(),
      head,
      'Committed head changed during hardware proof',
    );
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim(),
      '',
      'Worktree changed during hardware proof',
    );
    watchExit();
    console.log(`AGENT_FACTORY_GPU_CHECK:${JSON.stringify(result)}`);
  } finally {
    clearTimeout(deadline);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await check();
