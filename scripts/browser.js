import { chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { watchWgsl, wgslGuard } from './support/wgsl-guard.js';

/**
 * Starts a server on a fixed port with `start` (for example `() => server.listen()`), waiting while something else holds
 * the port: GPU suites share the GPU (scripts/gpu-lock.mjs, 3 slots), so two suites that use the same port can run at
 * once and the second waits for the first to close its server. Other errors are thrown as they are; past `waitMs`
 * (default 20 min, a shared GPU hold's limit) it throws naming the port.
 */
export async function listenWhenFree(start, { port, waitMs = 20 * 60_000, poll = 1000, log = console.error } = {}) {
  const begun = Date.now();
  for (let told = false; ; ) {
    try {
      return await start();
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && !/already in use/i.test(error?.message ?? '')) throw error;
      if (Date.now() - begun > waitMs)
        throw new Error(
          `port ${port} stayed in use for ${Math.round((Date.now() - begun) / 1000)} s; find what holds it (netstat -ano | findstr :${port}) and stop it`,
          { cause: error },
        );
      if (!told) log(`port ${port} is in use, most likely by another GPU suite sharing the GPU; waiting for it`);
      told = true;
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }
}

/**
 * Page init script for a slow shader compiler: `createRenderPipelineAsync` and `createComputePipelineAsync` resolve
 * `ms` later than the GPU finishes them, and `createRenderPipeline` and `createComputePipeline` hold the calling thread
 * `ms` longer (the real pipelines, unchanged; errors pass through). An integrated GPU's driver can take far longer
 * than this PC's to compile, so a check that waits a fixed time or number of frames for a pipeline, instead of its
 * readiness, fails here too. `openBrowser({ pipelineDelayMs })`, MARGO_PIPELINE_DELAY_MS or `--pipeline-delay=<ms>` on
 * the suite's command line (the `test:gpu:slow-compile` scripts).
 */
export function delayPipelines(ms) {
  if (typeof GPUDevice === 'undefined') return;
  for (const name of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (...args) {
      return original
        .apply(this, args)
        .then((pipeline) => new Promise((resolve) => setTimeout(() => resolve(pipeline), ms)));
    };
  }
  for (const name of ['createRenderPipeline', 'createComputePipeline']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (...args) {
      const pipeline = original.apply(this, args),
        until = performance.now() + ms;
      while (performance.now() < until) {
        // Busy: a synchronous compile blocks the thread that asked for it.
      }
      return pipeline;
    };
  }
}

/**
 * Page init script for a GPU whose builtin maths is as far off as WGSL allows: every shader module's calls of the
 * builtins below are rewritten to return a value off by `scale` times the specification's error bound (WGSL 15.8,
 * "Floating point accuracy"), deterministically: sin and cos 2^-11 absolute, tan the same relatively (within the bound
 * it inherits from sin / cos), asin and acos 6.77e-5 absolute, atan and atan2 4095 ulp, exp and exp2 3 ulp, log and
 * log2 2^-23 absolute, sqrt and inverseSqrt 4 and 2 ulp. An Intel Arc 140V is 1.1e-5 off for sin near 1.5
 * where this PC's RTX A6000 is within 3e-7, so a check that leans on one GPU's builtins passes here and fails there;
 * with this it fails here too. `openBrowser({ mathErrorScale })`, MARGO_SPEC_MATH_ERROR or `--spec-math-error=<scale>`
 * (the `:spec-math` scripts; 1 = the bound).
 */
export function perturbBuiltinMath(scale) {
  if (typeof GPUDevice === 'undefined') return;
  globalThis.__margoSpecMathError = scale;
  const u = 2 ** -24,
    // name -> [factor, absolute term]: the result becomes builtin * factor + absolute.
    rules = {
      sin: [1 - scale * 2 ** -11, 0],
      cos: [1 - scale * 2 ** -11, 0],
      tan: [1 + scale * 2 ** -11, 0],
      asin: [1 - (scale * 6.77e-5) / (Math.PI / 2), 0],
      acos: [1 - (scale * 6.77e-5) / Math.PI, 0],
      atan: [1 + scale * 4095 * u, 0],
      atan2: [1 + scale * 4095 * u, 0],
      exp: [1 + scale * 3 * u, 0],
      exp2: [1 + scale * 3 * u, 0],
      // 2^-23 absolute: inside 2^-21 on [0.5, 2] and inside 3 ulp elsewhere (|log x| >= 0.69 there).
      log: [1, scale * 2 ** -23],
      log2: [1, scale * 2 ** -23],
      sqrt: [1 + scale * 4 * u, 0],
      inverseSqrt: [1 + scale * 2 * u, 0],
    };
  const pattern = new RegExp(`(?<![\\w.])(${Object.keys(rules).join('|')})\\s*\\(`, 'g');
  const literal = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));
  const rewrite = (code) => {
    // Comments go first, so a parenthesis in one cannot pair with code.
    const src = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
    let out = '',
      last = 0;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(src); m; m = pattern.exec(src)) {
      if (/\bfn\s+$/.test(src.slice(Math.max(0, m.index - 8), m.index))) continue;
      let depth = 1,
        j = m.index + m[0].length;
      for (; j < src.length && depth > 0; j++) depth += src[j] === '(' ? 1 : src[j] === ')' ? -1 : 0;
      const call = src.slice(m.index, j),
        [factor, absolute] = rules[m[1]],
        // The call's arguments are rewritten too (nested builtins).
        inner = rewrite(call.slice(m[0].length, -1));
      out += `${src.slice(last, m.index)}(${m[1]}(${inner}) * ${literal(factor)}${absolute ? ` + ${literal(absolute)}` : ''})`;
      last = j;
      pattern.lastIndex = j;
    }
    return out + src.slice(last);
  };
  const original = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    return original.call(this, { ...descriptor, code: rewrite(descriptor.code) });
  };
}

