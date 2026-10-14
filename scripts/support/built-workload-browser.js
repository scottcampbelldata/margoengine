import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';
import {chromium} from '@playwright/test';
import {preview} from 'vite';

/** Static preview only; dependencies and workers are already assembled before any measured context starts. */
export async function openBrowser({channel = process.env.BROWSER_CHANNEL ?? 'msedge', args = [], headless = false,
  powerPreference = process.env.GPU_POWER ?? 'high-performance'} = {}) {
  assert.ok(process.env.WORKLOAD_BUILT_DIR, 'Built workload directory was not supplied');
  const directory = resolve(process.env.WORKLOAD_BUILT_DIR), path = relative(resolve('test-results'), directory);
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), 'Artifact must be inside test-results');
  const artifact = JSON.parse(await readFile(resolve(directory, 'workload-build.json'), 'utf8'));
  assert.equal(artifact.productionPackages, true); assert.equal(artifact.sourceFallback, false);
  let server, browser;
  try {
    server = await preview({configFile: false, root: directory, build: {outDir: directory}, preview: {host: '127.0.0.1', port: 0}, logLevel: 'error'});
    browser = await chromium.launch({channel: channel === 'bundled' ? undefined : channel, args, headless});
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}, deviceScaleFactor: 1});
    await page.goto(new URL('/hardware.html', server.resolvedUrls.local[0]).href);
    const hardware = await page.evaluate(async powerPreference => {
      const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2', {powerPreference}), extension = gl?.getExtension('WEBGL_debug_renderer_info');
      const webglRenderer = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      const adapter = await navigator.gpu?.requestAdapter({powerPreference}), info = adapter?.info;
      return {webglRenderer, webgpu: info ? {vendor: info.vendor, architecture: info.architecture, device: info.device,
        description: info.description, fallback: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null} : null, userAgent: navigator.userAgent};
    }, powerPreference);
    Object.assign(hardware, {browserName: 'chromium', browserVersion: browser.version(), requestedChannel: channel, launchArgs: args, powerPreference,
      hostPlatform: process.platform, headless});
    if (process.env.GPU_VENDOR) {
      assert.ok(hardware.webglRenderer?.toLowerCase().includes(process.env.GPU_VENDOR.toLowerCase()));
      assert.equal(hardware.webgpu?.vendor, process.env.GPU_VENDOR.toLowerCase()); assert.equal(hardware.webgpu.fallback, false);
    }
    return {page, hardware, artifact, async close() {try {await browser.close();} finally {await new Promise(done => server.httpServer.close(done));}}};
  } catch (error) {try {await browser?.close();} finally {if (server) await new Promise(done => server.httpServer.close(done));} throw error;}
}
