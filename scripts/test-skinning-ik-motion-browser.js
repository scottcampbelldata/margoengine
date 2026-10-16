import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from './browser.js';
import { mapArmControl } from '../examples/skinning-ik/arm-controls.ts';

// Optional standalone scene and artifact label; omission keeps the source demo
// and the existing report/screenshot names.
const argument = (name) => {
  const matches = process.argv.slice(2).filter((value) => value.startsWith(`--${name}=`));
  assert.ok(matches.length <= 1, `Specify --${name}= only once`);
  return matches[0]?.slice(name.length + 3);
};
const sceneArgument = argument('scene-url'),
  label = argument('label');
let sceneURL;
if (sceneArgument !== undefined) {
  sceneURL = new URL(sceneArgument);
  assert.ok(
    sceneURL.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(sceneURL.hostname) &&
      !sceneURL.username &&
      !sceneURL.password &&
      !sceneURL.hash,
    '--scene-url must be an absolute local HTTP URL without credentials or a fragment',
  );
}
if (label !== undefined)
  assert.match(
    label,
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    '--label must contain lowercase words or numbers separated by hyphens',
  );
const suffix = label ? `-${label}` : '';

const app = await openBrowser({
  startPath: '/tests/modern.html',
  channel: 'msedge',
  args: [],
  port: 5227,
  aliases: { '@margoengine/kinematics-constraints': resolve('packages/kinematics-constraints/dist/index.js') },
});
const errors = [],
  report = {
    hardware: app.hardware,
    errors,
    cases: [],
    transitions: [],
    method:
      'Real scene with hardware Edge. Continuous ranges dispatch input events from RAF; abrupt reversals use trusted keyboard Home/End. On-demand JSON snapshots are requested by the test on RAF and deduplicated by the former six-render sample group and animation frame. These requests allocate in the test harness; samples are not every simulation step or CCD.',
  };
app.page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
const page = app.page,
  distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const metrics = () =>
  page.evaluate(() => JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics')));
async function settle(expected) {
  await page.waitForFunction(
    (expected) => {
      const value = JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics'));
      return (
        value.residual < 0.002 &&
        value.targetMotion.settled &&
        Math.abs(value.torso.yaw - value.torso.desiredYaw) < 5e-5 &&
        (!expected || Math.hypot(...value.desiredOrb.map((v, i) => v - expected[i])) < 2e-6)
      );
    },
    expected ?? null,
    { timeout: 12000 },
  );
  return metrics();
}
async function captureStart() {
  await page.evaluate(() => {
    const viewport = document.querySelector('#viewport');
    globalThis.__motion = [];
    let frame = -1,
      sampleIndex = -1;
    const sample = () => {
      const value = JSON.parse(viewport.readWorkshopDiagnostics('metrics'));
      if (value.sampleIndex !== sampleIndex && value.animationFrames !== frame) {
        frame = value.animationFrames;
        sampleIndex = value.sampleIndex;
        globalThis.__motion.push({ at: performance.now(), ...value });
      }
      globalThis.__motionFrame = requestAnimationFrame(sample);
    };
    globalThis.__motionFrame = requestAnimationFrame(sample);
  });
}
const captureStop = () =>
  page.evaluate(() => {
    cancelAnimationFrame(globalThis.__motionFrame);
    const samples = globalThis.__motion;
    delete globalThis.__motion;
    delete globalThis.__motionFrame;
    return samples;
  });
function summarize(samples, lengths) {
  assert.ok(samples.length > 3, 'Motion capture must include presented samples');
  const summary = {
    samples: samples.length,
    maxResidual: 0,
    maxOrbStep: 0,
    maxElbowStep: 0,
    maxTorsoSpeed: 0,
    maxMetricsGapMs: 0,
    maxRollingP95Ms: 0,
    maxUnmovingChaseMs: 0,
    maxCommandStep: 0,
  };
  let stalled = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    assert.equal(value.arm.safe, true, `Unsafe presented pose at sample${i}`);
    assert.equal(value.head.clearanceResolved, true, `Unresolved head clearance at sample${i}`);
    assert.ok(Number.isFinite(value.head.headClearance) && value.head.headClearance >= 0);
    assert.ok(value.gripError < 1e-5 && distance(value.orb, value.gripCenter) < 1e-5);
    assert.ok(Math.abs(value.torso.yaw) <= 0.85 + 1e-6);
    assert.ok(Math.abs(distance(value.arm.shoulder, value.arm.elbow) - lengths[0]) < 2e-5);
    assert.ok(Math.abs(distance(value.arm.elbow, value.arm.wrist) - lengths[1]) < 2e-5);
    summary.maxResidual = Math.max(summary.maxResidual, value.residual);
    summary.maxRollingP95Ms = Math.max(summary.maxRollingP95Ms, value.performance.p95Ms);
    if (!i) continue;
    const previous = samples[i - 1],
      gap = value.at - previous.at,
      step = distance(value.orb, previous.orb);
    summary.maxOrbStep = Math.max(summary.maxOrbStep, step);
    if (value.commandOrb && previous.commandOrb)
      summary.maxCommandStep = Math.max(summary.maxCommandStep, distance(value.commandOrb, previous.commandOrb));
    summary.maxElbowStep = Math.max(summary.maxElbowStep, distance(value.arm.elbow, previous.arm.elbow));
    summary.maxMetricsGapMs = Math.max(summary.maxMetricsGapMs, gap);
    summary.maxTorsoSpeed = Math.max(
      summary.maxTorsoSpeed,
      Math.abs(value.torso.yaw - previous.torso.yaw) / (gap / 1000),
    );
    stalled = value.residual > 0.02 && step < 1e-5 ? stalled + gap : 0;
    summary.maxUnmovingChaseMs = Math.max(summary.maxUnmovingChaseMs, stalled);
  }
  return summary;
}

