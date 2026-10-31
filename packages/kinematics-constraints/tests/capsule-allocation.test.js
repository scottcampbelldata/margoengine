// In its own file, so its own process: other tests install overrides that make the solver's calls megamorphic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { AvoidanceSolver, CapsuleVolume, closestPointsBetweenSegments, SolveStatus } from '../dist/index.js';

// Results written to tuples ([0, 0, 0] points) still allocate about 12 B per call; the README says to reuse typed arrays.
// The public evaluate() and segmentClearance() return a fractional number, which is a heap allocation by itself; the
// solver uses internal destination-passing paths for built-in capsules, which is what this measures.
test('capsule solves and segment kernels allocate nothing per call', (t) => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const p = new Float64Array(3),
    q = new Float64Array(3),
    typedResult = {
      pointA: new Float64Array(3),
      pointB: new Float64Array(3),
      distance: 0,
      parameterA: 0,
      parameterB: 0,
    };
  const torso = new CapsuleVolume({ start: [0, 1.6, 0], end: [0, 2.4, 0], radius: 0.3 }),
    head = new CapsuleVolume({ start: [0, -2, 0], end: [0, -1.8, 0], radius: 0.15 });
  const solver = new AvoidanceSolver([torso, head], { minClearance: 0.001, complianceMargin: 0 });
  const options = { searchBudget: 16 };
  const rootPosition = new Float64Array([0, 0, 1]),
    target = new Float32Array([0.6, 0, 1]);
  function armPose(from, to, _angle, output) {
    const hx = to[0] - from[0],
      hy = to[1] - from[1],
      hz = to[2] - from[2],
      half = Math.sqrt(hx * hx + hy * hy + hz * hz) * 0.5;
    output[0] = from[0] + hx * 0.5;
    output[1] = from[1] + hy * 0.5 + Math.sqrt(1 - half * half);
    output[2] = from[2] + hz * 0.5;
  }
  const solves = (count) => {
    for (let i = 0; i < count; i++) {
      torso.start[1] = 1.6 + (i & 63) * 1e-4;
      solver.solve(rootPosition, target, target, 1, 1, 0, 0, 1 / 60, armPose, options);
    }
  };
  const shapes = {
    'a clear solve with capsule colliders': solves,
    'closest points of a segment and the capsule axis, apart and crossing, into a reused typed result': (count) => {
      for (let i = 0; i < count; i++) {
        p[0] = i & 1 ? 2 : -0.1 + (i & 63) * 1e-4;
        p[1] = 2;
        q[0] = p[0] + 0.1;
        q[1] = i & 2 ? 2.5 : 2;
        closestPointsBetweenSegments(p, q, torso.start, torso.end, typedResult);
      }
    },
  };
  const probe = solver.solve(rootPosition, target, target, 1, 1, 0, 0, 1 / 60, armPose, options);
  assert.equal(probe.status, SolveStatus.Success, 'the solve path is the accepted one');
  // Every array type a caller may pass, before the measured paths settle.
  for (let i = 0; i < 2000; i++) {
    for (const vector of [[0.1, 2, 0.3], new Float32Array([0.1, 2, 0.3]), new Float64Array([0.1, 2, 0.3])]) {
      torso.evaluate(vector, [0, 0, 0], [0, 0, 0]);
      torso.evaluate(vector, new Float32Array(3), new Float64Array(3));
      torso.segmentClearance(vector, [0, 3, 0], 0.01);
      torso.segmentClearance(new Float32Array(3), vector, 0.01);
      solver.solve(vector, target, target, 1, 1, 0, 0, 1 / 60, armPose, options);
    }
    solver.reset();
  }
  for (const [name, run] of Object.entries(shapes)) {
    run(20000);
    const windows = [];
    let clean = false;
    for (let attempt = 0; attempt < 5 && !clean; attempt++) {
      gc();
      const profiler = new GCProfiler(),
        before = process.memoryUsage().heapUsed;
      profiler.start();
      run(20000);
      const { statistics } = profiler.stop(),
        grown = process.memoryUsage().heapUsed - before;
      windows.push({ collections: statistics.length, grown });
      clean = statistics.length === 0 && grown < 64 * 1024;
    }
    assert.ok(clean, `${name}: every window of 20,000 allocated: ${JSON.stringify(windows)}`);
    t.diagnostic(`${name}: ${windows.at(-1).grown} B over 20,000`);
  }
});
