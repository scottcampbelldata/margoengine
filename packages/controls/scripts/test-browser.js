import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

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
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: expected ${b} +/- ${tolerance}, got ${a}`);
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
  const page = await browser.newPage({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 1 });
  const errors = [],
    checks = [],
    report = { checks };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/controls.html`);
  await page.waitForFunction(() => typeof window.setupOrbit === 'function');

  // OrbitControls with real mouse input.
  const start = await page.evaluate(() => window.setupOrbit());
  assert.equal(start.backend, 'webgpu');
  const at = (x, y) => [start.left + x, start.top + y];
  near(start.centroid[0], start.expected[0], 3, 'box renders where projected');
  await page.mouse.move(...at(100, 330));
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(...at(100 + i * 10, 330));
  await page.mouse.up();
  const rotated = await page.evaluate(() => window.measure());
  near(rotated.azimuth, -Math.PI / 4, 1e-6, 'drag of 50 px on a 400 px canvas orbits by PI/4');
  near(rotated.centroid[0], rotated.expected[0], 4, 'rotated image: box x');
  near(rotated.centroid[1], rotated.expected[1], 4, 'rotated image: box y');
  assert.ok(
    Math.hypot(rotated.centroid[0] - start.centroid[0], rotated.centroid[1] - start.centroid[1]) > 20 ||
      Math.abs(rotated.area - start.area) > start.area * 0.2,
    `box moved in the image ${JSON.stringify([start, rotated])}`,
  );
  checks.push(
    `Orbit drag rotates the rendered view (box centroid ${start.centroid.map(Math.round)} -> ${rotated.centroid.map(Math.round)})`,
  );
  await page.mouse.move(...at(200, 200));
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(50);
  const zoomed = await page.evaluate(() => window.measure());
  near(zoomed.distance, 6 * 0.95 ** 6, 1e-6, 'wheel dollies in');
  assert.ok(zoomed.area > rotated.area * 1.3, `zoom enlarges the box (${rotated.area} -> ${zoomed.area})`);
  checks.push(
    `Wheel zoom dollies to ${zoomed.distance.toFixed(3)} and the box grows from ${rotated.area} to ${zoomed.area} px`,
  );

  // TransformControls gizmo.
  const gizmo = await page.evaluate(() => window.setupGizmo());
  assert.equal(gizmo.insideWithout, 'mesh');
  assert.equal(gizmo.insideWith, 'red', 'X arrow drawn on top of the mesh');
  assert.ok(
    gizmo.countsWith.red > 150 && gizmo.countsWith.green > 150 && gizmo.countsWith.blue > 100,
    `gizmo colors ${JSON.stringify(gizmo.countsWith)}`,
  );
  assert.equal(gizmo.countsWithout.red, 0);
  checks.push('Gizmo renders on top of the mesh (red X arrow over mesh pixels; red, green and blue handles visible)');
  await page.mouse.move(...at(gizmo.arrow[0], gizmo.arrow[1]));
  const hovered = await page.evaluate(() => window.gizmoState());
  assert.equal(hovered.axis, 'X');
  assert.ok(
    hovered.counts.yellow > 100 && hovered.counts.red < gizmo.countsWith.red / 3,
    `hover highlight ${JSON.stringify(hovered.counts)}`,
  );
  await page.locator('#gpu').screenshot({ path: resolve(results, 'gizmo-hover.png') });
  checks.push(`Hover highlights the X arrow (${hovered.counts.yellow} yellow px)`);
  const startCentroid = (await page.evaluate(() => window.gizmoState())).centroid;
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(...at(gizmo.arrow[0] + i * 10, gizmo.arrow[1] + i));
  const during = await page.evaluate(() => window.gizmoState());
  assert.equal(during.dragging, true);
  assert.equal(during.orbitEnabled, false);
  await page.mouse.up();
  const moved = await page.evaluate(() => window.gizmoState());
  near(moved.position[0], 100 / gizmo.pixelsPerUnit, 0.01, 'mesh moved along X by the dragged distance');
  near(moved.position[1], 0, 1e-9, 'no Y motion');
  near(moved.position[2], 0, 1e-9, 'no Z motion');
  near(moved.expected[0] - 200, 100, 1, 'mesh center projects 100 px right');
  near(
    moved.centroid[0] - startCentroid[0],
    100,
    6,
    'rendered box moved about 100 px right (its side face shows in perspective)',
  );
  near(moved.centroid[1], startCentroid[1], 1, 'rendered box stayed level');
  assert.deepEqual(moved.camera, hovered.camera, 'orbit stayed still during the gizmo drag');
  assert.deepEqual(moved.events, [true, false]);
  assert.equal(moved.orbitEnabled, true);
  checks.push(
    `Dragging the X arrow 100 px moves the mesh ${moved.position[0].toFixed(4)} units (expected ${(100 / gizmo.pixelsPerUnit).toFixed(4)}) and the rendered box ${(moved.centroid[0] - startCentroid[0]).toFixed(1)} px`,
  );

  for (const mode of ['rotate', 'scale']) {
    await page.evaluate((m) => {
      window.controlsState.gizmo.setMode(m);
      window.controlsState.gizmo.setSpace('local');
      window.controlsState.mesh.setRotation([0.4, 0.6, 0]);
      window.controlsState.engine.render();
    }, mode);
    await page.locator('#gpu').screenshot({ path: resolve(results, `gizmo-${mode}.png`) });
  }
  const end = await page.evaluate(() => window.finish());
  assert.ok(end.before > 0);
  assert.equal(end.after, 0, 'all canvas listeners removed');
  assert.equal(end.plugin, false, 'overlay plugin removed');
  assert.equal(end.counts.red + end.counts.yellow + end.counts.green, 0, 'gizmo gone after dispose');
  assert.deepEqual(end.errors, [], 'no WebGPU validation errors');
  checks.push(`Dispose removes ${end.before} canvas listeners and the overlay pass; zero WebGPU validation errors`);

  report.webgl2 = await page.evaluate(() => window.runGL());
  assert.ok(
    report.webgl2.shown.red > 150 && report.webgl2.hidden.red === 0,
    `WebGL2 overlay ${JSON.stringify(report.webgl2)}`,
  );
  checks.push('WebGL2 backend draws the same gizmo overlay and removes it on dispose');

  await page.screenshot({ path: resolve(results, 'controls.png') });
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'controls-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${checks.length} browser checks passed`);
} finally {
  await browser?.close();
  await server.close();
}
