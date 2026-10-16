import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readGLB, validate, validator, toolsDir } from '../tests/helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {
    browser = await chromium.launch({
      headless: true,
      channel: channel === 'bundled' ? undefined : channel,
      executablePath: process.env.BROWSER_EXECUTABLE,
      args,
    });
  } catch (error) {
    if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error;
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/exporters.html`);
  await page.waitForFunction(() => typeof window.runExporterTests === 'function');
  const report = await page.evaluate(() => window.runExporterTests());
  assert.deepEqual(
    errors.filter((error) => !/^Failed to load resource/.test(error)),
    [],
  );

  // Every glTF the browser exported must pass the Khronos validator with zero errors and zero warnings.
  assert.ok(
    validator,
    `gltf-validator is not installed in ${toolsDir}; run npm install gltf-validator there or set MARGOENGINE_EXPORTERS_TOOLS`,
  );
  report.validator = {};
  for (const [name, data] of [
    ['glb', Uint8Array.from(report.glb)],
    ['gltf', report.gltf],
    ['flat', Uint8Array.from(report.flat)],
  ]) {
    const result = await validate(data);
    assert.equal(result.errors, 0, `${name}: ${JSON.stringify(result.messages)}`);
    assert.equal(result.warnings, 0, `${name}: ${JSON.stringify(result.messages)}`);
    report.validator[name] = { errors: result.errors, warnings: result.warnings, infos: result.infos };
  }
  const { json } = readGLB(Uint8Array.from(report.glb));
  assert.deepEqual(
    json.nodes.map((n) => n.name),
    ['base', 'arm', 'pivot', 'hand', 'other'],
  );
  assert.equal(json.meshes.length, 2);
  assert.equal(json.materials.length, 2);
  assert.equal(json.accessors.length, 3);
  report.checks.push(
    'Browser-exported GLB, glTF and flattened GLB pass the Khronos validator with 0 errors and 0 warnings',
  );
  report.browser = browser.version();
  report.glbBytes = report.glb.length;
  delete report.glb;
  delete report.flat;
  delete report.gltf;
  await writeFile(resolve(results, 'exporters-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
