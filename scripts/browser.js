import { chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function openBrowser({
  browserName = 'chromium',
  channel = process.env.BROWSER_CHANNEL ?? 'msedge',
  args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [],
  powerPreference = process.env.GPU_POWER ?? 'high-performance',
  firefoxUserPrefs = {},
  startPath = '/tests/modern.html',
  aliases = {},
  headless = true,
  port = 5193,
} = {}) {
  await mkdir('test-results', { recursive: true });
  const server = await createServer({
    resolve: { alias: aliases },
    optimizeDeps: { entries: [startPath.replace(/^\//, '')] },
    server: { host: '127.0.0.1', port, strictPort: true },
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
    let reloads = 0, handledReloads = 0;
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      try {
        if (JSON.parse(String(payload)).type === 'full-reload') reloads++;
      } catch {
        // Other application sockets may send non-JSON messages.
      }
    }));
    await page.goto(`http://127.0.0.1:${server.config.server.port}${startPath}`);
    const probeHardware = () => page.evaluate(async (powerPreference) => {
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
        if (attempt >= 2 || reloads === handledReloads || !String(error).includes('Execution context was destroyed')) throw error;
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
      async close() {
        await browser.close();
        await server.close();
      },
    };
  } catch (error) {
    await browser?.close();
    await server.close();
    throw error;
  }
}
