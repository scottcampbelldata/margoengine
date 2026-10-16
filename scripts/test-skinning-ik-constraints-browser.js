import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openBrowser} from './browser.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const app = await openBrowser({startPath: '/tests/modern.html', channel: 'msedge', args: [], port: 5217,
  aliases: {'@margoengine/kinematics-constraints': resolve('packages/kinematics-constraints/dist/index.js')}});
const errors = [], resourceErrors = [], packageRequests = new Set();
app.page.on('pageerror', error => errors.push(error.stack ?? error.message));
app.page.on('response', response => {
  if (response.url().includes('kinematics-constraints')) packageRequests.add(new URL(response.url()).pathname);
  if (response.status() >= 400 && !new URL(response.url()).pathname.endsWith('/favicon.ico')) resourceErrors.push({url: response.url(), status: response.status()});
});
const report = {hardware: app.hardware, errors, resourceErrors, cases: []};
const separation = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

async function metrics() {
  return app.page.evaluate(() => JSON.parse(document.querySelector('#viewport').dataset.metrics));
}
async function frames(count) {
  const before = await metrics();
  await app.page.waitForFunction(minimum => {
    const text = document.querySelector('#viewport').dataset.metrics;
    return text && JSON.parse(text).animationFrames >= minimum;
  }, before.animationFrames + count);
  return metrics();
}
function validate(value, label) {
  for (const key of ['orb', 'desiredOrb', 'gripCenter', 'wrist', 'camera']) {
    assert.ok(Array.isArray(value[key]) && value[key].length === 3 && value[key].every(Number.isFinite), `${label}: invalid ${key}`);
  }
  assert.ok(Number.isFinite(value.gripError) && value.gripError < 1e-5, `${label}: orb lost its palm attachment (${value.gripError})`);
  assert.ok(separation(value.orb, value.gripCenter) < 1e-5, `${label}: visible orb differs from palm grip`);
  assert.equal(value.arm.safe, true, `${label}: full mesh/body contact oracle rejected the presented pose`);
  for (const key of ['shoulder', 'elbow', 'wrist']) assert.ok(value.arm[key].every(Number.isFinite), `${label}: invalid arm ${key}`);
  assert.ok(Number.isFinite(value.residual) && value.residual >= 0, `${label}: invalid residual`);
  return value;
}
function project(point, eye, look, bounds) {
  const f = look.map((value, i) => value - eye[i]), length = Math.hypot(...f);
  for (let i = 0; i < 3; i++) f[i] /= length;
  const rLength = Math.hypot(f[0], f[2]), r = [-f[2] / rLength, 0, f[0] / rLength];
  const u = [-r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1]];
  const p = point.map((value, i) => value - eye[i]), dot = vector => p.reduce((sum, value, i) => sum + value * vector[i], 0);
  const depth = dot(f), tangent = Math.tan(35 * Math.PI / 360);
  assert.ok(depth > 0, 'Drag point is behind the camera');
  return {x: bounds.x + bounds.width * (0.5 + dot(r) / (depth * tangent * bounds.width / bounds.height) * 0.5),
    y: bounds.y + bounds.height * (0.5 - dot(u) / (depth * tangent) * 0.5)};
}

