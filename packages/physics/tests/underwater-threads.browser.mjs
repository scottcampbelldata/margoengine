import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'underwater-thread-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/tools/shot/blank.html',
  port: 'free',
  softwareAdapterOk: true,
  plugins: [isolation],
});

function boundaryCount({ depth, declination }, length, bottom) {
  const unfolded = depth + length * Math.sin(declination);
  return unfolded < 0 ? Math.ceil(-unfolded / bottom) : Math.floor(unfolded / bottom);
}

function checkedNativeWork(run, scene) {
  const { work, threads } = run;
  const count = scene.launches.length;
  assert.equal(work.threads, threads);
  assert.equal(work.rays, count);
  assert.equal(work.workers.length, threads);
  for (const key of ['rays', 'driftIntegrals', 'boundaryCrossings'])
    assert.equal(
      work.workers.reduce((sum, worker) => sum + worker[key], 0),
      work[key],
    );
  for (const [i, worker] of work.workers.entries()) {
    const start = Math.floor((i * count) / threads);
    const stop = Math.floor(((i + 1) * count) / threads);
    assert.equal(worker.rays, stop - start);
    assert.ok(worker.driftIntegrals >= worker.rays);
    if (scene.name === 'uniform') {
      const speed = scene.profile[0].speed;
      const bottom = scene.profile[1].depth;
      const currentLength = (scene.end * speed) / 60;
      const lastLength = ((scene.end - 1) * speed) / 60;
      const crossed = scene.launches
        .slice(start, stop)
        .reduce(
          (sum, launch) =>
            sum + boundaryCount(launch, currentLength, bottom) - boundaryCount(launch, lastLength, bottom),
          0,
        );
      assert.equal(worker.boundaryCrossings, crossed);
      assert.equal(worker.driftIntegrals, worker.rays + crossed);
    }
  }
  assert.deepEqual(run.replayWork, work);
}

function closeTo(actual, expected, scale = Math.max(Math.abs(expected), 1)) {
  // Up to 23 world steps and their boundary intersections precede evaluation.
  assert.ok(Math.abs(actual - expected) <= 4096 * Number.EPSILON * scale, actual + ' versus ' + expected);
}

function speedAt(profile, depth) {
  const index = profile.findIndex((knot) => knot.depth >= depth);
  const hi = profile[index];
  if (hi.depth === depth) return hi.speed;
  const lo = profile[index - 1];
  return lo.speed + ((hi.speed - lo.speed) * (depth - lo.depth)) / (hi.depth - lo.depth);
}

try {
  const output = await page.evaluate(async () => {
    const { UnderwaterAcousticsSolver } = await import('/packages/physics/dist/underwater.js');
    const windowError = await UnderwaterAcousticsSolver.load({ threads: 4 }).then(
      (solver) => {
        solver[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/underwater-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated acoustic worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The acoustic worker returned an unreadable receipt.'));
      });
      return { isolated: crossOriginIsolated, windowError, ...receipt };
    } finally {
      clearTimeout(timer);
      worker.terminate();
    }
  });
  assert.equal(output.isolated, true);
  assert.equal(output.windowError?.name, 'MargoError');
  assert.equal(output.windowError?.code, 'unsupported');
  assert.match(output.windowError.message, /worker.*threads: 1/i);
  assert.equal(output.error, undefined, output.error);
  assert.deepEqual(
    output.cases.map((item) => item.name),
    ['uniform', 'stratified'],
  );
  for (const scene of output.cases) {
    const { name, end, farCell, profile, launches, baseline, receipts } = scene;
    assert.deepEqual(
      receipts.map((item) => [item.shared, item.threads]),
      [
        [false, 1],
        [true, 1],
        [true, 2],
        [true, 4],
      ],
    );
    for (const run of [baseline, ...receipts]) {
      assert.equal(run.helpers, run.threads - 1);
      assert.equal(run.hash, baseline.hash);
      assert.ok(run.exactReplay);
      assert.deepEqual(run.initialCell, farCell);
      assert.deepEqual(run.shiftedCell, [0, 0, 0]);
      assert.deepEqual(run.restoredCell, farCell);
      assert.deepEqual(run.sample, baseline.sample);
      assert.deepEqual(run.signal, baseline.signal);
      assert.deepEqual(run.delay, baseline.delay);
      if (run.native) {
        assert.ok(run.exactStart && run.exactCheckpoint && run.exactFinal);
        checkedNativeWork(run, scene);
      }
    }
    const bottom = profile.at(-1).depth;
    for (const [index, launch] of launches.entries()) {
      const sample = baseline.sample[index];
      assert.ok(Object.values(sample).every(Number.isFinite));
      assert.ok(sample.depth >= 0 && sample.depth <= bottom && sample.pathLength > 0 && sample.width > 0);
      closeTo(sample.travelTime, end / 60);
      closeTo(baseline.delay[index], end / 60);
      closeTo(Math.hypot(baseline.signal[2 * index], baseline.signal[2 * index + 1]), Math.abs(sample.pressure));
      closeTo(
        Math.cos(sample.declination) / sample.soundSpeed,
        Math.cos(launch.declination) / speedAt(profile, launch.depth),
      );
      if (name === 'uniform') {
        const length = (profile[0].speed * end) / 60;
        const unfolded = launch.depth + length * Math.sin(launch.declination);
        const phase = ((unfolded % (2 * bottom)) + 2 * bottom) % (2 * bottom);
        closeTo(sample.depth, Math.min(phase, 2 * bottom - phase), bottom);
        closeTo(sample.range, length * Math.cos(launch.declination), length);
        assert.equal(sample.reflections, boundaryCount(launch, length, bottom));
      }
    }
    const work = receipts.at(-1).work;
    assert.ok(work.boundaryCrossings > 0 && baseline.sample.some((sample) => sample.reflections > 0));
    console.log(
      'SOUND-03 isolated',
      name,
      baseline.hash + ':',
      work.rays,
      'rays,',
      work.driftIntegrals,
      'drift integrals and',
      work.boundaryCrossings,
      'boundary crossings with three nested workers.',
    );
  }
} finally {
  await close();
}
