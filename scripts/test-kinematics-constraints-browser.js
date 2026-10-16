import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openBrowser} from './browser.js';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const app = await openBrowser({startPath: '/examples/kinematics-constraints.html', port: 5207,
  aliases: {'@margoengine/kinematics-constraints': resolve('packages/kinematics-constraints/dist/index.js')},
});
try {
  const errors = [];
  app.page.on('pageerror', reason => errors.push(reason.message));
  await app.page.waitForFunction(() => window.kinematicsDemo || document.querySelector('#error').textContent);
  assert.equal(await app.page.locator('#error').textContent(), '');
  const initial = await app.page.evaluate(() => ({status: window.kinematicsDemo.result.status, clearance: window.kinematicsDemo.clearance}));
  assert.equal(initial.status, 0); assert.ok(initial.clearance >= 0.008 - 1e-6);
  const torso = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo, counts = [0, 0, 0, 0];
    let minimum = Infinity, previousAngle = demo.result.poleAngle;
    let maximumSwivelStep = 0, maximumLengthError = 0;
    for (let i = 0; i < 480; i++) {
      demo.setTarget(0.9 - 1.1 * i / 479, 0.8 + 0.2 * Math.sin(i / 479 * Math.PI), 0.14);
      demo.step(1 / 60); counts[demo.result.status]++; minimum = Math.min(minimum, demo.clearance);
      if (demo.result.resolved) {
        maximumSwivelStep = Math.max(maximumSwivelStep, Math.abs(demo.result.poleAngle - previousAngle));
        previousAngle = demo.result.poleAngle;
        const upper = Math.hypot(demo.currentElbow[0] - demo.root[0], demo.currentElbow[1] - demo.root[1], demo.currentElbow[2] - demo.root[2]);
        const lower = Math.hypot(demo.currentElbow[0] - demo.currentHand[0], demo.currentElbow[1] - demo.currentHand[1], demo.currentElbow[2] - demo.currentHand[2]);
        maximumLengthError = Math.max(maximumLengthError, Math.abs(upper - 0.55), Math.abs(lower - 0.52));
        const reach = Math.hypot(demo.currentHand[0] - demo.root[0], demo.currentHand[1] - demo.root[1], demo.currentHand[2] - demo.root[2]);
        if (reach < 0.045 || reach > 1.069) throw new Error('Accepted target crossed the operational reach band');
      }
    }
    return {counts, minimum, maximumSwivelStep, maximumLengthError, hand: [...demo.currentHand], raw: [...demo.rawTarget]};
  });
  assert.ok(torso.counts[0] > 0); assert.ok(torso.minimum >= 0.008 - 1e-6);
  assert.ok(torso.maximumSwivelStep <= Math.PI / 60);
  assert.ok(torso.maximumLengthError <= 1e-6);
  const adversarial = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo;
    const torsoStart = [0, 0.45, 0], torsoEnd = [0, 1.2, 0], torsoRadius = 0.32;
    const upper = 0.55, lower = 0.52, upperRadius = 0.065, lowerRadius = 0.055;
    const clearance = 0.008, fold = Math.abs(upper - lower) + 0.015, reach = upper + lower - 0.001;
    const distances = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    // Independent convex segment minimum: four endpoint projections plus the
    // unconstrained interior pair. No solver geometry is called by this audit.
    function segmentDistance(a, b, c, d) {
      const u = b.map((x, i) => x - a[i]), v = d.map((x, i) => x - c[i]), w = a.map((x, i) => x - c[i]);
      const dot = (x, y) => x.reduce((sum, value, i) => sum + value * y[i], 0);
      const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), uw = dot(u, w), vw = dot(v, w);
      const clamp = value => Math.max(0, Math.min(1, value));
      const candidates = [[0, vv ? clamp(vw / vv) : 0], [1, vv ? clamp((vw + uv) / vv) : 0],
        [uu ? clamp(-uw / uu) : 0, 0], [uu ? clamp((uv - uw) / uu) : 0, 1]];
      const denominator = uu * vv - uv * uv;
      if (denominator > 1e-14) {
        const s = (uv * vw - vv * uw) / denominator, t = (uu * vw - uv * uw) / denominator;
        if (s >= 0 && s <= 1 && t >= 0 && t <= 1) candidates.push([s, t]);
      }
      return Math.min(...candidates.map(([s, t]) => Math.hypot(...w.map((value, i) => value + s * u[i] - t * v[i]))));
    }
    window.kinematicsTestAudit = label => {
      const root = [...demo.root], elbow = [...demo.currentElbow], hand = [...demo.currentHand];
      let upperGap = Infinity, lowerGap = Infinity, targetGap = Infinity;
      for (const volume of demo.volumes) {
        const a = volume.start ? [...volume.start] : [...volume.center], b = volume.end ? [...volume.end] : a;
        upperGap = Math.min(upperGap, segmentDistance(root, elbow, a, b) - volume.radius - upperRadius);
        lowerGap = Math.min(lowerGap, segmentDistance(elbow, hand, a, b) - volume.radius - lowerRadius);
        targetGap = Math.min(targetGap, segmentDistance(hand, hand, a, b) - volume.radius - lowerRadius);
      }
      const actualReach = distances(root, hand);
      const lengthError = Math.max(Math.abs(distances(root, elbow) - upper), Math.abs(distances(elbow, hand) - lower));
      if (![...root, ...elbow, ...hand].every(Number.isFinite)) throw new Error(`${label}: non-finite pose`);
      if (Math.min(upperGap, lowerGap, targetGap) < demo.avoidance.minClearance - 1e-6) throw new Error(`${label}: independent proxy clearance failed`);
      if (actualReach < fold || actualReach > reach) throw new Error(`${label}: operational reach violated`);
      if (lengthError > 1e-6) throw new Error(`${label}: link length changed`);
      return {upperGap, lowerGap, targetGap, reach: actualReach, lengthError};
    };
    const stepTimes = [1 / 240, 1 / 120, 1 / 60, 1 / 30, 0.08, 1 / 90, 0.001];
    const speeds = [15, 45, 90, 180, 360];
    const speedInput = document.querySelector('#speed');
    const scenarios = [
      {name: 'shoulder-junction-circles', frames: 720, target(i) {
        const angle = (Math.floor(i / 90) % 2 ? -1 : 1) * i * 0.13;
        const radius = 0.02 + 0.25 * (0.5 + 0.5 * Math.sin(i * 0.071));
        return [demo.root[0] + Math.cos(angle) * radius, demo.root[1] + Math.sin(angle) * radius, Math.sin(i * 0.17) * 0.055];
      }},
      {name: 'fast-chest-reversals', frames: 840, target(i) {
        const period = [1, 2, 8, 30][Math.floor(i / 210)];
        const direction = Math.floor(i / period) % 2 ? -1 : 1;
        return [direction > 0 ? 0.98 : -0.36, 0.8 + Math.sin(i * 0.11) * 0.27, direction * 0.18];
      }},
      {name: 'fold-and-shoulder-crossings', frames: 420, target(i) {
        const radius = [0, 0.025, 0.0449, 0.0451, 0.09, 0.21][i % 6];
        const angle = i * 0.43;
        return [demo.root[0] + Math.cos(angle) * radius, demo.root[1] + Math.sin(angle) * radius, 0];
      }},
      {name: 'near-antipodal-axis-reversals', frames: 420, target(i) {
        const direction = Math.floor(i / [1, 2, 12, 60][Math.floor(i / 105)]) % 2 ? -1 : 1;
        return [demo.root[0] + Math.sin(i * 0.3) * 1e-7, demo.root[1] + direction * 0.55, direction * 1e-7];
      }},
    ];
    const reports = [];
    for (const scenario of scenarios) {
      document.querySelector('#reset').click();
      let previousAngle = demo.result.poleAngle;
      const report = {name: scenario.name, frames: scenario.frames, counts: [0, 0, 0, 0], held: 0,
        minimumLinkClearance: Infinity, minimumTargetClearance: Infinity, maximumLengthError: 0,
        maximumSwivelStep: 0, maximumSwivelRateRatio: 0};
      for (let i = 0; i < scenario.frames; i++) {
        const speed = speeds[Math.floor(i / 37) % speeds.length];
        speedInput.value = String(speed); speedInput.dispatchEvent(new Event('input', {bubbles: true}));
        const dt = stepTimes[i % stepTimes.length], effectiveDt = Math.min(dt, 1 / 20);
        const beforeHand = [...demo.currentHand], beforeElbow = [...demo.currentElbow];
        const target = scenario.target(i); demo.setTarget(target[0], target[1], target[2]);
        const result = demo.step(dt), label = `${scenario.name} frame ${i}`;
        if (!Number.isInteger(result.status) || result.status < 0 || result.status > 3 || result.resolved !== (result.status === 0)) throw new Error(`${label}: inconsistent status`);
        report.counts[result.status]++;
        const root = [...demo.root], elbow = [...demo.currentElbow], hand = [...demo.currentHand];
        if (![...root, ...elbow, ...hand, result.poleAngle].every(Number.isFinite)) throw new Error(`${label}: non-finite pose`);
        if (!result.resolved) {
          if (hand.some((value, j) => value !== beforeHand[j]) || elbow.some((value, j) => value !== beforeElbow[j])) throw new Error(`${label}: rejected pose was committed`);
          report.held++;
        } else {
          const step = Math.abs(result.poleAngle - previousAngle), permitted = speed * Math.PI / 180 * effectiveDt;
          if (step > permitted + Number.EPSILON * 16 * Math.max(1, Math.abs(previousAngle))) throw new Error(`${label}: swivel speed exceeded (${step} > ${permitted})`);
          report.maximumSwivelStep = Math.max(report.maximumSwivelStep, step);
          report.maximumSwivelRateRatio = Math.max(report.maximumSwivelRateRatio, step / permitted);
          previousAngle = result.poleAngle;
          if (hand.some((value, j) => value !== result.target[j]) || elbow.some((value, j) => value !== result.elbow[j])) throw new Error(`${label}: accepted buffers were not committed`);
        }
        // Held and newly accepted poses must both remain physically clear.
        const upperGap = segmentDistance(root, elbow, torsoStart, torsoEnd) - torsoRadius - upperRadius;
        const lowerGap = segmentDistance(elbow, hand, torsoStart, torsoEnd) - torsoRadius - lowerRadius;
        const targetGap = segmentDistance(hand, hand, torsoStart, torsoEnd) - torsoRadius - lowerRadius;
        const lengthError = Math.max(Math.abs(distances(root, elbow) - upper), Math.abs(distances(elbow, hand) - lower));
        const actualReach = distances(root, hand);
        if (Math.min(upperGap, lowerGap, targetGap) < demo.avoidance.minClearance - 1e-6) throw new Error(`${label}: independent proxy clearance failed`);
        if (actualReach < fold || actualReach > reach) throw new Error(`${label}: operational reach violated`);
        if (lengthError > 1e-6) throw new Error(`${label}: link length changed`);
        report.minimumLinkClearance = Math.min(report.minimumLinkClearance, upperGap, lowerGap);
        report.minimumTargetClearance = Math.min(report.minimumTargetClearance, targetGap);
        report.maximumLengthError = Math.max(report.maximumLengthError, lengthError);
      }
      reports.push(report);
    }
    speedInput.value = '180'; speedInput.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('#reset').click();
    return reports;
  });
  for (const scenario of adversarial) {
    assert.ok(scenario.counts[0] > 0, `${scenario.name} never accepted a pose`);
    assert.ok(scenario.held > 0, `${scenario.name} never exercised failure holding`);
    assert.ok(scenario.minimumLinkClearance >= 0.008 - 1e-6);
    assert.ok(scenario.minimumTargetClearance >= 0.008 - 1e-6);
    assert.ok(scenario.maximumSwivelRateRatio <= 1 + 1e-10);
  }
  const overheadPixels = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo, rect = document.querySelector('canvas').getBoundingClientRect();
    function project(x, y, z = 0) {
      demo.setTarget(x, y, z);
      for (let i = 0; i < 3; i++) demo.step(0.05);
      const cursor = document.querySelector('#raw-cursor');
      return {x: rect.left + parseFloat(cursor.style.left), y: rect.top + parseFloat(cursor.style.top)};
    }
    const points = {start: project(0.9, 0.7, demo.dragShell), overhead: project(demo.root[0], 2.30), waist: project(-0.22, 0.7, demo.dragShell), overshoot: project(demo.root[0], 2.7),
      bounds: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom}};
    document.querySelector('#reset').click();
    return points;
  });
  for (const point of [overheadPixels.start, overheadPixels.overhead, overheadPixels.waist, overheadPixels.overshoot]) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x > overheadPixels.bounds.left && point.x < overheadPixels.bounds.right && point.y > overheadPixels.bounds.top && point.y < overheadPixels.bounds.bottom,
      'The camera should frame the starting, overhead, and overshoot pointer targets');
  }
  await app.page.mouse.move(overheadPixels.start.x, overheadPixels.start.y);
  await app.page.mouse.down();
  await app.page.mouse.move(overheadPixels.overhead.x, overheadPixels.overhead.y, {steps: 90});
  await app.page.mouse.up();
  const overhead = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo;
    for (let i = 0; i < 180; i++) { demo.step(1 / 30); window.kinematicsTestAudit(`Overhead settle ${i}`); }
    return {status: demo.result.status, raw: [...demo.rawTarget], hand: [...demo.currentHand], elbow: [...demo.currentElbow], clearance: demo.clearance};
  });
  assert.equal(overhead.status, 0, 'A reachable overhead pointer drag should be accepted');
  assert.ok(Math.abs(overhead.raw[1] - 2.30) < 0.002, 'Pointer ray mapping should reach above the previous 1.8m ceiling');
  assert.ok(Math.abs(overhead.raw[2]) < 1e-7, 'Interactive dragging should stay on the shoulder plane');
  assert.ok(overhead.hand[1] > 2.29);
  assert.ok(overhead.clearance >= 0.008 - 1e-6);
  await app.page.mouse.move(overheadPixels.overhead.x, overheadPixels.overhead.y);
  await app.page.mouse.down();
  await app.page.mouse.move(overheadPixels.waist.x, overheadPixels.waist.y, {steps: 120});
  await app.page.mouse.up();
  const waistCrossBody = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo;
    let minimumClearance = Infinity;
    for (let i = 0; i < 240; i++) {
      demo.step([1 / 120, 1 / 60, 1 / 30][i % 3]);
      const audit = window.kinematicsTestAudit(`Waist cross-body settle ${i}`);
      minimumClearance = Math.min(minimumClearance, audit.upperGap, audit.lowerGap, audit.targetGap);
    }
    return {status: demo.result.status, raw: [...demo.rawTarget], hand: [...demo.currentHand], elbow: [...demo.currentElbow], minimumClearance};
  });
  assert.equal(waistCrossBody.status, 0, 'The same chain should follow an overhead-to-waist cross-body drag');
  assert.ok(waistCrossBody.hand[0] < -0.18 && waistCrossBody.hand[1] < 0.75, 'The hand should reach the far side of the waist');
  assert.ok(waistCrossBody.hand[2] > 0.3, 'Waist dragging should follow the front of the torso');
  assert.ok(waistCrossBody.minimumClearance >= 0.008 - 1e-6);
  const waistCursorError = await app.page.evaluate(expected => {
    const cursor = document.querySelector('#raw-cursor'), rect = document.querySelector('canvas').getBoundingClientRect();
    return Math.hypot(rect.left + parseFloat(cursor.style.left) - expected.x, rect.top + parseFloat(cursor.style.top) - expected.y);
  }, overheadPixels.waist);
  assert.ok(waistCursorError < 0.25, 'The reachable waist target should stay under the pointer as drag depth changes');
  await app.page.screenshot({path: 'test-results/kinematics-constraints-waist.png', fullPage: true});
  await app.page.mouse.move(overheadPixels.waist.x, overheadPixels.waist.y);
  await app.page.mouse.down();
  await app.page.mouse.move(overheadPixels.overhead.x, overheadPixels.overhead.y, {steps: 120});
  await app.page.mouse.up();
  const returnOverhead = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo;
    for (let i = 0; i < 180; i++) { demo.step(1 / 30); window.kinematicsTestAudit(`Return overhead settle ${i}`); }
    return {status: demo.result.status, raw: [...demo.rawTarget], hand: [...demo.currentHand], elbow: [...demo.currentElbow]};
  });
  assert.equal(returnOverhead.status, 0, 'The same chain should return overhead after crossing the waist without reset');
  assert.ok(returnOverhead.hand[1] > 2.29);
  await app.page.mouse.move(overheadPixels.overhead.x, overheadPixels.overhead.y);
  await app.page.mouse.down();
  await app.page.mouse.move(overheadPixels.overshoot.x, overheadPixels.overshoot.y, {steps: 30});
  await app.page.mouse.up();
  const overheadOvershoot = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo;
    for (let i = 0; i < 180; i++) { demo.step(1 / 30); window.kinematicsTestAudit(`Overhead overshoot settle ${i}`); }
    const reach = Math.hypot(...demo.rawTarget.map((value, i) => value - demo.root[i]));
    return {status: demo.result.status, raw: [...demo.rawTarget], hand: [...demo.currentHand], reach};
  });
  assert.equal(overheadOvershoot.status, 0, 'Dragging beyond reach should follow the safe operational boundary');
  assert.ok(overheadOvershoot.reach <= 1.069 && overheadOvershoot.reach > 1.0689);
  assert.ok(overheadOvershoot.hand[1] > 2.31);
  await app.page.screenshot({path: 'test-results/kinematics-constraints-overhead.png', fullPage: true});
  const verticalContinuity = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo;
    document.querySelector('#reset').click();
    demo.setTarget(demo.root[0] + 1e-4, 2.15, 0);
    for (let i = 0; i < 240; i++) demo.step(1 / 60);
    if (!demo.result.resolved) throw new Error('Near-vertical initial target failed');
    const before = [...demo.currentElbow];
    let maximumElbowStep = 0, maximumPoleStep = 0, previousPole = demo.result.poleAngle;
    for (let i = 0; i < 360; i++) {
      const previousElbow = [...demo.currentElbow];
      demo.setTarget(demo.root[0] + (Math.floor(i / 60) % 2 ? 1e-4 : -1e-4), 2.15, 0);
      const result = demo.step(1 / 60);
      if (!result.resolved) throw new Error(`Near-vertical crossing frame ${i} failed`);
      maximumElbowStep = Math.max(maximumElbowStep, Math.hypot(...demo.currentElbow.map((value, j) => value - previousElbow[j])));
      maximumPoleStep = Math.max(maximumPoleStep, Math.abs(result.poleAngle - previousPole));
      previousPole = result.poleAngle;
    }
    return {before, after: [...demo.currentElbow], maximumElbowStep, maximumPoleStep};
  });
  assert.ok(verticalContinuity.maximumElbowStep < 0.002, 'The elbow should remain continuous across the vertical target axis');
  assert.ok(verticalContinuity.maximumPoleStep <= Math.PI / 60);
  const singularBoundaries = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo, cases = [];
    // Bypass the pointer's operational clamp deliberately. Physical extension
    // and zero reach must remain unresolved even with target damping enabled.
    for (const distance of [0, 1e-12, 0.55 + 0.52, 0.55 + 0.52 + 1e-6]) {
      document.querySelector('#reset').click();
      const hand = [...demo.currentHand], elbow = [...demo.currentElbow];
      demo.setTarget(demo.root[0], demo.root[1] + distance, demo.root[2]);
      const statuses = [0, 0, 0, 0];
      for (let i = 0; i < 60; i++) {
        const result = demo.step([1 / 240, 1 / 60, 0.08][i % 3]);
        statuses[result.status]++;
        if (result.resolved || result.status === 0) throw new Error(`Singular request ${distance} was not excluded`);
        if (![...result.target, ...result.elbow, result.poleAngle].every(Number.isFinite)) throw new Error('Non-finite singular diagnostic');
        for (let a = 0; a < 3; a++) if (hand[a] !== demo.currentHand[a] || elbow[a] !== demo.currentElbow[a]) throw new Error('Singular request changed held pose');
        window.kinematicsTestAudit(`Singular boundary ${distance}, frame ${i}`);
      }
      cases.push({distance, statuses, target: [...demo.result.target]});
    }
    document.querySelector('#reset').click();
    demo.setTarget(demo.root[0], 2.15, 0);
    for (let i = 0; i < 240; i++) demo.step(1 / 60);
    return cases;
  });
  await writeFile('test-results/kinematics-constraints-interactions.json', JSON.stringify({initial, torso, adversarial,
    overhead, waistCrossBody, waistCursorError, returnOverhead, overheadOvershoot, verticalContinuity, singularBoundaries, hardware: app.hardware}, null, 2));
  await app.page.locator('summary').first().click();
  await app.page.locator('#dead-zone').click();
  const held = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo, before = [...demo.currentHand];
    const result = demo.step(1 / 60);
    return {status: result.status, before, after: [...demo.currentHand]};
  });
  assert.equal(held.status, 2); assert.deepEqual(held.after, held.before);
  await app.page.locator('#reset').click();
  assert.ok(await app.page.evaluate(() => window.kinematicsDemo.clearance >= 0.008 - 1e-6));
  await app.page.locator('#pause').click();
  const paused = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo, before = [...demo.currentHand];
    demo.setTarget(-0.1, 1.1, 0.14); demo.step(1 / 60);
    return {before, after: [...demo.currentHand]};
  });
  assert.deepEqual(paused.after, paused.before);
  await app.page.locator('#pause').click();
  await app.page.locator('#reset').click();
  await app.page.locator('#proxies').uncheck(); await app.page.locator('#proxies').check();
  await app.page.locator('canvas').focus(); await app.page.keyboard.press('ArrowLeft');
  const rawX = await app.page.evaluate(() => window.kinematicsDemo.rawTarget[0]); assert.ok(rawX < 0.9);
  const canvas = await app.page.locator('canvas').boundingBox();
  await app.page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.42);
  await app.page.mouse.down(); await app.page.mouse.move(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.5, {steps: 30}); await app.page.mouse.up();
  await app.page.locator('#reset').click();
  const finalRecovery = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo;
    for (let i = 0; i < 400; i++) { demo.setTarget(0.9 - 0.85 * i / 399, 0.7 + 0.3 * i / 399, 0.14); demo.step(1 / 60); }
    const legacyRawSweep = {status: demo.result.status, raw: [...demo.rawTarget], hand: [...demo.currentHand], elbow: [...demo.currentElbow],
      explanation: 'Direct raw requests bypass the interactive front surface. A rejected request holds the accepted pose; no motion path is planned.'};
    window.kinematicsTestAudit('Legacy raw sweep held pose');
    // This raw-only sweep bypasses the front surface controller and can end in
    // a held pose. The no-reset pointer round trip above tests real recovery.
    document.querySelector('#reset').click();
    demo.setTarget(demo.root[0], 2.15, 0);
    for (let i = 0; i < 240; i++) { demo.step(1 / 60); window.kinematicsTestAudit(`Final recovery ${i}`); }
    return {legacyRawSweep, status: demo.result.status, raw: [...demo.rawTarget], hand: [...demo.currentHand], elbow: [...demo.currentElbow], target: [...demo.result.target], pole: demo.result.poleAngle, clearance: demo.result.clearance};
  });
  assert.equal(finalRecovery.status, 0, `Legacy sweep recovery failed: ${JSON.stringify(finalRecovery)}`);
  await app.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Following'));
  await app.page.locator('#reset').click();
  const motionTransition = await app.page.evaluate(() => {
    const d = window.kinematicsDemo, speed = document.querySelector('#speed');
    d.setInteractiveTarget(0,.9); for (let i = 0; i < 180; i++) d.step(1/60);
    let sliding = 0, maximumHandStep = 0;
    for (let i = 0; i < 120; i++) {
      d.setInteractiveTarget(.02 * Math.sin(i * .08),.9); d.step(1/60);
      window.kinematicsTestAudit(`Contact slide ${i}`);
      if (d.result.resolved && d.clampActive && d.handStep > 0) sliding++;
      maximumHandStep = Math.max(maximumHandStep,d.handStep);
    }
    const slidingReadout = {state: document.querySelector('#status').textContent, hand: document.querySelector('#hand-step').textContent};
    speed.value='0'; speed.dispatchEvent(new Event('input',{bubbles:true})); d.setTarget(-.1,.9,.39);
    let held = 0;
    for (let i = 0; i < 120; i++) {
      d.step(1/60); window.kinematicsTestAudit(`Zero speed hold ${i}`);
      if (!d.result.resolved) {
        held++;
        if (d.handStep !== 0 || d.angleStep !== 0) throw new Error('Held pose reported accepted motion');
      }
    }
    const heldReadout = {state: document.querySelector('#status').textContent, hand: document.querySelector('#hand-step').textContent, pole: document.querySelector('#actual-step').textContent};
    speed.value='360'; speed.dispatchEvent(new Event('input',{bubbles:true}));
    let resumed = 0, maximumPoleStep = 0, releaseMaximumHandStep = 0, firstReleaseHandStep = null, releaseMinimumGap = Infinity;
    for (let i = 0; i < 180; i++) {
      const angle = d.acceptedPole; d.step(1/60); const audit = window.kinematicsTestAudit(`Speed release ${i}`);
      releaseMinimumGap = Math.min(releaseMinimumGap,audit.upperGap,audit.lowerGap,audit.targetGap);
      releaseMaximumHandStep = Math.max(releaseMaximumHandStep,d.handStep);
      if (firstReleaseHandStep === null && d.result.resolved && d.handStep > 0) firstReleaseHandStep = d.handStep;
      const delta = Math.abs(d.acceptedPole - angle); maximumPoleStep = Math.max(maximumPoleStep,delta);
      if (delta > Math.PI/30 + 1e-12) throw new Error('Release bypassed rate limit');
      if (d.result.resolved && d.handStep > 0) resumed++;
    }
    if (sliding < 100 || held < 50 || !resumed || !d.result.resolved) throw new Error('Contact/hold/release transition was not exercised: ' + JSON.stringify({sliding,held,resumed,status:d.result.status,slidingReadout,heldReadout}));
    if (!slidingReadout.state.includes('Sliding') || !heldReadout.state.includes('pose held') || heldReadout.hand !== '0.00 mm' || heldReadout.pole !== '0.00°') throw new Error('Motion state HUD disagreed with accepted geometry');
    speed.value='180'; speed.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#reset').click();
    return {sliding,held,resumed,maximumHandStep,maximumPoleStep,releaseMaximumHandStep,firstReleaseHandStep,releaseMinimumGap,dtSeconds:1/60,unsafe:0,slidingReadout,heldReadout};
  });
  await app.page.locator('#scene').selectOption('mixed');
  await app.page.locator('#clock').selectOption('fixed120');
  await app.page.locator('#yaw-assist').check();
  const capabilities = await app.page.evaluate(() => {
    const d = window.kinematicsDemo; let accepted = 0, localSteps = 0, held = 0, maximumYaw = 0, minimumGap = Infinity, maximumHandStep = 0;
    if (d.volumes.length !== 3) throw new Error('Mixed scene did not install all three colliders');
    let previousPole = d.acceptedPole;
    for (let i = 0; i < 720; i++) {
      const hand = [...d.currentHand], elbow = [...d.currentElbow], root = [...d.root];
      d.setInteractiveTarget(.3 + .67 * Math.cos(i * .025), .85 + .23 * Math.sin(i * .025));
      const result = d.step(1 / 30);
      if (d.dt !== 1 / 120) throw new Error('Fixed caller dt was not passed to the solver');
      const audit = window.kinematicsTestAudit(`Mixed controller frame ${i}`);
      minimumGap = Math.min(minimumGap, audit.upperGap, audit.lowerGap, audit.targetGap);
      maximumYaw = Math.max(maximumYaw, d.yaw); maximumHandStep = Math.max(maximumHandStep,d.handStep);
      if (result.resolved) {
        accepted++; if (d.chased) localSteps++;
        if (Math.abs(d.acceptedPole - previousPole) > Math.PI / 120 + 1e-12) throw new Error('Chase bypassed accepted pole history');
        previousPole = d.acceptedPole;
      } else {
        held++;
        if ([...d.currentHand].some((x, j) => x !== hand[j]) || [...d.currentElbow].some((x, j) => x !== elbow[j]) || [...d.root].some((x, j) => x !== root[j])) throw new Error('Rejected shoulder/chain was committed');
      }
    }
    if (!(accepted > 100 && maximumYaw > .2 && minimumGap >= .008 - 1e-6)) throw new Error('Mixed scene did not exercise a valid assisted sweep');
    return {accepted, localSteps, held, maximumYaw, minimumGap, maximumHandStep,dtSeconds:1/120,unsafe:0};
  });
  await app.page.locator('#query').selectOption('target');
  const projectionOnly = await app.page.evaluate(() => {
    const d = window.kinematicsDemo, hand = [...d.currentHand], elbow = [...d.currentElbow], root = [...d.root];
    d.setTarget(4,4,4); for (let i = 0; i < 180; i++) d.step(1/60);
    if (!d.targetResult.resolved) throw new Error('Target-only projection did not resolve');
    if ([...d.currentHand].some((x,j) => x !== hand[j]) || [...d.currentElbow].some((x,j) => x !== elbow[j]) || [...d.root].some((x,j) => x !== root[j])) throw new Error('Target-only mode changed the unchecked arm');
    if (!document.querySelector('#status-detail').textContent.includes('not evaluated')) throw new Error('Target-only scope is not explicit');
    return {hand, projected: [...d.projectedTarget], scope: document.querySelector('#scope').textContent};
  });
  assert.ok(projectionOnly.scope.includes('target only'));
  await app.page.locator('#query').selectOption('chain');
  await app.page.locator('#gap').evaluate(input => { input.value = '30'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); });
  await app.page.locator('#damping').selectOption('0');
  await app.page.locator('#budget').selectOption('32');
  assert.equal(await app.page.evaluate(() => window.kinematicsDemo.avoidance.minClearance), .03);
  assert.equal(await app.page.evaluate(() => window.kinematicsDemo.avoidance.damping), 0);
  await app.page.evaluate(() => { window.kinematicsTestAudit('Changed gap and damping start'); });
  await app.page.locator('#scene').selectOption('torso');
  await app.page.locator('#gap').evaluate(input => { input.value='8'; input.dispatchEvent(new Event('change',{bubbles:true})); });
  await app.page.locator('#damping').selectOption('0.12');
  await app.page.locator('#clock').selectOption('live');
  await app.page.locator('#budget').selectOption('128');
  await app.page.locator('#yaw-assist').uncheck();
  await app.page.locator('#reset').click();
  await app.page.locator('summary').first().click();
  await app.page.locator('#recording-panel > summary').click();
  await app.page.locator('#record-start').click();
  assert.equal(await app.page.locator('#recording-indicator').isVisible(), true);
  await app.page.locator('canvas').focus(); await app.page.keyboard.press('ArrowLeft');
  await app.page.locator('#speed').evaluate(input => { input.value='90'; input.dispatchEvent(new Event('input',{bubbles:true})); });
  await app.page.locator('#pause').click(); await app.page.locator('#pause').click();
  await app.page.locator('#record-stop').click();
  const recorded = JSON.parse(await app.page.locator('#interaction-recording-data').inputValue());
  assert.equal(recorded.format,'margo-constraints-interaction'); assert.ok(recorded.frames.length > 0);
  assert.equal(recorded.invalidFrames,0);
  assert.ok(recorded.actions.some(action => action.type === 'speed'));
  for (const key of ['commandTargetX','lastSolveTargetX','lastSolveRootX','acceptedHandStepMeters','acceptedPoleStepRadians']) assert.ok(recorded.columns.includes(key));
  assert.equal(await app.page.locator('#recording-indicator').isVisible(), false);
  assert.equal(await app.page.locator('#record-download').isEnabled(), true);
  await app.page.locator('#record-clear').click(); assert.equal(await app.page.locator('#interaction-recording-data').inputValue(),'');
  await app.page.locator('#recording-panel > summary').click();
  await app.page.screenshot({path: 'test-results/kinematics-constraints-demo.png', fullPage: true});
  await app.page.setViewportSize({width: 390, height: 844});
  assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const report = {initial, torso, adversarial, overhead, waistCrossBody, waistCursorError, returnOverhead, overheadOvershoot, verticalContinuity, singularBoundaries, finalRecovery, motionTransition, capabilities, projectionOnly, recording:{frames:recorded.frames.length,actions:recorded.actions.length,invalidFrames:recorded.invalidFrames}, held, paused, hardware: app.hardware, errors};
  await writeFile('test-results/kinematics-constraints-demo.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await app.close(); }