try {
  assert.match(app.hardware.userAgent, /Edg\//, 'Run the real Edge browser');
  assert.equal(app.hardware.webgpu?.fallback, false, 'Use the physical GPU adapter');
  assert.doesNotMatch(app.hardware.webglRenderer ?? '', /swiftshader|warp|llvmpipe/i);
  // Attach listeners before navigating to the actual scene so startup failures
  // are included. Suppress development reloads during this deterministic run.
  await app.page.route('**/@vite/client', route => route.fulfill({contentType: 'application/javascript', body: '// HMR disabled during browser regression.\n'}));
  await app.page.goto(new URL('/examples/skinning-ik.html', app.page.url()).href);
  await app.page.waitForFunction(() => document.querySelector('#viewport').dataset.ready === 'true' || document.querySelector('#error').textContent);
  assert.equal(await app.page.locator('#error').textContent(), '');
  assert.equal(await app.page.locator('#viewport').getAttribute('data-constraint-solver'), '@margoengine/kinematics-constraints');
  await app.page.waitForFunction(() => document.querySelector('#viewport').dataset.metrics);
  await app.page.locator('details.advanced > summary').click();
  for (const id of ['idle', 'moving-light', 'look', 'autopilot', 'follow']) await app.page.locator(`#${id}`).uncheck();
  const home = validate(await frames(12), 'home');
  report.cases.push({name: 'home', metrics: home});

  for (const pose of ['high', 'front', 'wide', 'back', 'home']) {
    await app.page.locator(`[data-pose="${pose}"]`).click();
    const value = validate(await frames(48), `preset ${pose}`);
    if (pose === 'high') {
      assert.ok(value.desiredOrb[1] > home.desiredOrb[1] + 0.4, 'Overhead preset must request a raised orb');
      assert.ok(value.orb[1] > home.orb[1] + 0.1, 'The held orb should rise with the overhead preset');
    }
    report.cases.push({name: `preset-${pose}`, metrics: value});
  }

  for (const x of [-0.5, -0.2, 0.1, 0.4, 0.65]) {
    await app.page.evaluate(x => {
      for (const [axis, value] of [['x', x], ['y', -0.1], ['z', -0.25]]) {
        const input = document.querySelector(`#target-${axis}`); input.value = String(value); input.dispatchEvent(new Event('input', {bubbles: true}));
      }
    }, x);
    report.cases.push({name: `cross-front-${x}`, metrics: validate(await frames(18), `cross-front ${x}`)});
  }

  await app.page.locator('[data-pose="back"]').click();
  await frames(48);
  await app.page.locator('#view-room').click();
  const beforeDrag = validate(await frames(12), 'before pointer drag');
  const bounds = await app.page.locator('#viewport canvas').boundingBox();
  assert.ok(bounds);
  const look = [0.05, 0.58, 0.04], start = project(beforeDrag.orb, beforeDrag.camera, look, bounds);
  const throughTorso = project([0.08, 0.95, 0.025], beforeDrag.camera, look, bounds);
  for (const point of [start, throughTorso]) assert.ok(point.x > bounds.x && point.x < bounds.x + bounds.width && point.y > bounds.y && point.y < bounds.y + bounds.height, 'The drag path must be visible');
  await app.page.mouse.move(start.x, start.y);
  await app.page.mouse.down();
  await app.page.waitForFunction(() => JSON.parse(document.querySelector('#viewport').dataset.metrics).dragging === true, null, {timeout: 3000});
  const dragSamples = [];
  let previousSample = beforeDrag, previousAt = performance.now();
  const pointerMotion = {maximumOrbStep: 0, maximumElbowStep: 0, maximumSampledOrbSpeed: 0, maximumSampledElbowSpeed: 0, maximumRollingMeanFrameMs: 0, maximumRollingP95FrameMs: 0};
  for (let i = 1; i <= 16; i++) {
    await app.page.mouse.move(start.x + (throughTorso.x - start.x) * i / 16, start.y + (throughTorso.y - start.y) * i / 16);
    const value = validate(await frames(2), `pointer drag ${i}`);
    assert.equal(value.dragging, true); assert.equal(value.orbitEnabled, false);
    const now = performance.now(), seconds = Math.max(1e-6, (now - previousAt) / 1000);
    const orbStep = separation(value.orb, previousSample.orb), elbowStep = separation(value.arm.elbow, previousSample.arm.elbow);
    pointerMotion.maximumOrbStep = Math.max(pointerMotion.maximumOrbStep, orbStep);
    pointerMotion.maximumElbowStep = Math.max(pointerMotion.maximumElbowStep, elbowStep);
    pointerMotion.maximumSampledOrbSpeed = Math.max(pointerMotion.maximumSampledOrbSpeed, orbStep / seconds);
    pointerMotion.maximumSampledElbowSpeed = Math.max(pointerMotion.maximumSampledElbowSpeed, elbowStep / seconds);
    pointerMotion.maximumRollingMeanFrameMs = Math.max(pointerMotion.maximumRollingMeanFrameMs, value.performance.frameMs);
    pointerMotion.maximumRollingP95FrameMs = Math.max(pointerMotion.maximumRollingP95FrameMs, value.performance.p95Ms);
    previousSample = value; previousAt = now;
    dragSamples.push(value);
  }
  await app.page.mouse.up();
  const afterDrag = validate(await frames(24), 'released pointer drag');
  assert.equal(afterDrag.dragging, false); assert.equal(afterDrag.orbitEnabled, true);
  assert.ok(separation(afterDrag.desiredOrb, beforeDrag.desiredOrb) > 0.06, 'Trusted pointer input must move the independent orb target');
  assert.ok(pointerMotion.maximumOrbStep < 0.15 && pointerMotion.maximumElbowStep < 0.35, 'The sampled arm must not teleport during the torso drag');
  assert.ok(pointerMotion.maximumSampledOrbSpeed < 8 && pointerMotion.maximumSampledElbowSpeed < 15, 'The sampled arm displacement rate must stay bounded');
  assert.ok(pointerMotion.maximumRollingP95FrameMs < 1000, 'The scene must continue presenting frames during the drag');
  const contactSamples = dragSamples.filter(value => value.arm.bodyContact);
  assert.ok(contactSamples.length >= 2, 'The pointer path must exercise the torso boundary');
  const contactProgress = separation(contactSamples[0].orb, contactSamples.at(-1).orb);
  assert.ok(contactProgress > 0.015, 'The securely held orb must continue moving along the body boundary during contact');
  report.cases.push({name: 'trusted-pointer-through-torso', before: beforeDrag, samples: dragSamples, after: afterDrag, motion: pointerMotion,
    contact: {samples: contactSamples.length, progress: contactProgress, firstOrb: contactSamples[0].orb, lastOrb: contactSamples.at(-1).orb},
    interpretation: 'Motion is sampled after pointer steps and at least two real frames. Frame metrics are the maximum rolling mean and rolling p95 observed in those samples, not single-frame maxima or a universal jank guarantee.'});
  await app.page.screenshot({path: 'test-results/skinning-ik-constraints-browser.png', fullPage: true});

  const beforeReflections = validate(await frames(6), 'before reflection cadence');
  await app.page.waitForFunction(previous => {
    const value = JSON.parse(document.querySelector('#viewport').dataset.metrics);
    return value.reflections >= previous + 2;
  }, beforeReflections.reflections);
  const afterReflections = validate(await metrics(), 'after reflection cadence');
  const cadence = {frames: afterReflections.frames - beforeReflections.frames,
    realFrames: afterReflections.animationFrames - beforeReflections.animationFrames,
    poseUpdates: afterReflections.poseUpdates - beforeReflections.poseUpdates,
    captures: afterReflections.reflections - beforeReflections.reflections};
  assert.ok(cadence.frames > cadence.realFrames, 'The test must actually observe extra zero-delta reflection renders');
  assert.ok(cadence.poseUpdates <= cadence.realFrames, 'Reflection renders must not advance the presented IK pose');
  report.cases.push({name: 'reflection-zero-delta', cadence});

  await app.page.locator('#auto-ik').uncheck();
  const frozen = validate(await frames(6), 'manual pose before reflections');
  await app.page.waitForFunction(previous => JSON.parse(document.querySelector('#viewport').dataset.metrics).reflections >= previous + 2, frozen.reflections);
  const still = validate(await metrics(), 'manual pose after reflections');
  assert.equal(still.poseUpdates, frozen.poseUpdates, 'Manual pose must not solve during reflection captures');
  assert.ok(separation(still.arm.elbow, frozen.arm.elbow) < 1e-6);
  assert.ok(separation(still.arm.wrist, frozen.arm.wrist) < 1e-6);
  report.cases.push({name: 'manual-reflection-hold', before: frozen, after: still});
  assert.ok(packageRequests.size > 0, 'The browser must actually load the constraints package');
  assert.equal(await app.page.locator('#error').textContent(), '');
  assert.deepEqual(errors, []); assert.deepEqual(resourceErrors, []);
} finally {
  report.packageRequests = [...packageRequests];
  await writeFile('test-results/skinning-ik-constraints-browser.json', JSON.stringify(report, null, 2));
  await app.close();
}
console.log(JSON.stringify({hardware: report.hardware, cases: report.cases.map(value => value.name), errors, resourceErrors,
  packageRequests: report.packageRequests, pointerMotion: report.cases.find(value => value.name === 'trusted-pointer-through-torso')?.motion,
  reflectionCadence: report.cases.find(value => value.name === 'reflection-zero-delta')?.cadence}));
