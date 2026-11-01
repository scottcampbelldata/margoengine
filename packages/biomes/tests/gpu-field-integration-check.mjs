// Functional hardware proof only: node packages/biomes/tests/gpu-field-integration-check.mjs
// Clean-room derivation and primary standard sections are recorded in gpu-fields.ts and the CPU test header.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { requireHardwareAdapter } from './gpu-fixed-lerp-cases.mjs';
import { fieldIntegrationCases, fieldNameSets, frameFor } from './gpu-field-integration-cases.mjs';
import { endTree, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

// Bundle internal sources in memory for Chromium and the Node reference without adding a package export.
async function fieldModuleURL() {
  const entry = '\0field-integration-test-entry';
  const sources = [
    '../src/gpu-fields.ts',
    '../src/fields.ts',
    '../src/gpu-region-fields.ts',
    '../src/region.ts',
    '../src/height.ts',
    '../src/relief.ts',
    '../src/climate.ts',
    '../src/layers.ts',
    '../src/fixed.ts',
    './gpu-field-integration-cases.mjs',
  ];
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'internal-field-integration-fixture',
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? sources
                .map(
                  (source) =>
                    `export * from ${JSON.stringify(fileURLToPath(new URL(source, import.meta.url)).replaceAll('\\', '/'))};`,
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
  assert.ok(
    !Array.isArray(result) && result.output.length === 1 && result.output[0].type === 'chunk',
    'Internal field fixture must bundle to one module; keep it self-contained',
  );
  return `data:text/javascript;base64,${Buffer.from(result.output[0].code).toString('base64')}`;
}

async function check() {
  // Deadline only. No timings, repetitions, benchmark or machine quietness requirement.
  const deadline = setTimeout(() => {
    console.error('Field integration WebGPU correctness check exceeded its five-minute bound');
    void endTree(process.pid, { waitMs: 10000 }).finally(() => process.exit(1));
  }, 290000);
  let context;
  const pageErrors = [];
  try {
    const root = new URL('../../../', import.meta.url),
      git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(git(['status', '--porcelain']), '', 'Hardware proof requires a clean committed head');
    const head = git(['rev-parse', 'HEAD']);
    assert.equal(hostname().toUpperCase(), 'DEV', 'Run this hardware proof on DEV with its NVIDIA RTX A6000');
    console.log(`Field integration WebGPU correctness head: ${head}`);
    const moduleURL = await fieldModuleURL(),
      module = await import(moduleURL),
      specs = fieldIntegrationCases(),
      nameSets = fieldNameSets,
      expectedCount = specs.reduce((n, spec) => n + spec.rectangles.length * nameSets.length, 0);
    assert.ok(expectedCount > 0);
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
          async ({ moduleURL, specs, nameSets }) => {
            const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) throw new Error('No hardware WebGPU adapter; run on DEV with its NVIDIA RTX A6000');
            const info = adapter.info,
              canvas = document.createElement('canvas'),
              gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' }),
              ext = gl?.getExtension('WEBGL_debug_renderer_info'),
              renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
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
              errors = [],
              values = [];
            let destroying = false;
            device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
            void device.lost.then((loss) => {
              if (!destroying) errors.push(`device lost: ${loss.message}`);
            });
            try {
              for (const spec of specs) {
                const frame = module.frameFor(module, spec);
                for (const r of spec.rectangles)
                  for (const names of nameSets) {
                    // Production wrapper dispatches the existing WGSL and rejects every missing cell marker.
                    const layers = await module.rectFieldsGPU(device, frame, r.ox, r.oz, r.width, r.depth, names);
                    values.push(
                      [...layers.values()].map(({ data, ...metadata }) => ({
                        ...metadata,
                        data: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
                      })),
                    );
                  }
              }
              await device.queue.onSubmittedWorkDone();
              return { identity, values, errors };
            } finally {
              destroying = true;
              device.destroy();
            }
          },
          { moduleURL, specs, nameSets },
        );
        const adapter = requireHardwareAdapter(result.identity);
        assert.match(adapter, /NVIDIA.*RTX A6000/i, 'The selected WebGPU adapter must be the DEV RTX A6000');
        console.log(`Field integration WebGPU selected adapter: ${JSON.stringify(result.identity)}`);
        assert.deepEqual(result.errors, [], 'WebGPU errors');
        assert.equal(result.values.length, expectedCount, 'GPU rectangles or name sets were skipped');
        let gpuCases = 0;
        for (const spec of specs) {
          const frame = frameFor(module, spec);
          for (const r of spec.rectangles)
            for (const names of nameSets) {
              const expected = module.rectFields(frame, r.ox, r.oz, r.width, r.depth, names),
                actual = result.values[gpuCases];
              assert.deepEqual(
                actual.map((layer) => layer.name),
                [...expected.keys()],
                `GPU case ${gpuCases} layer keys`,
              );
              for (const [i, layer] of [...expected.values()].entries()) {
                const { data, ...metadata } = layer;
                assert.deepEqual(
                  actual[i],
                  {
                    ...metadata,
                    data: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
                  },
                  `GPU case ${gpuCases} seed ${spec.seed} ${JSON.stringify(r)} ${layer.name}`,
                );
              }
              gpuCases++;
            }
        }
        assert.equal(gpuCases, expectedCount);
        return { status: 'pass', backend: 'webgpu', adapter, gpuCases, skipped: 0 };
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
