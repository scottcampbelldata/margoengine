// Functional hardware proof only: node packages/biomes/tests/gpu-placement-flow-check.mjs
// Provenance and arithmetic bounds: ../src/gpu-placement.ts and gpu-flow.ts. No timings or repetitions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { placementFlowModuleCode } from './gpu-placement-flow-entry.mjs';
import { requireHardwareAdapter } from './gpu-classify-inputs-cases.mjs';
import { PLACEMENT_FLOW_CASE_COUNT } from './gpu-placement-flow-cases.mjs';
import { endTree, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

export { placementFlowModuleCode };

async function check() {
  const deadline = setTimeout(() => {
    console.error('Placement and flow WebGPU correctness check exceeded its 290 second deadline');
    void endTree(process.pid, { waitMs: 10000 }).finally(() => process.exit(1));
  }, 290000);
  let context;
  const pageErrors = [];
  try {
    const root = new URL('../../../', import.meta.url),
      git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(git(['status', '--porcelain']), '', 'Hardware proof requires a clean committed head');
    const head = git(['rev-parse', 'HEAD']);
    console.log(`Placement and flow WebGPU correctness head: ${head}`);
    const moduleCode = await placementFlowModuleCode(),
      expectedCount = PLACEMENT_FLOW_CASE_COUNT;
    assert.equal(expectedCount, 9);
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
          const module = globalThis.__margoPlacementFlowProof,
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
            const byteEqual = (a, b, label) => {
              if (a.length !== b.length) throw new Error(label + ': byte-plane count differs');
              for (let i = 0; i < a.length; i++) equal(a[i], b[i], label + ' plane ' + i);
            };
            const placementCases = module.placementCases(module),
              flowCases = module.flowCases();
            if (placementCases.length !== 3 || flowCases.length !== 4) throw new Error('J6 case matrix changed');
            for (const s of placementCases) {
              const world = await module.BiomeWorld.create(s.options),
                placement = module.BiomePlacement.attach(world, s.placement);
              try {
                const cpu = await placement.tile(s.x, s.z),
                  gpu = await module.placeTileGPU(device, placement, s.x, s.z);
                if (!cpu.count) throw new Error(s.name + ': empty placement case');
                byteEqual(module.tileBytes(gpu), module.tileBytes(cpu), s.name);
                gpuCases++;
              } finally {
                placement.dispose();
                world.dispose();
              }
            }
            for (const s of flowCases) {
              const cpu = module.hydrology(s.grid, s.options),
                gpu = await module.hydrologyGPU(device, s.grid, s.options);
              byteEqual(module.flowBytes(gpu), module.flowBytes(cpu), s.name);
              gpuCases++;
            }
            // J5 GPU fields feed J5 GPU classification in the same exact-head functional pipeline.
            const fieldCases = module.fieldIntegrationCases();
            if (fieldCases.length !== 2) throw new Error('J5 integration matrix changed');
            for (const spec of fieldCases) {
              const frame = module.frameFor(module, spec),
                r = spec.rectangles[0];
              const cpu = module.rectFields(frame, r.ox, r.oz, r.width, r.depth, module.fieldNames);
              const gpu = await module.rectFieldsGPU(device, frame, r.ox, r.oz, r.width, r.depth, module.fieldNames);
              for (const [name, layer] of cpu) equal(gpu.get(name).data, layer.data, 'field ' + name);
              const c = module.classifier([module.presets.temperate, module.presets.boreal], 'envelopes', []);
              const input = {
                n: r.width,
                depth: r.depth,
                gx: r.ox,
                gz: r.oz,
                cell: spec.cell,
                seed: spec.seed,
                user: () => undefined,
                layer: (name) => gpu.get(name)?.data,
              };
              const cpuInput = { ...input, layer: (name) => cpu.get(name)?.data };
              const n = (r.width - 2) * (r.depth - 2) * 4,
                ids = new Uint8Array(n),
                weights = new Uint8Array(n),
                expectedIds = new Uint8Array(n),
                expectedWeights = new Uint8Array(n);
              module.classify(c, cpuInput, expectedIds, expectedWeights);
              await module.classifyGPU(device, c, input, ids, weights);
              equal(ids, expectedIds, 'GPU field classification ids');
              equal(weights, expectedWeights, 'GPU field classification weights');
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
        assert.match(adapter, /NVIDIA.*RTX A6000\b/i, 'Selected adapter must be the NVIDIA RTX A6000');
        console.log(`Placement and flow WebGPU selected adapter: ${JSON.stringify(proof.identity)}`);
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
