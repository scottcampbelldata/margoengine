// In its own file, so its own process: an override installed by another test (hull.test.js has several) makes the
// solver's calls megamorphic, which is not how a game runs. It does mix array types, as callers do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { AvoidanceSolver, ConvexHullVolume, SolveStatus } from '../dist/index.js';

const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

test('hull queries and hull solves allocate nothing per call', (t) => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const surface = new Float64Array(3),
    normal = new Float64Array(3),
    out = new Float64Array(1),
    start = new Float64Array(3),
    end = new Float64Array(3);
  const round = (count, radius) => {
    const points = [];
    for (let i = 0; i < count; i++) {
      const y = 1 - (2 * (i + 0.5)) / count,
        r = Math.sqrt(1 - y * y),
        a = i * 2.399963;
      points.push(r * Math.cos(a) * radius, y * radius, r * Math.sin(a) * radius);
    }
    return new ConvexHullVolume({ points });
  };
  const torso = round(32, 0.3),
    head = round(32, 0.15),
    upper = round(16, 0.06),
    forearm = round(16, 0.05),
    near = round(64, 0.4),
    bone = translation(0, 1, 0);
  const solver = new AvoidanceSolver([torso, head], {
    minClearance: 0.001,
    complianceMargin: 0,
    links: [{ hull: upper }, { hull: forearm }],
  });
  const reused = new Float64Array(bone);
  const options = { searchBudget: 16 };
  const rootPosition = new Float64Array([0, 0, 1]),
    target = new Float32Array([0.6, 0, 1]);
  // A two-bone pose with unit bones: the elbow straight above the middle of the root to hand line.
  function armPose(from, to, _angle, output) {
    const hx = to[0] - from[0],
      hy = to[1] - from[1],
      hz = to[2] - from[2],
      half = Math.sqrt(hx * hx + hy * hy + hz * hz) * 0.5;
    output[0] = from[0] + hx * 0.5;
    output[1] = from[1] + hy * 0.5 + Math.sqrt(1 - half * half);
    output[2] = from[2] + hz * 0.5;
  }
  head.setTransform(translation(0, -2, 0));
  const solves = (count) => {
    for (let i = 0; i < count; i++) {
      reused[13] = 2 + (i & 63) * 1e-4;
      torso.setTransform(reused);
      solver.solve(rootPosition, target, target, 1, 1, 0, 0, 1 / 60, armPose, options);
    }
  };
  const shapes = {
    'a clear solve with hull colliders and link hulls': solves,
    'a point outside and a deep point inside': (count) => {
      for (let i = 0; i < count; i++) {
        start[0] = i & 1 ? 2 : 0.01 + (i & 63) * 1e-4;
        near.evaluateInto(start, surface, normal, out);
      }
    },
    'a segment gap and a deep segment overlap': (count) => {
      for (let i = 0; i < count; i++) {
        start[0] = i & 1 ? 2 : -0.1 + (i & 63) * 1e-4;
        end[0] = start[0] + 0.1;
        near.segmentClearanceInto(start, end, 0.01, out);
      }
    },
    'a hull gap and a deep hull overlap': (count) => {
      for (let i = 0; i < count; i++) {
        reused[13] = i & 1 ? 2 : (i & 63) * 1e-4;
        head.setTransform(reused);
        near.hullClearanceInto(head, out);
      }
    },
  };
  torso.setTransform(reused);
  const probe = solver.solve(rootPosition, target, target, 1, 1, 0, 0, 1 / 60, armPose, options);
  assert.equal(probe.status, SolveStatus.Success, 'the solve path is the accepted one');
  // Every array type a caller may pass, before the measured paths settle.
  for (let i = 0; i < 2000; i++) {
    for (const vector of [[0.1, 2, 0.3], new Float32Array([0.1, 2, 0.3]), new Float64Array([0.1, 2, 0.3])]) {
      near.evaluate(vector, [0, 0, 0], [0, 0, 0]);
      near.evaluate(vector, new Float32Array(3), new Float64Array(3));
      near.segmentClearance(vector, [0, 3, 0], 0.01);
      near.segmentClearance(new Float32Array(3), vector, 0.01);
      solver.solve(vector, target, target, 1, 1, 0, 0, 1 / 60, armPose, options);
    }
    head.setTransform(translation(0, -2, 0));
    head.setTransform(new Float32Array(translation(0, -2, 0)));
    solver.reset();
  }
  for (const [name, run] of Object.entries(shapes)) {
    run(20000);
    const windows = [];
    let clean = false;
    // Each window starts from an empty young generation: even 16 bytes per call would grow the heap by 320 KB.
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
