import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { RaycastProjection } from '../dist/index.js';

async function world(backend = 'webgl2') {
  return new Engine(
    { width: 600, height: 480, clientWidth: 600, clientHeight: 480 },
    await TransformStore.create(64),
    { backend, gpu: null, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}
const close = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} differs from ${b}`);
const triple = (a, b) => a.forEach((n, i) => close(n, b[i]));

test('finite extreme rectangle ratios clamp safely to include or exclude a small edge', async () => {
  const e = await world(),
    control = CameraProjection.attach(e, { mode: 'orthographic', height: 4 }),
    p = RaycastProjection.capture(e);
  try {
    const a = [-0.001, 0, 0],
      b = [0.001, 0, 0],
      all = [...p.rectangle(-1e308, 239, 1e308, 241).segmentSamples(a, b)];
    assert.equal(all.length, 5);
    assert(all.every((h) => Number.isFinite(h.screen.x) && Number.isFinite(h.point[0])));
    assert.deepEqual([...p.rectangle(1e308, 239, 1.1e308, 241).segmentSamples(a, b)], []);
  } finally {
    p.dispose();
    control.dispose();
    e.dispose();
  }
});

test('unclipped guide segments match endpoint projections and results never alias inputs or later calls', async () => {
  const e = await world(),
    p = RaycastProjection.capture(e),
    a = [-1, 0, 0],
    b = [1, 0, 0];
  try {
    const startA = p.project(a),
      endB = p.project(b);
    const segment = p.projectSegment(a, b);
    assert.deepEqual(segment, { a: [-1, 0, 0], b: [1, 0, 0], start: startA, end: endB });
    assert.notEqual(segment.a, a);
    assert.notEqual(segment.b, b);
    segment.a[0] = 2;
    segment.start.x = 99;
    segment.b[1] = 2;
    segment.end.y = 99;
    const again = p.projectSegment(a, b);
    assert.deepEqual(again, { a: [-1, 0, 0], b: [1, 0, 0], start: startA, end: endB });
    assert.equal(again.a[0], -1);
    assert.equal(again.b[1], 0);
    assert.notEqual(again.start.x, 99);
    assert.deepEqual(a, [-1, 0, 0]);
    a[0] = 2;
    const changed = p.project(a);
    assert.notEqual(changed.x, again.start.x);
    assert.deepEqual(changed, p.project([2, 0, 0]));
  } finally {
    p.dispose();
    e.dispose();
  }
});

test('point distance has independent CSS distance and owned world/screen results on both backends', async () => {
  for (const backend of ['webgl2', 'webgpu']) {
    const e = await world(backend),
      p = RaycastProjection.capture(e),
      point = [0, 0, 0];
    try {
      const h = p.pointDistance(point, 303, 244);
      assert.deepEqual(h, { point: [0, 0, 0], screen: { x: 300, y: 240, depth: 4 }, distance: 5 });
      point[0] = 8;
      h.point[1] = 99;
      h.screen.x = 0;
      assert.deepEqual(p.pointDistance([0, 0, 0], 303, 244), {
        point: [0, 0, 0],
        screen: { x: 300, y: 240, depth: 4 },
        distance: 5,
      });
      assert.equal(p.pointDistance([0, 0, 5], 0, 0), null);
      assert(p.pointDistance([100, 0, -10000], 0, 0));
    } finally {
      p.dispose();
      e.dispose();
    }
  }
});

test('closest projected segment uses perspective harmonic world parameter and clamps endpoints', async () => {
  for (const backend of ['webgl2', 'webgpu']) {
    const e = await world(backend),
      p = RaycastProjection.capture(e);
    try {
      const a = [-1, 0, 0],
        b = [1, 0, -4],
        s = p.project(a),
        t = p.project(b),
        x = (s.x + t.x) / 2,
        h = p.closestSegmentPoint(a, b, x, 240);
      triple(h.point, [-1 / 3, 0, -4 / 3]);
      close(h.screen.x, x);
      close(h.screen.depth, 16 / 3);
      close(h.distance, 0);
      const end = p.closestSegmentPoint(a, b, t.x + 80, t.y);
      assert.deepEqual(end.point, b);
      close(end.distance, 80);
      const start = p.closestSegmentPoint(a, b, s.x - 80, s.y);
      assert.deepEqual(start.point, a);
      close(start.distance, 80);
    } finally {
      p.dispose();
      e.dispose();
    }
  }
});

test('orthographic closest segment is linear and retains input direction and owned values', async () => {
  const e = await world(),
    control = CameraProjection.attach(e, { mode: 'orthographic', height: 4 }),
    p = RaycastProjection.capture(e);
  try {
    const a = [-1, 0, 0],
      b = [1, 0, -4],
      h = p.closestSegmentPoint(a, b, 300, 244);
    triple(h.point, [0, 0, -2]);
    assert.deepEqual(h.screen, { x: 300, y: 240, depth: 6 });
    assert.equal(h.distance, 4);
    h.point[0] = 99;
    h.screen.x = 0;
    assert.deepEqual(p.closestSegmentPoint(b, a, 300, 244).point, [0, 0, -2]);
    assert.deepEqual(a, [-1, 0, 0]);
    assert.deepEqual(b, [1, 0, -4]);
  } finally {
    p.dispose();
    control.dispose();
    e.dispose();
  }
});

test('zero projected length deliberately picks first endpoint and reversed depth changes', async () => {
  const e = await world(),
    p = RaycastProjection.capture(e);
  try {
    assert.deepEqual(p.closestSegmentPoint([0, 0, 0], [0, 0, -4], 300, 240), {
      point: [0, 0, 0],
      screen: { x: 300, y: 240, depth: 4 },
      distance: 0,
    });
    assert.equal(p.closestSegmentPoint([0, 0, -4], [0, 0, 0], 300, 240).screen.depth, 8);
    assert.equal(p.closestSegmentPoint([1, 0, 0], [1, 0, 0], 300, 240).point[0], 1);
  } finally {
    p.dispose();
    e.dispose();
  }
});

test('near clipping is explicit for guide segments while pick and marquee retain endpoint rejection', async () => {
  const e = await world(),
    control = CameraProjection.attach(e, { mode: 'orthographic', height: 4 });
  e.camera.near = 2;
  const p = RaycastProjection.capture(e);
  try {
    const a = [0, 0, 3],
      b = [0, 0, 1],
      r = p.projectSegment(a, b, { nearPadding: 0.25 });
    assert.deepEqual(r.a, [0, 0, 1.75]);
    assert.deepEqual(r.b, b);
    assert.deepEqual(r.start, { x: 300, y: 240, depth: 2.25 });
    assert.deepEqual(r.end, { x: 300, y: 240, depth: 3 });
    assert.equal(p.closestSegmentPoint(a, b, 300, 240), null);
    assert.deepEqual([...p.rectangle(0, 0, 600, 480).segmentSamples(a, b)], []);
    assert.equal(p.projectSegment([0, 0, 3], [0, 0, 2.5]), null);
    assert.equal(p.projectSegment([0, 0, 2], [0, 0, 1]).start.depth, 2);
    const back = p.projectSegment(b, a, { nearPadding: 0.25 });
    assert.deepEqual(back.a, b);
    assert.deepEqual(back.b, [0, 0, 1.75]);
    r.a[0] = 99;
    r.start.x = 99;
    assert.equal(p.projectSegment(a, b, { nearPadding: 0.25 }).start.x, 300);
    assert.deepEqual(a, [0, 0, 3]);
  } finally {
    p.dispose();
    control.dispose();
    e.dispose();
  }
});

test('rectangle normalizes reversed corners with inclusive containment and owned ray sample order', async () => {
  const e = await world(),
    control = CameraProjection.attach(e, { mode: 'orthographic', height: 4 }),
    p = RaycastProjection.capture(e);
  try {
    const r = p.rectangle(420, 300, 180, 180);
    assert.deepEqual(r.canvasSamples(), [
      [180, 180],
      [420, 180],
      [180, 300],
      [420, 300],
      [300, 240],
    ]);
    assert(r.project([-0.9, 0, 0]));
    assert(r.project([0.9, 0, 0]));
    assert.equal(r.project([-1.00001, 0, 0]), null);
    assert.equal(r.project([0, 0, 5]), null);
    const boundary = p.project([-1, 0, 0]);
    assert.deepEqual(p.rectangle(boundary.x, boundary.y, boundary.x, boundary.y).project([-1, 0, 0]), boundary);
    const samples = r.canvasSamples();
    samples[0][0] = 99;
    samples.pop();
    assert.equal(r.canvasSamples()[0][0], 180);
    assert.equal(r.canvasSamples().length, 5);
  } finally {
    p.dispose();
    control.dispose();
    e.dispose();
  }
});

test('rectangle clips a long edge and samples the exact included span in established order', async () => {
  const e = await world(),
    control = CameraProjection.attach(e, { mode: 'orthographic', height: 4 }),
    p = RaycastProjection.capture(e);
  try {
    const a = [-2, 0, 0],
      b = [2, 0, 0],
      r = p.rectangle(180, 239, 420, 241),
      hits = [...r.segmentSamples(a, b)];
    assert.equal(hits.length, 5);
    // Camera matrices use standard Float32 storage; invert that captured coefficient for the analytic world oracle.
    hits.forEach((h, i) => {
      const x = [300, 216, 384, 180, 420][i];
      close(h.screen.x, x);
      close(h.point[0], (x / 300 - 1) / e.camera.matrix[0]);
      close(h.distance, 0);
      assert.equal(h.screen.depth, 4);
    });
    [...r.segmentSamples(b, a)].forEach((h, i) => close(h.screen.x, [300, 384, 216, 420, 180][i]));
    assert.deepEqual([...p.rectangle(0, 0, 600, 200).segmentSamples(a, b)], []);
  } finally {
    p.dispose();
    control.dispose();
    e.dispose();
  }
});

test('rectangle zero spans retain all five repeated samples and parallel exclusions are exact', async () => {
  const e = await world(),
    control = CameraProjection.attach(e, { mode: 'orthographic', height: 4 }),
    p = RaycastProjection.capture(e);
  try {
    const r = p.rectangle(300, 240, 300, 240),
      hits = [...r.segmentSamples([-2, 0, 0], [2, 0, 0])];
    assert.equal(hits.length, 5);
    assert(hits.every((h) => h.screen.x === 300 && h.screen.y === 240));
    const coincident = [...r.segmentSamples([0, 0, 0], [0, 0, -2])];
    assert.equal(coincident.length, 5);
    assert(coincident.every((h) => h.screen.depth === 4));
    assert.deepEqual([...p.rectangle(301, 0, 302, 480).segmentSamples([0, -1, 0], [0, 1, 0])], []);
  } finally {
    p.dispose();
    control.dispose();
    e.dispose();
  }
});

test('rectangle perspective samples lie on both world edge and clipped CSS span', async () => {
  const e = await world(),
    p = RaycastProjection.capture(e);
  try {
    const a = [-1, 0, 0],
      b = [1, 0, -4],
      s = p.project(a),
      t = p.project(b),
      r = p.rectangle(s.x + 10, 239, t.x - 10, 241),
      hits = [...r.segmentSamples(a, b)];
    assert.equal(hits.length, 5);
    for (const h of hits) {
      const screen = p.project(h.point);
      close(screen.x, h.screen.x);
      close(screen.y, h.screen.y);
      close(h.point[2], -2 * (h.point[0] + 1));
      assert(h.screen.x >= s.x + 10 - 1e-10 && h.screen.x <= t.x - 10 + 1e-10);
    }
  } finally {
    p.dispose();
    e.dispose();
  }
});

test('segment iterator copies endpoints eagerly but yields distinct owned results lazily', async () => {
  const e = await world(),
    control = CameraProjection.attach(e, { mode: 'orthographic', height: 4 }),
    p = RaycastProjection.capture(e);
  try {
    const a = [-2, 0, 0],
      b = [2, 0, 0],
      r = p.rectangle(180, 239, 420, 241),
      it = r.segmentSamples(a, b);
    a[0] = 99;
    b[1] = 99;
    const first = it.next().value;
    assert.equal(first.screen.x, 300);
    first.point[0] = 99;
    first.screen.x = 99;
    const second = it.next().value;
    close(second.point[0], (216 / 300 - 1) / e.camera.matrix[0]);
    close(second.screen.x, 216);
    p.dispose();
    assert.throws(() => it.next(), /disposed/i);
    assert.throws(() => r.canvasSamples(), /disposed/i);
    assert.throws(() => r.project([0, 0, 0]), /disposed/i);
    assert.throws(() => r.segmentSamples([0, 0, 0], [1, 0, 0]), /disposed/i);
  } finally {
    p.dispose();
    control.dispose();
    e.dispose();
  }
});

test('screen primitives retain captured camera/canvas and reject owner Engine disposal', async () => {
  const e = await world(),
    p = RaycastProjection.capture(e),
    r = p.rectangle(0, 0, 600, 480);
  try {
    const before = p.closestSegmentPoint([-1, 0, 0], [1, 0, 0], 300, 240);
    e.camera.position = [9, 8, 7];
    e.camera.target = [3, 2, 1];
    e.camera.near = 10;
    e.canvas.clientWidth = 17;
    e.canvas.clientHeight = 19;
    assert.deepEqual(p.closestSegmentPoint([-1, 0, 0], [1, 0, 0], 300, 240), before);
    assert.equal(r.project([0, 0, 0]).x, 300);
    assert.equal(p.projectSegment([-1, 0, 0], [1, 0, 0]).start.depth, 4);
    e.dispose();
    for (const call of [
      () => p.pointDistance([0, 0, 0], 0, 0),
      () => p.closestSegmentPoint([0, 0, 0], [1, 0, 0], 0, 0),
      () => p.projectSegment([0, 0, 0], [1, 0, 0]),
      () => p.rectangle(0, 0, 1, 1),
      () => r.canvasSamples(),
    ])
      assert.throws(call, /disposed/i);
  } finally {
    p.dispose();
    e.dispose();
  }
});

test('screen methods reject malformed coordinates, shapes and policies before publishing results', async () => {
  const e = await world(),
    p = RaycastProjection.capture(e),
    r = p.rectangle(0, 0, 600, 480);
  try {
    for (const v of [NaN, Infinity, -Infinity, '3', undefined]) {
      assert.throws(() => p.pointDistance([0, 0, 0], v, 0));
      assert.throws(() => p.closestSegmentPoint([0, 0, 0], [1, 0, 0], 0, v));
      assert.throws(() => p.rectangle(0, 0, v, 1));
    }
    for (const point of [null, [], [0, 0], [0, 0, NaN], [0, 0, 0, 0]]) {
      assert.throws(() => p.pointDistance(point, 0, 0));
      assert.throws(() => p.closestSegmentPoint([0, 0, 0], point, 0, 0));
      assert.throws(() => p.projectSegment(point, [0, 0, 0]));
      assert.throws(() => r.segmentSamples(point, [0, 0, 0]));
    }
    for (const nearPadding of [-1, NaN, Infinity, '1'])
      assert.throws(() => p.projectSegment([0, 0, 0], [1, 0, 0], { nearPadding }));
    assert.throws(() => p.projectSegment([0, 0, 0], [1, 0, 0], null));
    assert.throws(() => p.projectSegment([0, 0, 0], [1, 0, 0], []));
  } finally {
    p.dispose();
    e.dispose();
  }
});

test('getter-induced projection disposal cannot publish point, segment, rectangle or iterator output', async () => {
  const e = await world();
  try {
    for (const mode of ['point', 'closest', 'line', 'rect', 'iterator']) {
      const p = RaycastProjection.capture(e),
        r = p.rectangle(0, 0, 600, 480),
        bad = {
          length: 3,
          get 0() {
            p.dispose();
            return 0;
          },
          1: 0,
          2: 0,
        };
      const call =
        mode === 'point'
          ? () => p.pointDistance(bad, 0, 0)
          : mode === 'closest'
            ? () => p.closestSegmentPoint([1, 0, 0], bad, 0, 0)
            : mode === 'line'
              ? () => p.projectSegment(bad, [1, 0, 0])
              : mode === 'rect'
                ? () => r.project(bad)
                : () => r.segmentSamples(bad, [1, 0, 0]);
      assert.throws(call, /disposed/i);
      p.dispose();
    }
    const p = RaycastProjection.capture(e);
    assert.throws(
      () =>
        p.projectSegment([0, 0, 0], [1, 0, 0], {
          get nearPadding() {
            p.dispose();
            return 0;
          },
        }),
      /disposed/i,
    );
  } finally {
    e.dispose();
  }
});
