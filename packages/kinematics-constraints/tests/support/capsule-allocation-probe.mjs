// Runs in its own process (tests/capsule-allocation.test.js starts it with --expose-gc, --allow-natives-syntax and
// --no-concurrent-recompilation): how much each capsule kernel allocates per call. Prints JSON, one entry per shape:
// { name, clean, windows: [{ collections, grown }], status }.
import { GCProfiler } from 'node:v8';
import { AvoidanceSolver, CapsuleVolume, closestPointsBetweenSegments, SolveStatus } from '../../dist/index.js';

const status = new Function('f', 'return %GetOptimizationStatus(f)');
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
if (probe.status !== SolveStatus.Success) throw new Error(`the solve path is not the accepted one: ${probe.status}`);
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
const results = [];
for (const [name, run] of Object.entries(shapes)) {
  run(20000);
  // The drivers compute fractional inputs, which unoptimized code boxes: a call of run() that starts in the interpreter
  // allocates about 16 B per iteration until on-stack replacement lands (some 6,000 iterations), and that is the
  // driver's garbage, not the kernel's. Run until run() itself has Turbofan code (bit 64 of %GetOptimizationStatus), at
  // most 2,000 times, so each window enters optimized code from its first call.
  for (let round = 0; round < 2000 && !(status(run) & 64); round++) run(100);
  const windows = [];
  let clean = false;
  for (let attempt = 0; attempt < 5 && !clean; attempt++) {
    globalThis.gc();
    const profiler = new GCProfiler(),
      before = process.memoryUsage().heapUsed;
    profiler.start();
    run(20000);
    const { statistics } = profiler.stop(),
      grown = process.memoryUsage().heapUsed - before;
    windows.push({ collections: statistics.length, grown });
    clean = statistics.length === 0 && grown < 64 * 1024;
  }
  results.push({ name, clean, windows, status: status(run) });
}
console.log(JSON.stringify(results));
