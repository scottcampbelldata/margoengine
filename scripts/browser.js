import { chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { watchWgsl, wgslGuard } from './support/wgsl-guard.js';

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
  await server.listen();
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
      },
    };
  } catch (error) {
    await browser?.close();
    await server.close();
    throw error;
  }
}
