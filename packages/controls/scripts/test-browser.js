import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

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
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({
    headless: true,
    args,
  });
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
  // OrbitControls turns PI per element height since the clean-room rewrite (3a1b76cf): 50 / 400 px is PI / 8.
  near(rotated.azimuth, -Math.PI / 8, 1e-6, 'drag of 50 px on a 400 px canvas orbits by PI/8');
  near(rotated.centroid[0], rotated.expected[0], 4, 'rotated image: box x');
  near(rotated.centroid[1], rotated.expected[1], 4, 'rotated image: box y');
  assert.ok(
    Math.hypot(rotated.centroid[0] - start.centroid[0], rotated.centroid[1] - start.centroid[1]) > 10 ||
      Math.abs(rotated.area - start.area) > start.area * 0.2,
    `box moved in the image ${JSON.stringify([start, rotated])}`,
  );
  checks.push(
    `Orbit drag rotates the rendered view (box centroid ${start.centroid.map(Math.round)} -> ${rotated.centroid.map(Math.round)})`,
  );
  await page.mouse.move(...at(200, 200));
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
  // Wait for the dolly itself (the wheel is applied on a frame), not for 50 ms.
  await page.waitForFunction(
    (distance) => Math.abs(window.measure().distance - distance) < 1e-6,
    6 * 2 ** (-600 / 500),
    {
      timeout: 10_000,
    },
  );
  const zoomed = await page.evaluate(() => window.measure());
  // 500 px of wheel halve the distance (3a1b76cf): three -200 px notches are 2^(-600/500).
  near(zoomed.distance, 6 * 2 ** (-600 / 500), 1e-6, 'wheel dollies in');
  assert.ok(zoomed.area > rotated.area * 1.3, `zoom enlarges the box (${rotated.area} -> ${zoomed.area})`);
  checks.push(
    `Wheel zoom dollies to ${zoomed.distance.toFixed(3)} and the box grows from ${rotated.area} to ${zoomed.area} px`,
  );

  // TransformControls gizmo.
  const gizmo = await page.evaluate(() => window.setupGizmo());
  assert.equal(gizmo.insideWithout, 'mesh');
  assert.equal(gizmo.insideWith, 'red', 'X arrow drawn on top of the mesh');
  assert.ok(
    gizmo.countsWith.red > 150 && gizmo.countsWith.green > 150,
    `aligned gizmo colors ${JSON.stringify(gizmo.countsWith)}`,
  );
  assert.equal(gizmo.countsWithout.red, 0);
  const occlude = await page.evaluate(() => window.gizmoOcclude());
  assert.ok(
    occlude.hidden.red === 0 && occlude.hidden.green === 0 && occlude.onTop.red > 150 && occlude.open.red > 0,
    `occlude ${JSON.stringify(occlude)}`,
  );
  checks.push('WebGPU: occlude hides the gizmo behind a wall, and off draws it on top again');
  const rings = await page.evaluate(() => window.arcballGizmo());
  assert.ok(rings.shown.red > 100 && rings.shown.green > 100, `arcball rings ${JSON.stringify(rings)}`);
  assert.ok(rings.hidden.red === 0 && rings.hidden.green === 0, `arcball autoHide ${JSON.stringify(rings)}`);
  checks.push('WebGPU: the arcball rings draw, and autoHide leaves the frame clean');
  const aligned = await page.evaluate(() => window.gizmoView());
  assert.equal(aligned.axisDots[2], 1);
  assert.equal(aligned.handles.includes('Z'), false, 'camera-aligned Z arrow is deliberately hidden');
  let oblique;
  try {
    oblique = await page.evaluate(() => window.gizmoView([6, 4, 6]));
    for (const view of [aligned, oblique]) {
      assert.equal(view.axis, null);
      assert.equal(view.dragging, false);
      assert.equal(view.mode, 'translate');
      assert.equal(view.space, 'world');
      assert.equal(view.visible, true);
      assert.deepEqual(view.show, [true, true, true]);
    }
    assert.ok(oblique.axisDots.every((dot) => dot < 0.99));
    for (const axis of ['X', 'Y', 'Z']) assert.ok(oblique.handles.includes(axis));
    assert.ok(
      oblique.counts.red > 150 && oblique.counts.green > 150 && oblique.counts.blue > 100,
      `oblique gizmo colors ${JSON.stringify(oblique.counts)}`,
    );
    assert.ok(oblique.zArrowPixels.includes('blue'), 'Z arrow rasterizes beyond the blue XY plane');
    await page.locator('#gpu').screenshot({ path: resolve(results, 'gizmo-oblique.png') });
  } finally {
    const restored = await page.evaluate(() => window.gizmoView());
    assert.deepEqual(restored, aligned, 'original camera, handles and rendered counts restored before dragging');
  }
  report.gizmoViews = { aligned, oblique };
  checks.push('Gizmo renders over the mesh; aligned Z hides, and the oblique view renders all three colored arrows');
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
    if (mode === 'scale') {
      const scaled = await page.evaluate(() => window.gizmoView([6, 4, 6]));
      assert.ok(
        ['XY', 'YZ', 'XZ'].some((plane) => scaled.handles.includes(plane)),
        `scale mode offers plane handles ${scaled.handles}`,
      );
      assert.ok(
        scaled.counts.red + scaled.counts.yellow > 100 && scaled.counts.green > 100 && scaled.counts.blue > 100,
        `scale gizmo with plane handles renders ${JSON.stringify(scaled.counts)}`,
      );
      checks.push(`Scale gizmo draws axis and plane handles (${scaled.handles.join(', ')})`);
    }
  }
  const end = await page.evaluate(() => window.finish());
  assert.ok(end.before > 0);
  assert.equal(end.after, 0, 'all canvas listeners removed');
  assert.equal(end.plugin, false, 'overlay plugin removed');
  assert.equal(end.counts.red + end.counts.yellow + end.counts.green + end.counts.blue, 0, 'gizmo gone after dispose');
  assert.deepEqual(end.errors, [], 'no WebGPU validation errors');
  checks.push(`Dispose removes ${end.before} canvas listeners and the overlay pass; zero WebGPU validation errors`);

  report.webgl2 = await page.evaluate(() => window.runGL());
  assert.ok(
    report.webgl2.shown.red > 150 && report.webgl2.hidden.red === 0,
    `WebGL2 overlay ${JSON.stringify(report.webgl2)}`,
  );
  checks.push('WebGL2 backend draws the same gizmo overlay and removes it on dispose');
  assert.ok(
    report.webgl2.occluded.red === 0 && report.webgl2.onTop.red > 150,
    `WebGL2 occlude ${JSON.stringify(report.webgl2)}`,
  );
  checks.push('WebGL2: occlude hides the gizmo behind a wall, and off draws it on top again');

  // ArcballControls with real mouse input on its own WebGPU canvas (400 x 400 CSS px, camera 6 units from the target).
  await page.locator('#arc').scrollIntoViewIfNeeded();
  const arc0 = await page.evaluate(() => window.setupArcball());
  assert.equal(arc0.backend, 'webgpu');
  const arcAt = (x, y) => [arc0.left + x, arc0.top + y];
  const arcball = (report.arcball = { start: arc0 });
  near(arc0.redCentroid[0], arc0.marker[0], 1.5, 'arcball marker renders where projected (x)');
  near(arc0.redCentroid[1], arc0.marker[1], 1.5, 'arcball marker renders where projected (y)');
  // 1. A left drag of 80 px across the centre (ball radius 200 px) turns by 2 asin(40 / 200) about screen up.
  await page.mouse.move(...arcAt(160, 200));
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(...arcAt(160 + i * 10, 200));
  await page.mouse.up();
  const turned = (arcball.rotate = await page.evaluate(() => window.arcballState()));
  const expectedTurn = 2 * Math.asin(40 / 200);
  near(turned.azimuth, expectedTurn, 1e-9, 'arcball drag turns by the angle between the ball points');
  near(turned.distance, 6, 1e-9, 'arcball drag keeps the distance');
  near(turned.position[1], 0, 1e-9, 'arcball drag about screen up stays level');
  near(turned.redCentroid[0], turned.marker[0], 1.5, 'turned image: marker x');
  near(turned.redCentroid[1], turned.marker[1], 1.5, 'turned image: marker y');
  assert.ok(
    Math.abs(turned.redCentroid[0] - arc0.redCentroid[0]) > 5,
    `marker moved in the rendered image ${JSON.stringify([arc0.redCentroid, turned.redCentroid])}`,
  );
  checks.push(
    `Arcball drag of 80 px turns the view ${turned.azimuth.toFixed(9)} rad (expected ${expectedTurn.toFixed(9)}); rendered marker ${arc0.redCentroid.map((v) => v.toFixed(1))} -> ${turned.redCentroid.map((v) => v.toFixed(1))}`,
  );
  // 2. A right drag pans: the grabbed marker pixel stays under the cursor.
  await page.evaluate(() => window.arcballReset());
  const grab = (await page.evaluate(() => window.arcballState())).marker,
    drop = [grab[0] + 60, grab[1] - 40];
  await page.mouse.move(...arcAt(...grab));
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 6; i++) await page.mouse.move(...arcAt(grab[0] + i * 10, grab[1] - (i * 20) / 3));
  await page.mouse.up({ button: 'right' });
  const panned = (arcball.pan = await page.evaluate(([x, y]) => window.arcballState(x, y), drop));
  near(panned.marker[0], drop[0], 1e-3, 'pan: grabbed point projects under the cursor (x)');
  near(panned.marker[1], drop[1], 1e-3, 'pan: grabbed point projects under the cursor (y)');
  near(panned.redCentroid[0], drop[0], 1.5, 'pan: rendered marker under the cursor (x)');
  near(panned.redCentroid[1], drop[1], 1.5, 'pan: rendered marker under the cursor (y)');
  assert.equal(panned.picked, 'marker', 'engine.pick at the cursor finds the grabbed marker');
  near(panned.distance, 6, 1e-9, 'pan keeps the distance');
  checks.push(
    `Arcball right drag (+60, -40) px keeps the grabbed marker under the cursor: projected ${panned.marker.map((v) => v.toFixed(4))}, rendered ${panned.redCentroid.map((v) => v.toFixed(2))}, pick = ${panned.picked}`,
  );
  // 3. Wheel zoom toward the cursor keeps the point under it.
  await page.evaluate(() => window.arcballReset());
  // Wheel events carry whole CSS pixels here, so the cursor goes to the marker's pixel rounded, and the check follows
  // the world point under that pixel.
  const cursor = (await page.evaluate(() => window.arcballState())).marker.map(Math.round),
    anchor = await page.evaluate((at) => window.arcballUnder(at), cursor);
  await page.mouse.move(...arcAt(...cursor));
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => window.controlsState.arc.wheels.length === 3);
  const zoomedArc = (arcball.zoom = await page.evaluate(([x, y]) => window.arcballState(x, y), cursor));
  const wheelPixels = zoomedArc.wheels.reduce(
    (sum, [deltaY, mode]) => sum + deltaY * (mode === 1 ? 100 / 3 : mode === 2 ? 800 : 1),
    0,
  );
  near(zoomedArc.distance, 6 * 2 ** (wheelPixels / 500), 1e-9, 'wheel zoom scales the distance');
  assert.ok(zoomedArc.distance < 6, 'wheel up zooms in');
  const anchorAfter = (arcball.zoomAnchor = await page.evaluate((point) => window.arcballProject(point), anchor));
  near(anchorAfter[0], cursor[0], 1e-3, 'zoom: cursor point fixed (x)');
  near(anchorAfter[1], cursor[1], 1e-3, 'zoom: cursor point fixed (y)');
  near(zoomedArc.redCentroid[0], cursor[0], 1.5, 'zoom: rendered marker under the cursor (x)');
  near(zoomedArc.redCentroid[1], cursor[1], 1.5, 'zoom: rendered marker under the cursor (y)');
  assert.equal(zoomedArc.picked, 'marker');
  checks.push(
    `Arcball wheel (${wheelPixels} px) zooms to distance ${zoomedArc.distance.toFixed(4)} with the point under the cursor ${cursor} still at ${anchorAfter.map((v) => v.toFixed(4))}, rendered ${zoomedArc.redCentroid.map((v) => v.toFixed(2))}, pick = ${zoomedArc.picked}`,
  );
  // 4. Damping: a fling keeps turning after release, slows every frame, and settles on the undamped total.
  await page.evaluate(() => window.arcballReset(true));
  await page.mouse.move(...arcAt(180, 200));
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(...arcAt(180 + i * 10, 200));
  await page.mouse.up();
  const settled = await page.evaluate(() => window.arcballSettle());
  arcball.damping = { frames: settled.steps.length, creep: settled.creep, azimuth: settled.azimuth };
  assert.ok(settled.steps.length > 30 && settled.steps.length < 3000, `settles in ${settled.steps.length} frames`);
  for (let i = 1; i < settled.steps.length - 1; i++)
    assert.ok(settled.steps[i] < settled.steps[i - 1], `damped motion slows at frame ${i}`);
  assert.equal(settled.creep, 0, 'nothing pending after it settles');
  near(settled.azimuth, 2 * Math.asin(20 / 200), 1e-9, 'damped fling ends at the undamped angle');
  checks.push(
    `Arcball damping settles in ${settled.steps.length} frames at ${settled.azimuth.toFixed(9)} rad (undamped ${(2 * Math.asin(20 / 200)).toFixed(9)}), then 0 creep`,
  );
  // 5. Dispose removes every canvas listener and the update plugin; later drags do nothing.
  const arcEnd = (arcball.dispose = await page.evaluate(() => window.arcballFinish()));
  assert.ok(arcEnd.before > 0);
  assert.equal(arcEnd.after, 0, 'arcball canvas listeners removed');
  assert.deepEqual([arcEnd.pluginBefore, arcEnd.pluginAfter], [1, 0], 'arcball plugin removed');
  const still = (await page.evaluate(() => window.arcballState())).position;
  await page.mouse.move(...arcAt(150, 150));
  await page.mouse.down();
  await page.mouse.move(...arcAt(250, 250));
  await page.mouse.up();
  assert.deepEqual((await page.evaluate(() => window.arcballState())).position, still, 'no motion after dispose');
  assert.deepEqual(arcEnd.errors, [], 'no WebGPU validation errors on the arcball engine');
  await page.evaluate(() => window.arcballDisposeEngine());
  checks.push(
    `Arcball dispose removes ${arcEnd.before} canvas listeners (${arcEnd.after} left) and its update plugin; a later drag moves nothing; zero WebGPU validation errors`,
  );

  await page.screenshot({ path: resolve(results, 'controls.png') });
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'controls-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${checks.length} browser checks passed`);
} finally {
  await closeAll({ browser, servers: [server] });
}
