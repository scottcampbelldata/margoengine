import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
const app = await openBrowser({
  startPath: '/examples/kinematics-constraints.html',
  port: 5211,
  args,
  aliases: { '@margoengine/kinematics-constraints': resolve('packages/kinematics-constraints/dist/index.js') },
});
try {
  await app.page.waitForFunction(() => window.kinematicsDemo || document.querySelector('#error')?.textContent);
  assert.equal(await app.page.locator('#error').textContent(), '');
  const measurements = await app.page.evaluate(() => {
    const demo = window.kinematicsDemo,
      dt = 1 / 60;
    document.querySelector('#reset').click();
    const alpha = -Math.expm1(-dt / demo.avoidance.damping);
    let acceptedAngle = demo.result.poleAngle;
    function normalize(vector) {
      const length = Math.hypot(vector[0], vector[1], vector[2]);
      return vector.map((value) => value / length);
    }
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    function snapshot() {
      if (demo.result.resolved) acceptedAngle = demo.result.poleAngle;
      const axis = normalize(Array.from(demo.currentHand, (value, index) => value - demo.root[index]));
      const p = Array.from(demo.currentElbow, (value, index) => value - demo.root[index]);
      const along = dot(p, axis),
        radial = normalize(p.map((value, index) => value - axis[index] * along));
      const side = cross(axis, radial),
        cosine = Math.cos(acceptedAngle),
        sine = Math.sin(acceptedAngle);
      const reference = normalize(radial.map((value, index) => value * cosine - side[index] * sine));
      return {
        hand: Array.from(demo.currentHand),
        elbow: Array.from(demo.currentElbow),
        axis,
        reference,
        poleAngle: acceptedAngle,
        status: demo.result.status,
        resolved: demo.result.resolved,
      };
    }
    function transported(reference, previousAxis, axis) {
      const v = cross(previousAxis, axis),
        cosine = Math.max(-1, Math.min(1, dot(previousAxis, axis)));
      let result = reference.slice();
      if (cosine > -1 + 1e-8) {
        const first = cross(v, reference),
          second = cross(v, first);
        result = reference.map((value, index) => value + first[index] + second[index] / (1 + cosine));
      }
      const along = dot(result, axis);
      return normalize(result.map((value, index) => value - along * axis[index]));
    }
    const samples = [],
      counts = [0, 0, 0, 0];
    let maximumTransportErrorRad = 0,
      maximumClearFilterError = 0;
    function step(x, y, z, phase, index) {
      const before = snapshot();
      demo.setTarget(x, y, z);
      const expectedFilteredX = Math.fround(before.hand[0] + (demo.rawTarget[0] - before.hand[0]) * alpha);
      demo.step(dt);
      const after = snapshot();
      counts[after.status]++;
      const expectedReference = transported(before.reference, before.axis, after.axis);
      const transportErrorRad = Math.atan2(
        Math.hypot(...cross(expectedReference, after.reference)),
        dot(expectedReference, after.reference),
      );
      if (after.resolved) maximumTransportErrorRad = Math.max(maximumTransportErrorRad, transportErrorRad);
      const filterError = Math.abs(after.hand[0] - expectedFilteredX);
      if (phase === 'ramp' || phase === 'reversal')
        maximumClearFilterError = Math.max(maximumClearFilterError, filterError);
      const sample = {
        phase,
        index,
        raw: Array.from(demo.rawTarget),
        hand: after.hand,
        elbow: after.elbow,
        status: after.status,
        handVelocityX: (after.hand[0] - before.hand[0]) / dt,
        predictedFilterVelocityX: (expectedFilteredX - before.hand[0]) / dt,
        poleAngle: after.poleAngle,
        transportErrorRad,
        filterError,
      };
      samples.push(sample);
      return sample;
    }
    // A clear, reachable lateral ramp isolates temporal damping from obstacle
    // projection, pole-rate failures and singularity margins.
    demo.setTarget(0.9, 0.85, 0.14);
    for (let i = 0; i < 180; i++) demo.step(dt);
    for (let i = 1; i <= 60; i++) step(0.9 + (0.25 * i) / 60, 0.85, 0.14, 'ramp', i);
    let handReversalFrame = null,
      modelReversalFrame = null;
    for (let i = 1; i <= 60; i++) {
      const sample = step(1.15 - (0.25 * i) / 60, 0.85, 0.14, 'reversal', i);
      if (handReversalFrame === null && sample.handVelocityX < -1e-7) handReversalFrame = i;
      if (modelReversalFrame === null && sample.predictedFilterVelocityX < -1e-7) modelReversalFrame = i;
    }
    // Rapidly reverse the reach-axis direction through an overhead path, then
    // compare the recovered zero-angle bend with same-frame parallel transport.
    const waypoints = [
      [0.9, 0.85, 0.14],
      [0.6, 1.85, 0.2],
      [0.9, 0.85, 0.14],
      [0.6, 1.85, 0.2],
      [1.1, 1.3, 0.14],
    ];
    for (let segment = 1; segment < waypoints.length; segment++) {
      const start = waypoints[segment - 1],
        end = waypoints[segment];
      for (let i = 1; i <= 40; i++)
        step(
          start[0] + ((end[0] - start[0]) * i) / 40,
          start[1] + ((end[1] - start[1]) * i) / 40,
          start[2] + ((end[2] - start[2]) * i) / 40,
          `overhead-${segment}`,
          i,
        );
    }
    return {
      dt,
      dampingSeconds: demo.avoidance.damping,
      filterAlpha: alpha,
      samples: samples.length,
      statusCounts: counts,
      handReversalFrame,
      modelReversalFrame,
      reversalDelayMs: handReversalFrame * dt * 1000,
      maximumClearFilterError,
      maximumTransportErrorRad,
      maximumTransportErrorDegrees: (maximumTransportErrorRad * 180) / Math.PI,
      rawSamples: samples,
      interpretation:
        'Synchronous deterministic controller steps, not render-frame timing. A recovered reference is compared with transport to the current accepted reach axis. Held poses are counted separately; their frame history does not advance.',
    };
  });
  assert.ok(
    Number.isInteger(measurements.handReversalFrame) && measurements.handReversalFrame > 0,
    'Hand never reversed direction',
  );
  assert.equal(
    measurements.handReversalFrame,
    measurements.modelReversalFrame,
    'Hand reversal differs from its configured damping model',
  );
  assert.ok(
    measurements.maximumClearFilterError < 2e-6,
    'The clear lateral path has an unexplained filter discrepancy',
  );
  assert.ok(
    measurements.maximumTransportErrorDegrees < 0.01,
    'Accepted bend reference has an unexplained transport discrepancy',
  );
  const sourceSHA256 = {};
  for (const path of ['packages/kinematics-constraints/dist/index.js', 'examples/kinematics-constraints.html']) {
    sourceSHA256[path] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  const report = { hardware: app.hardware, sourceSHA256, measurements };
  await writeFile('test-results/kinematics-constraints-motion.json', JSON.stringify(report, null, 2));
  const { rawSamples, ...summary } = measurements;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await app.close();
}
