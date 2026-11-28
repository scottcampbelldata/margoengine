import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'orbit-thread-isolation',
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

function workFor(bodies, threads, forceEvaluations) {
  const masses = bodies.filter((body) => body.mass > 0).length;
  const tracers = bodies.length - masses;
  if (threads === 1) {
    const geometry = (masses * (masses - 1)) / 2 + masses * tracers;
    return [
      {
        pairGeometryEvaluations: geometry * forceEvaluations,
        sourceContributions: (masses * (masses - 1) + masses * tracers) * forceEvaluations,
      },
    ];
  }
  return Array.from({ length: threads }, (_, part) => {
    const start = Math.floor((part * bodies.length) / threads);
    const end = Math.floor(((part + 1) * bodies.length) / threads);
    const contributions = bodies.slice(start, end).reduce((sum, body) => sum + masses - Number(body.mass > 0), 0);
    return {
      pairGeometryEvaluations: forceEvaluations * contributions,
      sourceContributions: forceEvaluations * contributions,
    };
  });
}

function totalMomentumPerMass(rows) {
  const mass = rows.reduce((total, body) => total + body.mass, 0);
  return [0, 1, 2].map((axis) => rows.reduce((sum, body) => sum + (body.velocity[axis] * body.mass) / mass, 0));
}

try {
  const output = await page.evaluate(async () => {
    const { OrbitSolver } = await import('/packages/physics/dist/orbit.js');
    const windowError = await OrbitSolver.load({ threads: 4 }).then(
      (solver) => {
        solver[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/orbit-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated orbit worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The orbit worker returned an unreadable receipt.'));
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
    output.cases.map((entry) => entry.scene),
    ['vacuum', 'atmosphere'],
  );

  for (const { scene, baseline, receipts, noDrag } of output.cases) {
    const { bodies, farCell, end, substeps, timeScale } = output;
    const forceEvaluations = 1 + substeps * (scene === 'vacuum' ? 3 : 1);
    const expectedTime = (end * timeScale) / 60;
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
      const threads = run.threads ?? 1;
      assert.equal(run.helpers, threads - 1);
      assert.equal(run.hash, baseline.hash);
      assert.equal(run.exactReplay, true);
      assert.deepEqual(run.initialCell, farCell);
      assert.deepEqual(run.shiftedCell, [0, 0, 0]);
      assert.deepEqual(run.restoredCell, farCell);
      assert.deepEqual(run.fields, baseline.fields);
      assert.deepEqual(run.sample, baseline.sample);
      if (run.threads !== undefined) assert.ok(run.exactStart && run.exactCheckpoint && run.exactFinal);

      const workers = workFor(bodies, threads, forceEvaluations);
      const expectedWork = {
        threads,
        forceEvaluations,
        pairGeometryEvaluations: workers.reduce((sum, work) => sum + work.pairGeometryEvaluations, 0),
        sourceContributions: workers.reduce((sum, work) => sum + work.sourceContributions, 0),
        workers,
      };
      assert.deepEqual(run.work, expectedWork);
      assert.deepEqual(run.replayWork, run.work);
      assert.deepEqual(run.coldWork, {
        threads,
        forceEvaluations: 0,
        pairGeometryEvaluations: 0,
        sourceContributions: 0,
        workers: workers.map(() => ({ pairGeometryEvaluations: 0, sourceContributions: 0 })),
      });
    }
    assert.equal(baseline.elapsed, expectedTime);
    assert.deepEqual(baseline.fields, [
      baseline.sample.flatMap((row) => row.position),
      baseline.sample.flatMap((row) => row.velocity),
      [expectedTime],
    ]);
    assert.ok(baseline.fields.every((values) => values.every(Number.isFinite)));
    assert.notDeepEqual(baseline.sample[0].position, bodies[0].position);
    assert.notDeepEqual(baseline.sample[1].position, bodies[1].position);

    // All atmosphere drag belongs to massless tracers. Massive momentum is conserved in both cases.
    const initial = totalMomentumPerMass(bodies);
    const accepted = totalMomentumPerMass(baseline.sample);
    const speed = Math.max(...bodies.map((body) => Math.hypot(...body.velocity)));
    const tolerance = 32 * Number.EPSILON * speed * forceEvaluations * end;
    assert.ok(Math.hypot(...accepted.map((value, axis) => value - initial[axis])) <= tolerance);
    if (noDrag) {
      assert.notEqual(baseline.hash, noDrag.hash);
      for (const [i, row] of baseline.sample.entries()) {
        if (row.mass > 0) assert.deepEqual(row, noDrag.sample[i]);
        else assert.ok(Math.hypot(...row.velocity) < Math.hypot(...noDrag.sample[i].velocity));
      }
    }

    const threaded = receipts.at(-1);
    console.log(
      'SPACE-01 Chromium',
      scene,
      threaded.hash + ':',
      threaded.work.forceEvaluations,
      'force sweeps,',
      baseline.work.pairGeometryEvaluations,
      'serial geometry evaluations,',
      threaded.work.pairGeometryEvaluations,
      'parallel geometry evaluations and',
      threaded.work.sourceContributions,
      'source contributions with three helpers.',
    );
  }
} finally {
  await close();
}