export async function openBrowser({
  browserName = 'chromium',
  channel = process.env.BROWSER_CHANNEL ?? 'msedge',
  args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [],
  powerPreference = process.env.GPU_POWER ?? 'high-performance',
  firefoxUserPrefs = {},
  startPath = '/tests/modern.html',
  aliases = {},
  plugins = [],
  headless = true,
  port = 5193,
  pipelineDelayMs = Number(
    process.env.MARGO_PIPELINE_DELAY_MS ??
      process.argv.find((a) => a.startsWith('--pipeline-delay='))?.slice('--pipeline-delay='.length) ??
      0,
  ),
  mathErrorScale = Number(
    process.env.MARGO_SPEC_MATH_ERROR ??
      process.argv.find((a) => a.startsWith('--spec-math-error='))?.slice('--spec-math-error='.length) ??
      0,
  ),
} = {}) {
  await mkdir('test-results', { recursive: true });
  const server = await createServer({
    resolve: { alias: aliases },
    plugins,
    optimizeDeps: { entries: [startPath.replace(/^\//, '')] },
    // No file watcher: its first crawl of the repository (and every worktree under it) blocked this process for
    // 30-140 s on a busy machine, so the first page load timed out ("Preparing the citadel...", gate 9).
    server: { host: '127.0.0.1', port, strictPort: true, watch: null },
    logLevel: 'error',
  });
  await listenWhenFree(() => server.listen(), { port });
  let browser;
  try {
    if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new TypeError('Unsupported browser');
    if (browserName === 'chromium') {
      try {
        browser = await chromium.launch({ channel: channel === 'bundled' ? undefined : channel, args, headless });
      } catch (error) {
        if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error;
        browser = await chromium.launch({ headless });
      }
    } else
      browser = await { firefox, webkit }[browserName].launch({
        headless,
        ...(browserName === 'firefox' ? { firefoxUserPrefs } : {}),
      });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);
    // Every shader module the page creates is compiled for diagnostics; close() fails on a WGSL error.
    await page.addInitScript(wgslGuard);
    if (pipelineDelayMs > 0) await page.addInitScript(delayPipelines, pipelineDelayMs);
    if (mathErrorScale > 0) await page.addInitScript(perturbBuiltinMath, mathErrorScale);
    const wgsl = watchWgsl(page);
    let reloads = 0,
      handledReloads = 0;
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        try {
          if (JSON.parse(String(payload)).type === 'full-reload') reloads++;
        } catch {
          // Other application sockets may send non-JSON messages.
        }
      }),
    );
    await page.goto(`http://127.0.0.1:${server.config.server.port}${startPath}`);
    const probeHardware = () =>
      page.evaluate(async (powerPreference) => {
        const canvas = document.createElement('canvas'),
          gl = canvas.getContext('webgl2', { powerPreference }),
          ext = gl?.getExtension('WEBGL_debug_renderer_info');
        const webgl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference });
        const gpu = adapter?.info;
        return {
          webglRenderer: webgl,
          webgpu: gpu
            ? {
                vendor: gpu.vendor,
                architecture: gpu.architecture,
                device: gpu.device,
                description: gpu.description,
                fallback: gpu.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
              }
            : null,
          userAgent: navigator.userAgent,
        };
      }, powerPreference);
    let hardware;
    for (let attempt = 0; ; attempt++) {
      try {
        hardware = await probeHardware();
        break;
      } catch (error) {
        // Vite may finish a newly discovered dependency batch after the initial load event.
        // Retry only that confirmed startup reload, never product navigation or adapter errors.
        if (attempt >= 2 || reloads === handledReloads || !String(error).includes('Execution context was destroyed'))
          throw error;
        handledReloads = reloads;
        await page.waitForLoadState('load');
        await server.waitForRequestsIdle();
      }
    }
    hardware.browserName = browserName;
    hardware.browserVersion = browser.version();
    hardware.requestedChannel = browserName === 'chromium' ? channel : null;
    hardware.launchArgs = browserName === 'chromium' ? args : [];
    hardware.powerPreference = powerPreference;
    hardware.hostPlatform = process.platform;
    hardware.headless = headless;
    if (pipelineDelayMs > 0) hardware.pipelineDelayMs = pipelineDelayMs;
    if (mathErrorScale > 0) hardware.mathErrorScale = mathErrorScale;
    if (browserName === 'firefox') hardware.firefoxUserPrefs = firefoxUserPrefs;
    if (process.env.GPU_VENDOR) {
      assert.ok(
        hardware.webglRenderer?.toLowerCase().includes(process.env.GPU_VENDOR.toLowerCase()),
        'WebGL used the wrong physical adapter',
      );
      assert.equal(
        hardware.webgpu?.vendor,
        process.env.GPU_VENDOR.toLowerCase(),
        'WebGPU used the wrong physical adapter',
      );
      assert.equal(hardware.webgpu.fallback, false, 'Software WebGPU adapter selected');
    }
    return {
      page,
      hardware,
      wgsl,
      async close() {
        // Compilation info arrives asynchronously: let the last reports in before reading them.
        await page.evaluate(() => new Promise((r) => setTimeout(r, 200))).catch(() => {});
        await browser.close();
        await server.close();
        if (wgsl.modules.size)
          console.log(`WGSL: ${wgsl.modules.size} distinct shader modules compiled, ${wgsl.errors.length} errors`);
        if (wgsl.errors.length) throw new Error(`WGSL compile errors:\n${wgsl.errors.slice(0, 20).join('\n')}`);
        if (wgsl.unexpected.length)
          throw new Error(`WGSL modules labelled expect-error compiled cleanly: ${wgsl.unexpected.join(', ')}`);
      },
    };
  } catch (error) {
    await browser?.close();
    await server.close();
    throw error;
  }
}
