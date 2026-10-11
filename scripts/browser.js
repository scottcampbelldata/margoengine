import { chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function openBrowser({ browserName = 'chromium', channel = process.env.BROWSER_CHANNEL ?? 'msedge', args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [], powerPreference = process.env.GPU_POWER ?? 'high-performance', firefoxUserPrefs = {}, startPath = '/tests/modern.html', aliases = {} } = {}) {
  await mkdir('test-results', { recursive: true });
  const server = await createServer({ resolve: {alias:aliases}, server: { host: '127.0.0.1', port: 5193, strictPort: true }, logLevel: 'error' }); await server.listen();
  let browser;
  try {
    if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new TypeError('Unsupported browser');
    if (browserName === 'chromium') { try { browser = await chromium.launch({ channel: channel === 'bundled' ? undefined : channel, args, headless: true }); } catch (error) { if (channel !== 'msedge' || args.length) throw error; browser = await chromium.launch({ headless: true }); } }
    else browser = await ({ firefox, webkit })[browserName].launch({ headless: true, ...(browserName === 'firefox' ? { firefoxUserPrefs } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000); await page.goto(`http://127.0.0.1:5193${startPath}`);
    const hardware = await page.evaluate(async powerPreference => {
      const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2', { powerPreference }), ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const webgl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER); gl?.getExtension('WEBGL_lose_context')?.loseContext();
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference }); const gpu = adapter?.info;
      return { webglRenderer: webgl, webgpu: gpu ? { vendor: gpu.vendor, architecture: gpu.architecture, device: gpu.device, description: gpu.description, fallback: gpu.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null } : null, userAgent: navigator.userAgent };
    }, powerPreference);
    hardware.browserName = browserName; hardware.browserVersion = browser.version(); hardware.requestedChannel = browserName === 'chromium' ? channel : null; hardware.launchArgs = browserName === 'chromium' ? args : []; hardware.powerPreference = powerPreference;
    hardware.hostPlatform = process.platform; if (browserName === 'firefox') hardware.firefoxUserPrefs = firefoxUserPrefs;
    if (process.env.GPU_VENDOR) {
      assert.ok(hardware.webglRenderer?.toLowerCase().includes(process.env.GPU_VENDOR.toLowerCase()), 'WebGL used the wrong physical adapter');
      assert.equal(hardware.webgpu?.vendor, process.env.GPU_VENDOR.toLowerCase(), 'WebGPU used the wrong physical adapter');
      assert.equal(hardware.webgpu.fallback, false, 'Software WebGPU adapter selected');
    }
    return { page, hardware, async close() { await browser.close(); await server.close(); } };
  } catch (error) { await browser?.close(); await server.close(); throw error; }
}
