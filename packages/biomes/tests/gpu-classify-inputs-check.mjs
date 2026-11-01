// Functional hardware proof only: node packages/biomes/tests/gpu-classify-inputs-check.mjs
// Provenance and arithmetic bounds: ../src/gpu-classify-inputs.ts. No timings or repetitions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { requireHardwareAdapter, INPUTS_CASE_COUNT } from './gpu-classify-inputs-cases.mjs';
import { fieldIntegrationCases } from './gpu-field-integration-cases.mjs';
import { endTree, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

export async function inputsModuleCode() {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        input: fileURLToPath(new URL('./gpu-classify-inputs-entry.mjs', import.meta.url)),
        preserveEntrySignatures: 'strict',
        output: { format: 'iife', name: '__margoInputsProof' },
      },
    },
  });
  assert.ok(
    !Array.isArray(result) && result.output.length === 1 && result.output[0].type === 'chunk',
    'Internal inputs fixture must bundle to one self-contained module',
  );
  return result.output[0].code;
}

async function check() {
  const deadline = setTimeout(() => {
    console.error('Classification inputs WebGPU correctness check exceeded its 290 second deadline');
    void endTree(process.pid, { waitMs: 10000 }).finally(() => process.exit(1));
  }, 290000);
  let context;
  const pageErrors = [];
  try {
    const root = new URL('../../../', import.meta.url),
      git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(git(['status', '--porcelain']), '', 'Hardware proof requires a clean committed head');
    const head = git(['rev-parse', 'HEAD']);
    console.log(`Classification inputs WebGPU correctness head: ${head}`);
    const moduleCode = await inputsModuleCode(),
      expectedCount = INPUTS_CASE_COUNT + fieldIntegrationCases().reduce((sum, s) => sum + s.rectangles.length, 0);
    assert.equal(expectedCount, 33);
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
            !/NVIDIA.*RTX A6000\b/i.test(identity.name) ||
            /software|virtual|swiftshader|llvmpipe|lavapipe|softpipe|basic render|\bwarp\b|vmware|virgl|qemu|parallels|remote display/i.test(
              [identity.name, identity.vendor, identity.architecture, identity.device, renderer].join(' '),
            )
          )
            throw new Error('Selected WebGPU adapter must be a physical non-fallback NVIDIA RTX A6000');
          const rendererDevice = renderer.match(/\b0x([0-9a-f]+)\b/i);
          if (
            typeof identity.device === 'string' &&
            /^(?:0x)?[0-9a-f]+$/i.test(identity.device.trim()) &&
            rendererDevice &&
            Number.parseInt(identity.device.trim(), 16) !== Number.parseInt(rendererDevice[1], 16)
          )
            throw new Error('Selected WebGPU adapter device must match the WebGL renderer');
          const module = globalThis.__margoInputsProof,
            device = await adapter.requestDevice(),
            errors = [];
          let destroying = false,
            gpuCases = 0;
          device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
          void device.lost.then((loss) => {
            if (!destroying) errors.push(`device lost: ${loss.message}`);
          });
          try {
            const equal = (a, b, label) => {
              if (a.length !== b.length) throw new Error(`${label}: length mismatch`);
              for (let k = 0; k < a.length; k++)
                if (a[k] !== b[k]) throw new Error(`${label}[${k}]: GPU ${a[k]}, expected ${b[k]}`);
            };
            const planesEqual = (a, b, label) => {
              for (const key of ['warped', 'member', 'n2', 'n1s']) {
                if (!!a[key] !== !!b[key]) throw new Error(`${label} ${key}: missing plane`);
                if (a[key]) equal(a[key], b[key], `${label} ${key}`);
              }
            };
            const cases = module.inputsCases(module);
            if (cases.length !== module.INPUTS_CASE_COUNT || cases.length !== 17)
              throw new Error('Classification fixture case count changed; review the complete hardware matrix');
            for (const s of cases) {
              const oracle = module.inputsOracle(s.c, s.input, module.warpLattice);
              // CPU scratch is copied before the GPU await; no scratch view crosses it.
              const cpu = Object.fromEntries(
                Object.entries(module.classifyInputs(s.c, s.input)).map(([key, value]) => [key, value?.slice()]),
              );
              const actual = await module.classifyInputsGPU(device, s.c, s.input);
              planesEqual(actual, cpu, s.name);
              planesEqual(actual, oracle, `${s.name} oracle`);
              const length = (s.input.n - 2) * ((s.input.depth ?? s.input.n) - 2) * 4,
                ids = new Uint8Array(length),
                weights = new Uint8Array(length),
                cpuIds = new Uint8Array(length),
                cpuWeights = new Uint8Array(length);
              module.classify(s.c, s.input, cpuIds, cpuWeights);
              await module.classifyGPU(device, s.c, s.input, ids, weights);
              equal(ids, cpuIds, `${s.name} ids`);
              equal(weights, cpuWeights, `${s.name} weights`);
              gpuCases++;
            }
            // Include the landed GPU field path in this exact-head J5 correctness proof.
            const fieldCases = module.fieldIntegrationCases();
            if (fieldCases.length !== 2) throw new Error('Review field fixture matrix');
            for (const spec of fieldCases) {
              const frame = module.frameFor(module, spec);
              for (const r of spec.rectangles) {
                const expected = module.rectFields(frame, r.ox, r.oz, r.width, r.depth, module.fieldNames),
                  actual = await module.rectFieldsGPU(device, frame, r.ox, r.oz, r.width, r.depth, module.fieldNames);
                if ([...actual.keys()].join() !== [...expected.keys()].join()) throw new Error('Field keys differ');
                for (const [name, layer] of expected) {
                  const got = actual.get(name);
                  for (const key of ['name', 'format', 'width', 'depth', 'scale', 'unit'])
                    if (got[key] !== layer[key]) throw new Error(`Field ${name} ${key} differs`);
                  equal(
                    new Uint8Array(got.data.buffer, got.data.byteOffset, got.data.byteLength),
                    new Uint8Array(layer.data.buffer, layer.data.byteOffset, layer.data.byteLength),
                    `Field ${name}`,
                  );
                }
                gpuCases++;
              }
            }
            await device.queue.onSubmittedWorkDone();
            return { identity, gpuCases, errors };
          } finally {
            destroying = true;
            device.destroy();
          }
        });
        const adapter = requireHardwareAdapter(proof.identity);
        assert.match(adapter, /NVIDIA.*RTX A6000\b/i, 'Selected adapter must be the NVIDIA RTX A6000');
        console.log(`Classification inputs WebGPU selected adapter: ${JSON.stringify(proof.identity)}`);
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
