// Functional hardware proof only: node packages/biomes/tests/gpu-classify-warp-check.mjs
// Provenance and arithmetic bounds: ../src/gpu-classify-warp.ts. No timings or repetitions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { requireHardwareAdapter, warpCases, syntheticWarpCases } from './gpu-classify-warp-cases.mjs';
import { endTree, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

export async function warpModuleCode() {
  const entry = '\0classify-warp-test-entry';
  const sources = [
    '../src/gpu-classify-warp.ts',
    '../src/classify-warp.ts',
    '../src/gpu-fixed-lerp.ts',
    '../src/hash.ts',
    '../src/fixed.ts',
    './gpu-classify-warp-cases.mjs',
  ];
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'internal-classify-warp-fixture',
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
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict',
        output: { format: 'iife', name: '__margoWarpProof' },
      },
    },
  });
  assert.ok(
    !Array.isArray(result) && result.output.length === 1 && result.output[0].type === 'chunk',
    'Internal warp fixture must bundle to one self-contained module',
  );
  return result.output[0].code;
}

async function check() {
  const deadline = setTimeout(() => {
    console.error('Ecotone warp WebGPU correctness check exceeded its 290 second deadline');
    void endTree(process.pid, { waitMs: 10000 }).finally(() => process.exit(1));
  }, 290000);
  let context;
  const pageErrors = [];
  try {
    const root = new URL('../../../', import.meta.url),
      git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(git(['status', '--porcelain']), '', 'Hardware proof requires a clean committed head');
    const head = git(['rev-parse', 'HEAD']);
    console.log(`Ecotone warp WebGPU correctness head: ${head}`);
    const moduleCode = await warpModuleCode(),
      expectedCount = warpCases().length + syntheticWarpCases().length;
    assert.equal(expectedCount, 16);
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
        const proof = await page.evaluate(async () => {
          const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
          if (!adapter) throw new Error('No hardware WebGPU adapter; select an NVIDIA RTX A6000 worker');
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
          // Reject the selected adapter before requesting its device or executing any kernel.
          if (
            !identity.name ||
            identity.fallback !== false ||
            !/NVIDIA.*RTX A6000/i.test(identity.name) ||
            /software|virtual|swiftshader|llvmpipe|lavapipe|vmware|virgl|qemu|parallels|remote display/i.test(
              [identity.name, identity.vendor, identity.architecture, identity.device, renderer].join(' '),
            )
          )
            throw new Error('Selected WebGPU adapter must be a physical non-fallback NVIDIA RTX A6000');
          const module = globalThis.__margoWarpProof,
            device = await adapter.requestDevice(),
            errors = [];
          let destroying = false,
            gpuCases = 0;
          device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
          void device.lost.then((loss) => {
            if (!destroying) errors.push(`device lost: ${loss.message}`);
          });
          try {
            const cases = [
              ...module
                .warpCases()
                .map((s) => ({ ...s, lattice: module.warpLattice(s.seed, s.cell, s.gx, s.gz, s.n, s.depth) })),
              ...module.syntheticWarpCases(),
            ];
            for (const s of cases) {
              const args = [s.gx, s.gz, s.n, s.depth],
                count = s.n * s.depth,
                cpu = { n1: new Int32Array(count), n2: new Int32Array(count), dT: new Int32Array(count) };
              module.warpPlanes(s.lattice, ...args, cpu.n2, cpu.dT, cpu.n1);
              const oracle = module.warpOracle(s.lattice, ...args),
                actual = await module.classifyWarpGPU(device, s.lattice, ...args);
              for (const name of ['n1', 'n2', 'dT']) {
                if (actual[name].length !== count) throw new Error(`GPU case ${gpuCases} ${name} length`);
                for (let k = 0; k < count; k++)
                  if (actual[name][k] !== cpu[name][k] || actual[name][k] !== oracle[name][k])
                    throw new Error(
                      `GPU case ${gpuCases} ${name}[${k}]: GPU ${actual[name][k]}, CPU ${cpu[name][k]}, oracle ${oracle[name][k]}`,
                    );
              }
              gpuCases++;
            }
            await device.queue.onSubmittedWorkDone();
            return { identity, gpuCases, errors };
          } finally {
            destroying = true;
            device.destroy();
          }
        });
        const adapter = requireHardwareAdapter(proof.identity);
        assert.match(adapter, /NVIDIA.*RTX A6000/i, 'Selected adapter must be the NVIDIA RTX A6000');
        console.log(`Ecotone warp WebGPU selected adapter: ${JSON.stringify(proof.identity)}`);
        assert.deepEqual(proof.errors, [], 'WebGPU errors');
        assert.equal(proof.gpuCases, expectedCount, 'GPU cases were skipped');
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
