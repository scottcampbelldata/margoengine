import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { mapArmControl, nearestArmControlParameter } from '../examples/skinning-ik/arm-controls.ts';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const app = await openBrowser({
  startPath: '/tests/modern.html',
  channel: 'msedge',
  args: [],
  port: 5217,
  aliases: { '@margoengine/kinematics-constraints': resolve('packages/kinematics-constraints/dist/index.js') },
});
const errors = [],
  resourceErrors = [],
  packageRequests = new Set();
app.page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
app.page.on('response', (response) => {
  if (response.url().includes('kinematics-constraints')) packageRequests.add(new URL(response.url()).pathname);
  if (response.status() >= 400 && !new URL(response.url()).pathname.endsWith('/favicon.ico'))
    resourceErrors.push({ url: response.url(), status: response.status() });
});
const report = { hardware: app.hardware, errors, resourceErrors, cases: [] };
const separation = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
let referenceLengths;

async function metrics() {
  return app.page.evaluate(() => JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics')));
}
async function frames(count) {
  const before = await metrics();
  await app.page.waitForFunction((minimum) => {
    const text = document.querySelector('#viewport').readWorkshopDiagnostics('metrics');
    return text && JSON.parse(text).animationFrames >= minimum;
  }, before.animationFrames + count);
  return metrics();
}
function validate(value, label) {
  for (const key of ['orb', 'desiredOrb', 'gripCenter', 'wrist', 'camera']) {
    assert.ok(
      Array.isArray(value[key]) && value[key].length === 3 && value[key].every(Number.isFinite),
      `${label}: invalid ${key}`,
    );
  }
  assert.ok(
    Number.isFinite(value.gripError) && value.gripError < 1e-5,
    `${label}: orb lost its palm attachment (${value.gripError})`,
  );
  assert.ok(separation(value.orb, value.gripCenter) < 1e-5, `${label}: visible orb differs from palm grip`);
  assert.equal(value.arm.safe, true, `${label}: full mesh/body contact oracle rejected the presented pose`);
  for (const key of ['shoulder', 'elbow', 'wrist'])
    assert.ok(value.arm[key].every(Number.isFinite), `${label}: invalid arm ${key}`);
  if (referenceLengths) {
    assert.ok(
      Math.abs(separation(value.arm.shoulder, value.arm.elbow) - referenceLengths[0]) < 2e-5,
      `${label}: upper arm stretched`,
    );
    assert.ok(
      Math.abs(separation(value.arm.elbow, value.arm.wrist) - referenceLengths[1]) < 2e-5,
      `${label}: forearm stretched`,
    );
  }
  assert.ok(
    value.torso && ['yaw', 'desiredYaw', 'maxYaw'].every((key) => Number.isFinite(value.torso[key])),
    `${label}: missing torso diagnostics`,
  );
  assert.ok(
    value.torso.maxYaw <= 0.85 && Math.abs(value.torso.yaw) <= value.torso.maxYaw + 1e-6,
    `${label}: torso yaw exceeded its mechanical travel`,
  );
  assert.ok(Math.abs(value.torso.desiredYaw) <= value.torso.maxYaw + 1e-6);
  assert.ok(Number.isFinite(value.residual) && value.residual >= 0, `${label}: invalid residual`);
  return value;
}
function validateEyes(value, label, requireUnclamped = false) {
  const head = value.head;
  assert.ok(
    head && head.opticalOrigin?.length === 3 && head.opticalOrigin.every(Number.isFinite),
    `${label}: missing optical origin`,
  );
  assert.ok(head.forward?.length === 3 && head.forward.every(Number.isFinite), `${label}: invalid optical forward`);
  assert.ok(Math.abs(Math.hypot(...head.forward) - 1) < 2e-6, `${label}: optical direction must be normalized`);
  assert.equal(typeof head.limited, 'boolean');
  assert.ok(
    Number.isFinite(head.angle) && head.angle >= 0 && head.angle <= 1.3 + 1e-6,
    `${label}: neck travel exceeded`,
  );
  const d = value.orb.map((coordinate, i) => coordinate - head.opticalOrigin[i]),
    f = head.forward;
  const along = d.reduce((sum, coordinate, i) => sum + coordinate * f[i], 0);
  const cross = Math.hypot(d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]);
  const rayDistance = along < 0 ? Math.hypot(...d) : cross,
    rayError = Math.atan2(cross, along);
  assert.ok(
    Math.abs(head.rayDistance - rayDistance) < 3e-6,
    `${label}: optical miss diagnostic differs from the actual held orb`,
  );
  assert.ok(
    Math.abs(head.rayError - rayError) < 3e-5,
    `${label}: optical angle diagnostic differs from the actual held orb`,
  );
  if (requireUnclamped)
    assert.equal(head.limited, false, `${label}: ordinary front target should be within neck travel`);
  if (!head.limited) {
    assert.ok(rayDistance < 1e-5, `${label}: eyes miss the held orb by ${rayDistance} m`);
    assert.ok(rayError < 3e-5, `${label}: eyes aim away from the held orb`);
  }
  return { rayDistance, rayError, limited: head.limited, angle: head.angle };
}
function project(point, eye, look, bounds) {
  const f = look.map((value, i) => value - eye[i]),
    length = Math.hypot(...f);
  for (let i = 0; i < 3; i++) f[i] /= length;
  const rLength = Math.hypot(f[0], f[2]),
    r = [-f[2] / rLength, 0, f[0] / rLength];
  const u = [-r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1]];
  const p = point.map((value, i) => value - eye[i]),
    dot = (vector) => p.reduce((sum, value, i) => sum + value * vector[i], 0);
  const depth = dot(f),
    tangent = Math.tan((35 * Math.PI) / 360);
  assert.ok(depth > 0, 'Drag point is behind the camera');
  return {
    x: bounds.x + bounds.width * (0.5 + (dot(r) / ((depth * tangent * bounds.width) / bounds.height)) * 0.5),
    y: bounds.y + bounds.height * (0.5 - (dot(u) / (depth * tangent)) * 0.5),
  };
}

