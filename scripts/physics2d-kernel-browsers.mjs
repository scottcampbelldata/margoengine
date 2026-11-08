// The own 2D physics kernel as it ships, Wasm with simd128, in real browsers (`npm run test:physics2d-kernel-browsers`):
//   1. in the Chromium-family browser the GPU suites use (`default`: Edge or Chrome with WebGPU) and Firefox, a page drawing with WebGPU and a page drawing with the WebGL2 fallback each step the
//      pinned-bits scenes of packages/physics2d/kernel/tests/bits.rs between frames, and every scene must give the
//      native hashes: the physics is the same whichever renderer the page uses (the 3D kernel's replay proof,
//      packages/physics/scripts/test-replay.js, is the model). Playwright's Firefox has no WebGPU; its WebGPU page is
//      reported as not run, never as passed, and REPLAY_FIREFOX names a Firefox with WebGPU to run it in.
//   2. on the WebGPU page of each browser (WebGL2 in a browser without it), the 100-row pyramid is timed in this kernel
//      and in Rapier 2D's Wasm build (@dimforge/rapier2d-compat), taking turns in one page (--rounds=, default 8): the
//      fastest of 40 steps after 60, per round, compared by per-round minimums (AGENTS.md). The page is cross-origin
//      isolated so the browsers' timers resolve microseconds. BOX2D_WASM=<path to box2d3-pyramid.mjs> adds Box2D v3's
//      Wasm build to the turns: a black box built outside the repository with the official emsdk (its own CMake
//      project; the harness and build script are in physics-refs, docs/whitepaper/reproduce.md), served read-only.
// The pages are WebGPU users, so the run takes the GPU lock. Writes test-results/physics2d-kernel-browsers.json.
// `npm run test:physics2d-kernel-browsers` (a ROOT suite of scripts/gpu-package-tests.mjs, so check:merge runs it) is
// part 1 in the default browser, with no timing; the full run, Firefox and the timing too, is the script itself:
//   [BOX2D_WASM=...] node scripts/physics2d-kernel-browsers.mjs [--browsers=default,firefox] [--rounds=8]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'vite';
import { acquire } from './gpu-lock.mjs';
import { launchBrowser, resolveBrowser } from './lib/browser.mjs';
import { WASM_RUSTFLAGS, wasmBuildArgs, wasmModule } from './support/wasm-kernel.mjs';
import { closeAll } from './support/shutdown.mjs';

const root = resolve(import.meta.dirname, '..'),
  check = 'packages/physics2d/kernel/wasm-check/Cargo.toml',
  arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
  browsers = (arg('browsers') ?? 'default,firefox').split(','),
  rounds = Number(arg('rounds') ?? 8);
if (!(rounds >= 0)) throw new RangeError(`--rounds must be 0 or more, got ${arg('rounds')}`);

execFileSync('cargo', wasmBuildArgs(check), { cwd: root, stdio: 'inherit', timeout: 20 * 60_000, env: { ...process.env, RUSTFLAGS: WASM_RUSTFLAGS } });
const module = `/${wasmModule(check, await readFile(join(root, check), 'utf8'))}`;
const rapier = '/node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs';
const rapierVersion = JSON.parse(await readFile(join(root, 'node_modules/@dimforge/rapier2d-compat/package.json'), 'utf8')).version;
const box2dPath = process.env.BOX2D_WASM ? resolve(process.env.BOX2D_WASM) : undefined;
const box2d = box2dPath ? `/@fs/${box2dPath.replaceAll('\\', '/')}` : undefined;

const release = await acquire({ owner: 'physics2d-kernel-browsers' });
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: {
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [root, ...(box2dPath ? [dirname(box2dPath)] : [])] },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
});
const report = { module: module.slice(1), rustflags: WASM_RUSTFLAGS, rapier2d: rapierVersion, box2d: box2dPath ? 'v3.2.0 Wasm (BOX2D_WASM)' : 'not run', runs: [] };
let failed = 0;
try {
  await server.listen();
  const page = `${server.resolvedUrls.local[0]}packages/physics2d/tests/kernel-wasm.html`;
  for (const name of browsers) {
    const executablePath = name === 'firefox' ? process.env.REPLAY_FIREFOX : undefined;
    const browser = await launchBrowser({ ...(name === 'default' ? {} : { name }), needs: name === 'firefox' ? 'none' : 'webgpu', headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const probe = await browser.newPage();
      await probe.goto(page);
      const hasWebGPU = await probe.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())));
      await probe.close();
      for (const backend of ['webgpu', 'webgl2']) {
        const shown = name === 'default' ? resolveBrowser({}).name : name,
          label = `${shown} ${browser.version()} ${backend}`;
        if (backend === 'webgpu' && !hasWebGPU) {
          console.log(`${label}: NOT RUN, this browser has no WebGPU adapter`);
          report.runs.push({ browser: shown, version: browser.version(), backend, run: false });
          continue;
        }
        const tab = await browser.newPage(),
          errors = [];
        tab.on('pageerror', (error) => errors.push(error.message));
        await tab.goto(page);
        await tab.waitForFunction(() => typeof window.runKernel === 'function', null, { timeout: 60_000 });
        const timed = backend === (hasWebGPU ? 'webgpu' : 'webgl2') ? rounds : 0;
        const result = await tab.evaluate((o) => window.runKernel(o), { backend, module, rapier, box2d, rounds: timed });
        await tab.close();
        try {
          assert.deepEqual(errors, []);
          assert.equal(result.backend, backend, `${label}: the page drew with ${result.backend}`);
          for (const c of result.checks) assert.ok(c.pass, `${label}: scene ${c.check} stepped to ${c.bits}, not the native hash`);
          console.log(`${label}: ${result.checks.length} pinned-bits scenes equal to native`);
        } catch (error) {
          failed++;
          console.log(`${label}: FAIL ${error.message}`);
        }
        if (result.times.length) {
          const margo = Math.min(...result.times.map((t) => t.margo)),
            rapier2d = Math.min(...result.times.map((t) => t.rapier2d)),
            faster = result.times.filter((t) => t.margo < t.rapier2d).length;
          console.log(
            `${label}: 100-row pyramid step, best of ${result.times.length} rounds: Margo ${margo.toFixed(2)} ms, Rapier 2D ${rapierVersion} ${rapier2d.toFixed(2)} ms (Margo faster in ${faster} rounds)`,
          );
          if (box2d) {
            const box2d3 = Math.min(...result.times.map((t) => t.box2d)),
              ahead = result.times.filter((t) => t.margo < t.box2d).length,
              tops = result.times.map((t) => t.box2dTop);
            assert.ok(tops.every((y) => y > 98 && y < 100), `${label}: Box2D's top box ended at ${tops}, not near 99.5 m`);
            console.log(`${label}: Box2D v3 Wasm ${box2d3.toFixed(2)} ms (Margo faster in ${ahead} rounds)`);
          }
        }
        report.runs.push({ browser: shown, version: browser.version(), backend, run: true, ...result });
      }
    } finally {
      await closeAll({ browser });
    }
  }
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results/physics2d-kernel-browsers.json'), JSON.stringify(report, null, 2));
} finally {
  await closeAll({ servers: [server] });
  await release();
}
process.exitCode = failed ? 1 : 0;