try {
  assert.match(app.hardware.userAgent, /Edg\//);
  assert.equal(app.hardware.webgpu?.fallback, false);
  await page.route('**/@vite/client', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '// HMR disabled for motion regression' }),
  );
  await page.goto(sceneURL?.href ?? new URL('/examples/skinning-ik.html', page.url()).href);
  if (sceneURL) report.sceneURL = page.url();
  if (label) report.label = label;
  await page.waitForFunction(
    () => document.querySelector('#viewport').dataset.ready === 'true' || document.querySelector('#error').textContent,
  );
  assert.equal(await page.locator('#error').textContent(), '');
  await page.locator('details.advanced > summary').click();
  for (const id of ['idle', 'moving-light', 'autopilot', 'follow']) await page.locator(`#${id}`).uncheck();
  await page.locator('[data-pose="home"]').click();
  const home = await settle(),
    lengths = [distance(home.arm.shoulder, home.arm.elbow), distance(home.arm.elbow, home.arm.wrist)];
  for (const tracking of [true, false]) {
    if (tracking) await page.locator('#look').check();
    else await page.locator('#look').uncheck();
    const input = page.locator('#target-x');
    await input.focus();
    await input.press('Home');
    await settle(mapArmControl('side', 0));
    await captureStart();
    await page.evaluate(async () => {
      const input = document.querySelector('#target-x'),
        start = performance.now(),
        duration = 7000;
      await new Promise((resolve) => {
        const frame = () => {
          const elapsed = Math.min(1, (performance.now() - start) / duration);
          input.value = String(0.5 - 0.5 * Math.cos(elapsed * 4 * Math.PI));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          if (elapsed < 1) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
    });
    await settle(mapArmControl('side', 0));
    const samples = await captureStop();
    report.cases.push({
      name: `continuous-side-look-${tracking ? 'on' : 'off'}`,
      summary: summarize(samples, lengths),
      samples,
    });
    await captureStart();
    for (let reversal = 0; reversal < 6; reversal++) {
      await input.press(reversal % 2 ? 'Home' : 'End');
      await page.waitForTimeout(180);
    }
    await settle(mapArmControl('side', 0));
    const rapid = await captureStop();
    report.cases.push({
      name: `trusted-rapid-reversals-look-${tracking ? 'on' : 'off'}`,
      summary: summarize(rapid, lengths),
      samples: rapid,
    });
    await input.press('End');
    const endpoint = await settle(mapArmControl('side', 1));
    console.log(`Side endpoint settled with look ${tracking ? 'on' : 'off'}`);
    assert.ok(endpoint.orb[0] > 0.233 && Math.abs(endpoint.orb[1] - 1.16) < 0.002);
    await page.screenshot({
      path: `test-results/skinning-ik-motion${suffix}-look-${tracking ? 'on' : 'off'}.png`,
      fullPage: true,
    });
    await captureStart();
    for (const [control, axis, key, parameter] of [
      ['height', 'y', 'End', 1],
      ['height', 'y', 'Home', 0],
      ['height', 'y', 'End', 1],
      ['nearFar', 'z', 'Home', 0],
      ['nearFar', 'z', 'End', 1],
      ['side', 'x', 'Home', 0],
      ['side', 'x', 'End', 1],
    ]) {
      const start = performance.now();
      await page.locator('#target-' + axis).press(key);
      const endpoint = await settle(mapArmControl(control, parameter));
      report.transitions.push({
        tracking,
        control,
        parameter,
        elapsedMs: performance.now() - start,
        desired: endpoint.desiredOrb,
        command: endpoint.commandOrb,
        orb: endpoint.orb,
        residual: endpoint.residual,
      });
      console.log(
        `${control} ${parameter} settled with look ${tracking ? 'on' : 'off'} in ${Math.round(performance.now() - start)}ms`,
      );
    }
    const transitions = await captureStop();
    report.cases.push({
      name: `cross-track-transitions-look-${tracking ? 'on' : 'off'}`,
      summary: summarize(transitions, lengths),
      samples: transitions,
    });
    await captureStart();
    for (let change = 0; change < 12; change++) {
      await page.locator('#target-' + ['y', 'z', 'x'][change % 3]).press(change % 2 ? 'Home' : 'End');
      await page.waitForTimeout(90);
    }
    await page.locator('#target-y').press('End');
    await settle(mapArmControl('height', 1));
    const interrupted = await captureStop();
    report.cases.push({
      name: `interrupted-cross-track-reversals-look-${tracking ? 'on' : 'off'}`,
      summary: summarize(interrupted, lengths),
      samples: interrupted,
    });
    const near = page.locator('#target-z');
    assert.equal(await near.inputValue(), '0', 'Inactive near track is already at its nearest endpoint');
    await near.scrollIntoViewIfNeeded();
    await near.evaluate((input) => {
      window.unchangedRangeInputs = 0;
      window.countRangeInput = () => window.unchangedRangeInputs++;
      input.addEventListener('input', window.countRangeInput);
    });
    const box = await near.boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    const nativeInputs = await near.evaluate((input) => {
      input.removeEventListener('input', window.countRangeInput);
      return window.unchangedRangeInputs;
    });
    assert.equal(nativeInputs, 0, 'Clicking the unchanged thumb emits no native range input');
    await settle(mapArmControl('nearFar', 0));
    console.log(`Unchanged pointer thumb selected near track with look ${tracking ? 'on' : 'off'}`);
  }
  await page.locator('#auto-ik').uncheck();
  // Wait for a presented frame after the checkbox event before comparing the
  // otherwise held simulation history; reading diagnostics never advances it.
  const pausedPublication = (await metrics()).frames;
  await page.waitForFunction(
    (before) => JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics')).frames > before,
    pausedPublication,
  );
  const held = await metrics();
  await page.locator('#target-x').press('Home');
  await page.waitForTimeout(500);
  const paused = await metrics();
  assert.equal(paused.poseUpdates, held.poseUpdates, 'auto-off must hold route and IK history');
  assert.ok(distance(paused.orb, held.orb) < 2e-6);
  await page.locator('#solve-once').click();
  await page.waitForFunction(
    (before) => JSON.parse(document.querySelector('#viewport').readWorkshopDiagnostics('metrics')).poseUpdates > before,
    paused.poseUpdates,
  );
  await page.waitForTimeout(400);
  const manual = await metrics();
  assert.equal(manual.poseUpdates, paused.poseUpdates + 1, 'manual solve advances one real step only');
  await page.locator('#auto-ik').check();
  await settle(mapArmControl('side', 0));
  await page.locator('#target-x').press('End');
  await page.waitForTimeout(120);
  await page.locator('#ik-enabled').uncheck();
  await page.waitForTimeout(200);
  assert.equal((await metrics()).targetMotion.routing, false);
  await page.locator('#ik-enabled').check();
  await settle(mapArmControl('side', 1));
  await page.locator('[data-pose="high"]').click();
  await settle(mapArmControl('height', 1));
  await page.locator('[data-pose="home"]').click();
  await settle(mapArmControl('side', 0.5));
  await page.locator('[data-pose="wide"]').click();
  await page.waitForTimeout(200);
  assert.equal((await metrics()).targetMotion.routing, false, 'free presets release authored routes');
  await page.locator('#target-y').press('End');
  await settle(mapArmControl('height', 1));
  await page.locator('#reset').click();
  await settle(mapArmControl('side', 0.5));
  assert.equal((await metrics()).targetMotion.routing, false, 'reset clears the route');
  assert.equal(await page.locator('#error').textContent(), '');
  assert.deepEqual(errors, []);
} finally {
  try {
    report.finalMetrics = await metrics();
    report.finalInputs = await page.evaluate(() =>
      ['x', 'y', 'z'].map((axis) => ({ axis, value: document.querySelector(`#target-${axis}`).valueAsNumber })),
    );
  } catch {}
  await writeFile(`test-results/skinning-ik-motion-browser${suffix}.json`, JSON.stringify(report, null, 2));
  await app.close();
}
console.log(
  JSON.stringify({
    hardware: report.hardware,
    cases: report.cases.map(({ name, summary }) => ({ name, ...summary })),
    errors,
  }),
);