try {
  assert.match(app.hardware.userAgent, /Edg\//, 'Run the real Edge browser');
  assert.equal(app.hardware.webgpu?.fallback, false, 'Use the physical GPU adapter');
  assert.doesNotMatch(app.hardware.webglRenderer ?? '', /swiftshader|warp|llvmpipe/i);
  // Attach listeners before navigating to the actual scene so startup failures
  // are included. Suppress development reloads during this deterministic run.
  await app.page.route('**/@vite/client', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '// HMR disabled during browser regression.\n' }),
  );
  await app.page.goto(new URL('/examples/skinning-ik.html', app.page.url()).href);
  await app.page.waitForFunction(
    () => document.querySelector('#viewport').dataset.ready === 'true' || document.querySelector('#error').textContent,
  );
  assert.equal(await app.page.locator('#error').textContent(), '');
  assert.equal(
    await app.page.locator('#viewport').getAttribute('data-constraint-solver'),
    '@margoengine/kinematics-constraints',
  );
  await app.page.waitForFunction(() => typeof document.querySelector('#viewport').readWorkshopDiagnostics === 'function');
  await app.page.locator('details.advanced > summary').click();
  for (const id of ['idle', 'moving-light', 'look', 'autopilot', 'follow']) await app.page.locator(`#${id}`).uncheck();
  const home = validate(await frames(12), 'home');
  referenceLengths = [separation(home.arm.shoulder, home.arm.elbow), separation(home.arm.elbow, home.arm.wrist)];
  for (const axis of ['x', 'y', 'z']) {
    const input = await app.page
      .locator(`#target-${axis}`)
      .evaluate((element) => ({ min: element.min, max: element.max, value: element.valueAsNumber }));
    assert.equal(Number(input.min), 0);
    assert.equal(Number(input.max), 1);
    assert.ok(Math.abs(input.value - 0.5) < 1e-6);
  }
  report.cases.push({ name: 'home', metrics: home });

  for (const pose of ['high', 'front', 'wide', 'back', 'home']) {
    await app.page.locator(`[data-pose="${pose}"]`).click();
    const value = validate(await frames(48), `preset ${pose}`);
    if (pose === 'high') {
      assert.ok(value.desiredOrb[1] > home.desiredOrb[1] + 0.4, 'Overhead preset must request a raised orb');
      assert.ok(value.orb[1] > home.orb[1] + 0.1, 'The held orb should rise with the overhead preset');
    }
    report.cases.push({ name: `preset-${pose}`, metrics: value });
  }

  await app.page.locator('#look').check();
  for (const [axis, control] of [
    ['y', 'height'],
    ['z', 'nearFar'],
    ['x', 'side'],
  ]) {
    const samples = [];
    for (let step = 0; step <= 20; step++) {
      const parameter = step <= 10 ? step / 10 : (20 - step) / 10;
      await app.page.evaluate(
        ({ axis, parameter }) => {
          const input = document.querySelector(`#target-${axis}`);
          input.value = String(parameter);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        },
        { axis, parameter },
      );
      const expected = mapArmControl(control, parameter);
      await frames(6);
      await app.page.waitForFunction(
        (expected) => {
          const value = JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics'));
          const distance = (point) => Math.hypot(...point.map((coordinate, i) => coordinate - expected[i]));
          return (
            distance(value.desiredOrb) < 2e-6 &&
            distance(value.orb) < 0.002 &&
            Math.abs(value.torso.yaw - value.torso.desiredYaw) < 5e-5
          );
        },
        expected,
        { timeout: 6000 },
      );
      const value = validate(await metrics(), `${control} slider ${parameter}`);
      const eyeAim = validateEyes(value, `${control} slider eye aim ${parameter}`);
      assert.ok(
        separation(value.desiredOrb, expected) < 2e-6,
        `${control}: the active slider must select its full track independently of the other readouts`,
      );
      assert.ok(separation(value.orb, expected) < 0.002, `${control}: the whole normalized range must be reachable`);
      const readouts = await app.page.evaluate(() =>
        ['x', 'y', 'z'].map((axis) => document.querySelector(`#target-${axis}`).valueAsNumber),
      );
      for (const [index, other] of ['side', 'height', 'nearFar'].entries()) {
        assert.ok(
          Math.abs(readouts[index] - nearestArmControlParameter(other, value.desiredOrb)) < 0.006,
          `${control} ${parameter}: ${other} readout ${readouts[index]} must reflect current target parameter ${nearestArmControlParameter(other, value.desiredOrb)}`,
        );
      }
      samples.push({ parameter, metrics: value, readouts, eyeAim });
      if (step === 10 && (control === 'height' || control === 'side'))
        await app.page.screenshot({ path: `test-results/skinning-ik-slider-${control}.png`, fullPage: true });
    }
    const beginning = samples[0].metrics,
      end = samples[10].metrics;
    if (control === 'height') {
      assert.ok(beginning.wrist[1] < beginning.arm.shoulder[1] - 0.49, 'Height must lower the hand to its own side');
      assert.ok(end.wrist[1] > end.arm.shoulder[1] + 0.52, 'Height must raise the hand fully overhead');
    }
    if (control === 'side') {
      assert.ok(
        beginning.orb[0] < -0.75 && end.orb[0] > 0.234,
        'Side must sweep through the front to the opposite torso edge',
      );
      assert.ok(
        Math.abs(end.orb[1] - 1.16) < 0.002 && end.orb[2] < -0.298,
        'Opposite-side reach stays in front at chest height',
      );
      assert.ok(end.torso.yaw < -0.8, 'Opposite-side reach uses bounded torso assistance');
    }
    if (control === 'nearFar') {
      const reach = (value) => separation(value.arm.shoulder, value.wrist);
      assert.ok(reach(end) > reach(beginning) + 0.23, 'Near and far must visibly fold and extend the elbow');
      assert.ok(end.orb[2] < -0.49, 'Far must extend the held orb in front');
    }
    report.cases.push({
      name: `slider-${control}-forward-reverse`,
      samples,
      geometryLimit:
        control === 'side'
          ? 'The model-local target spans x=-0.76 to +0.235 m in front of the chest. Torso assistance turns the shoulder and collision frame together, capped at 0.85 rad; bone lengths stay authored.'
          : undefined,
    });
  }

  await app.page.locator('#look').check();
  const eyeSamples = [];
  for (const pose of ['home', 'front', 'high', 'back', 'home']) {
    await app.page.locator(`[data-pose="${pose}"]`).click();
    const value = validate(await frames(18), `eye aim ${pose}`);
    eyeSamples.push({
      pose,
      metrics: value,
      independentlyMeasured: validateEyes(value, `eye aim ${pose}`),
    });
  }
  // The fixed-frame samples above deliberately interrupt movement. In the
  // existing back-to-home route the hand may still be near the waist after
  // eighteen frames; strict endpoint gaze belongs to the settled target.
  const settledEyes = [];
  for (const pose of ['home', 'front']) {
    await app.page.locator(`[data-pose="${pose}"]`).click();
    const before = await metrics();
    await app.page.waitForFunction((previousFrame) => {
      const value = JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics'));
      return value.animationFrames > previousFrame && value.targetMotion.settled && !value.targetMotion.routing &&
        Math.abs(value.torso.yaw - value.torso.desiredYaw) < 5e-5;
    }, before.animationFrames, { timeout: 6000 });
    const value = validate(await metrics(), `settled eye aim ${pose}`);
    settledEyes.push({
      pose,
      metrics: value,
      independentlyMeasured: validateEyes(value, `settled eye aim ${pose}`, true),
    });
  }
  await app.page.waitForFunction(() => {
    const value = JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics'));
    return Math.abs(value.torso.yaw - value.torso.desiredYaw) < 5e-8;
  });
  const eyeBefore = validate(await frames(6), 'settled eye aim'),
    eyeAfter = validate(await frames(48), 'stationary eye aim');
  validateEyes(eyeAfter, 'stationary eye aim', true);
  assert.ok(
    separation(eyeBefore.head.forward, eyeAfter.head.forward) < 1e-6,
    'Stationary and reflection updates must not accumulate head rotation',
  );
  report.cases.push({ name: 'optical-eye-aim', samples: eyeSamples, settled: settledEyes, stationaryAfter: eyeAfter });
  await app.page.locator('#look').uncheck();

  await app.page.locator('[data-pose="back"]').click();
  await frames(48);
  await app.page.locator('#view-room').click();
  const beforeDrag = validate(await frames(12), 'before pointer drag');
  const bounds = await app.page.locator('#viewport canvas').boundingBox();
  assert.ok(bounds);
  const look = beforeDrag.cameraTarget,
    start = project(beforeDrag.orb, beforeDrag.camera, look, bounds);
  const throughTorso = project([0.08, 0.95, 0.025], beforeDrag.camera, look, bounds);
  for (const point of [start, throughTorso])
    assert.ok(
      point.x > bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y > bounds.y &&
        point.y < bounds.y + bounds.height,
      'The drag path must be visible',
    );
  await app.page.mouse.move(start.x, start.y);
  await app.page.mouse.down();
  await app.page.waitForFunction(
    () => JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics')).dragging === true,
    null,
    { timeout: 3000 },
  );
  const dragSamples = [];
  let previousSample = beforeDrag,
    previousAt = performance.now();
  const pointerMotion = {
    maximumOrbStep: 0,
    maximumElbowStep: 0,
    maximumSampledOrbSpeed: 0,
    maximumSampledElbowSpeed: 0,
    maximumRollingMeanFrameMs: 0,
    maximumRollingP95FrameMs: 0,
  };
  for (let i = 1; i <= 16; i++) {
    await app.page.mouse.move(
      start.x + ((throughTorso.x - start.x) * i) / 16,
      start.y + ((throughTorso.y - start.y) * i) / 16,
    );
    const value = validate(await frames(2), `pointer drag ${i}`);
    assert.equal(value.dragging, true);
    assert.equal(value.orbitEnabled, false);
    const now = performance.now(),
      seconds = Math.max(1e-6, (now - previousAt) / 1000);
    const orbStep = separation(value.orb, previousSample.orb),
      elbowStep = separation(value.arm.elbow, previousSample.arm.elbow);
    pointerMotion.maximumOrbStep = Math.max(pointerMotion.maximumOrbStep, orbStep);
    pointerMotion.maximumElbowStep = Math.max(pointerMotion.maximumElbowStep, elbowStep);
    pointerMotion.maximumSampledOrbSpeed = Math.max(pointerMotion.maximumSampledOrbSpeed, orbStep / seconds);
    pointerMotion.maximumSampledElbowSpeed = Math.max(pointerMotion.maximumSampledElbowSpeed, elbowStep / seconds);
    pointerMotion.maximumRollingMeanFrameMs = Math.max(
      pointerMotion.maximumRollingMeanFrameMs,
      value.performance.frameMs,
    );
    pointerMotion.maximumRollingP95FrameMs = Math.max(pointerMotion.maximumRollingP95FrameMs, value.performance.p95Ms);
    previousSample = value;
    previousAt = now;
    dragSamples.push(value);
  }
  await app.page.mouse.up();
  const afterDrag = validate(await frames(24), 'released pointer drag');
  assert.equal(afterDrag.dragging, false);
  assert.equal(afterDrag.orbitEnabled, true);
  assert.ok(
    separation(afterDrag.desiredOrb, beforeDrag.desiredOrb) > 0.06,
    'Trusted pointer input must move the independent orb target',
  );
  assert.ok(
    pointerMotion.maximumOrbStep < 0.15 && pointerMotion.maximumElbowStep < 0.35,
    'The sampled arm must not teleport during the torso drag',
  );
  assert.ok(
    pointerMotion.maximumSampledOrbSpeed < 8 && pointerMotion.maximumSampledElbowSpeed < 15,
    'The sampled arm displacement rate must stay bounded',
  );
  assert.ok(pointerMotion.maximumRollingP95FrameMs < 1000, 'The scene must continue presenting frames during the drag');
  const contactSamples = dragSamples.filter((value) => value.arm.bodyContact);
  assert.ok(contactSamples.length >= 2, 'The pointer path must exercise the torso boundary');
  const contactProgress = separation(contactSamples[0].orb, contactSamples.at(-1).orb);
  assert.ok(
    contactProgress > 0.015,
    'The securely held orb must continue moving along the body boundary during contact',
  );
  report.cases.push({
    name: 'trusted-pointer-through-torso',
    before: beforeDrag,
    samples: dragSamples,
    after: afterDrag,
    motion: pointerMotion,
    contact: {
      samples: contactSamples.length,
      progress: contactProgress,
      firstOrb: contactSamples[0].orb,
      lastOrb: contactSamples.at(-1).orb,
    },
    interpretation:
      'Motion is sampled after pointer steps and at least two real frames. Frame metrics are the maximum rolling mean and rolling p95 observed in those samples, not single-frame maxima or a universal jank guarantee.',
  });
  await app.page.screenshot({ path: 'test-results/skinning-ik-constraints-browser.png', fullPage: true });

  const beforeReflections = validate(await frames(6), 'before reflection cadence');
  await app.page.waitForFunction((previous) => {
    const value = JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics'));
    return value.reflections >= previous + 2;
  }, beforeReflections.reflections);
  const afterReflections = validate(await metrics(), 'after reflection cadence');
  const cadence = {
    frames: afterReflections.frames - beforeReflections.frames,
    realFrames: afterReflections.animationFrames - beforeReflections.animationFrames,
    poseUpdates: afterReflections.poseUpdates - beforeReflections.poseUpdates,
    captures: afterReflections.reflections - beforeReflections.reflections,
  };
  assert.ok(cadence.frames > cadence.realFrames, 'The test must actually observe extra zero-delta reflection renders');
  assert.ok(cadence.poseUpdates <= cadence.realFrames, 'Reflection renders must not advance the presented IK pose');
  report.cases.push({ name: 'reflection-zero-delta', cadence });

  await app.page.locator('#auto-ik').uncheck();
  const frozen = validate(await frames(6), 'manual pose before reflections');
  await app.page.waitForFunction(
    (previous) => JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics')).reflections >= previous + 2,
    frozen.reflections,
  );
  const still = validate(await metrics(), 'manual pose after reflections');
  assert.equal(still.poseUpdates, frozen.poseUpdates, 'Manual pose must not solve during reflection captures');
  assert.equal(still.torso.yaw, frozen.torso.yaw, 'Manual reflection captures must not advance torso assistance');
  assert.ok(separation(still.arm.elbow, frozen.arm.elbow) < 1e-6);
  assert.ok(separation(still.arm.wrist, frozen.arm.wrist) < 1e-6);
  report.cases.push({ name: 'manual-reflection-hold', before: frozen, after: still });
  assert.ok(packageRequests.size > 0, 'The browser must actually load the constraints package');
  assert.equal(await app.page.locator('#error').textContent(), '');
  assert.deepEqual(errors, []);
  assert.deepEqual(resourceErrors, []);
} finally {
  report.packageRequests = [...packageRequests];
  await writeFile('test-results/skinning-ik-constraints-browser.json', JSON.stringify(report, null, 2));
  await app.close();
}
console.log(
  JSON.stringify({
    hardware: report.hardware,
    cases: report.cases.map((value) => value.name),
    errors,
    resourceErrors,
    packageRequests: report.packageRequests,
    pointerMotion: report.cases.find((value) => value.name === 'trusted-pointer-through-torso')?.motion,
    reflectionCadence: report.cases.find((value) => value.name === 'reflection-zero-delta')?.cadence,
  }),
);
