import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box, Geometry } from '../packages/core/dist/extension.js';
import {
  SurfacePhysics,
  Kinematics,
  TelemetryChannel,
  AssemblyBVH,
  measureClearance,
  worldAnchor,
  edgeAnchor,
  ExplodedView,
} from '../packages/machinery/dist/index.js';
async function scene(capacity = 16) {
  return new Engine(
    { width: 200, height: 200, clientWidth: 200, clientHeight: 200 },
    await TransformStore.create(capacity),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function frame(time, entries) {
  const data = new ArrayBuffer(6 + entries.length * 6),
    v = new DataView(data);
  v.setUint32(0, time, true);
  v.setUint16(4, entries.length, true);
  entries.forEach(([id, value], i) => {
    v.setUint16(6 + i * 6, id, true);
    v.setFloat32(8 + i * 6, value, true);
  });
  return data;
}
test('Surface drive uses omega cross r, bounded friction, persistent Wasm memory and carrier transfer', async () => {
  const e = await scene();
  try {
    const roller = e.createMesh(),
      belt = e.createMesh(),
      part = e.createMesh(),
      carriers = [
        { node: roller, angularVelocity: [0, 0, -2], contactOffset: [0, 0.5, 0] },
        { node: belt, velocity: [-2, 0, 0] },
      ],
      s = await SurfacePhysics.create(
        [{ node: part, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.2, friction: 0.1 }],
        carriers,
        { gravity: 10 },
      );
    e.use(s);
    const memory = s.data.buffer;
    s.onPreUpdate(0.1);
    near(s.data[3], 0.1);
    near(part.position.x, 0.01);
    for (let i = 0; i < 9; i++) s.onPreUpdate(0.1);
    near(s.data[3], 1);
    s.setCarrier(0, 1);
    s.onPreUpdate(0.1);
    near(s.data[3], 0.9);
    assert.equal(memory, s.data.buffer);
    const saved = part.position.x;
    s.data[9] = NaN;
    assert.throws(() => s.onPreUpdate(0.1), /Invalid surface/);
    assert.equal(part.position.x, saved);
    assert.throws(() => s.onPreUpdate(-1), /Invalid surface/);
  } finally {
    e.dispose();
  }
});
test('Queuing respects stationary gates in both directions, deceleration, reversal inertia and carrier boundaries', async () => {
  for (const direction of [1, -1]) {
    const e = await scene();
    try {
      const motor = e.createMesh(),
        gate = e.createMesh(),
        left = e.createMesh(),
        right = e.createMesh().setPosition([1.1, 0, 0]),
        carriers = [
          { node: motor, velocity: [direction * 2, 0, 0] },
          { node: gate, velocity: [0, 0, 0] },
        ],
        s = await SurfacePhysics.create(
          [
            { node: left, carrier: direction > 0 ? 0 : 1, lane: 0, axis: [1, 0, 0], halfLength: 0.5, friction: 1 },
            { node: right, carrier: direction > 0 ? 1 : 0, lane: 0, axis: [1, 0, 0], halfLength: 0.5, friction: 1 },
          ],
          carriers,
          { gravity: 10 },
        );
      e.use(s);
      const obstacle = direction > 0 ? right : left,
        position = obstacle.position.x;
      for (let i = 0; i < 30; i++) {
        s.onPreUpdate(0.1);
        assert.ok(right.position.x - left.position.x >= 1 - 1e-5);
        assert.equal(obstacle.position.x, position);
      }
      near(s.data[3], 0);
      near(s.data[4], 0);
      carriers[0].velocity = [-direction * 2, 0, 0];
      s.onPreUpdate(0.1);
      assert.ok(right.position.x - left.position.x >= 1 - 1e-5);
    } finally {
      e.dispose();
    }
  }
  const e = await scene();
  try {
    const motor = e.createMesh(),
      gate = e.createMesh(),
      a = e.createMesh(),
      b = e.createMesh().setPosition([1.1, 0, 0]),
      carriers = [{ node: motor, velocity: [2, 0, 0] }, { node: gate }],
      s = await SurfacePhysics.create(
        [
          { node: a, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.5, friction: 0.1 },
          { node: b, carrier: 1, lane: 0, axis: [1, 0, 0], halfLength: 0.5, friction: 0.1 },
        ],
        carriers,
        { gravity: 10 },
      );
    e.use(s);
    s.data[6] = 1;
    carriers[0].velocity = [-2, 0, 0];
    s.onPreUpdate(0.2);
    near(b.position.x, 1.1);
    assert.ok(b.position.x - a.position.x >= 1 - 1e-5);
    near(s.data[6], 0);
  } finally {
    e.dispose();
  }
});
test('Surface rejects overlapping lanes, stale nodes, parents and conflicting joints', async () => {
  const e = await scene();
  try {
    const motor = e.createMesh(),
      a = e.createMesh(),
      b = e.createMesh().setPosition([0.1, 0, 0]),
      parts = [a, b].map((node) => ({ node, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.5 }));
    await assert.rejects(async () => e.use(await SurfacePhysics.create(parts, [{ node: motor }])), /overlapping/);
    assert.equal(a.position.x, 0);
    assert.equal(b.position.x, Math.fround(0.1));
    b.setPosition([2, 0, 0]);
    const s = await SurfacePhysics.create(parts, [{ node: motor }]);
    e.use(s);
    a.dispose();
    e.createMesh();
    assert.throws(() => s.onPreUpdate(0.1), /disposed/);
  } finally {
    e.dispose();
  }
});
test('Telemetry validates exact binary frames atomically, ignores stale timestamps and clamps stale playback', async () => {
  const e = await scene();
  try {
    const node = e.createMesh(),
      k = new Kinematics([{ node, axis: 'z', min: -1, max: 1 }]);
    e.use(k);
    const t = await TelemetryChannel.create(k, { delay: 100 });
    e.use(t);
    assert.ok(t.push(frame(1000, [[0, 0]]), 100));
    assert.ok(t.push(frame(1100, [[0, 0.1]]), 200));
    t.sample(250);
    near(k.value(0), 0.0375);
    assert.equal(t.push(frame(1100, [[0, 0.8]]), 205), false);
    assert.equal(t.push(frame(1000, [[0, 0.8]]), 206), false);
    for (const data of [
      new ArrayBuffer(5),
      frame(1200, [[0, NaN]]),
      frame(1200, [[0, Infinity]]),
      frame(1200, [[0, 2]]),
      frame(1200, [[1, 0]]),
      frame(1200, [
        [0, 0],
        [0, 0],
      ]),
    ])
      assert.throws(() => t.push(data, 300));
    t.sample(10_000);
    near(k.value(0), 0.1);
    assert.ok(t.push(frame(1200, [[0, 0.2]]), 300));
    t.sample(350);
    near(k.value(0), 0.15);
    assert.ok(Number.isFinite(node.rotation.z));
  } finally {
    e.dispose();
  }
});
test('Telemetry handles u32 clock wrap, sparse packets and coupled-write rollback', async () => {
  const e = await scene();
  try {
    const a = e.createMesh(),
      b = e.createMesh(),
      k = new Kinematics(
        [
          { node: a, axis: 'z', min: -1, max: 1 },
          { node: b, axis: 'z', min: -1, max: 1 },
        ],
        { gears: [{ source: 0, target: 1, ratio: 2 }] },
      );
    e.use(k);
    const t = await TelemetryChannel.create(k, { delay: 0 });
    e.use(t);
    t.push(frame(0xfffffff0, [[0, 0.2]]), 100);
    t.sample(100);
    near(k.value(1), 0.4);
    assert.ok(t.push(frame(20, []), 136));
    t.sample(136);
    near(k.value(0), 0.2);
    assert.throws(() => t.push(frame(30, [[1, 0.2]]), 146), /coupled/);
    assert.throws(() => t.push(frame(40, [[0, 0.8]]), 156), /Coupling/);
    t.sample(1000);
    near(k.value(0), 0.2);
    near(k.value(1), 0.4);
  } finally {
    e.dispose();
  }
});
test('Telemetry reconnects without retaining listeners and reports malformed sensor frames', async () => {
  const e = await scene();
  try {
    const node = e.createMesh(),
      k = new Kinematics([{ node, axis: 'z', min: -1, max: 1 }]);
    e.use(k);
    const errors = [],
      t = await TelemetryChannel.create(k, { onError: (error) => errors.push(error) });
    e.use(t);
    const a = new EventTarget(),
      b = new EventTarget();
    t.connect(a);
    assert.equal(a.binaryType, 'arraybuffer');
    a.dispatchEvent(new MessageEvent('message', { data: frame(100, [[0, 0.2]]) }));
    t.sample();
    near(k.value(0), 0.2);
    a.dispatchEvent(new MessageEvent('message', { data: frame(110, [[0, NaN]]) }));
    assert.equal(errors.length, 1);
    near(k.value(0), 0.2);
    t.connect(b);
    a.dispatchEvent(new MessageEvent('message', { data: frame(120, [[0, 0.9]]) }));
    b.dispatchEvent(new MessageEvent('message', { data: frame(1, [[0, 0.3]]) }));
    t.sample();
    near(k.value(0), 0.3);
    e.removePlugin(t.name);
    b.dispatchEvent(new MessageEvent('message', { data: frame(2, [[0, 0.8]]) }));
    near(k.value(0), 0.3);
  } finally {
    e.dispose();
  }
});
test('Telemetry owns joint motion while attached, resumes velocity after removal and resets PLC clocks', async () => {
  const e = await scene();
  try {
    const node = e.createMesh(),
      k = new Kinematics([{ node, axis: 'z', min: -1, max: 1, velocity: 0.1 }]);
    e.use(k);
    const t = await TelemetryChannel.create(k, { delay: 0 });
    e.use(t);
    t.push(frame(1000, [[0, 0.2]]));
    e.render({ delta: 0.5 });
    near(k.value(0), 0.2);
    t.reset();
    assert.ok(t.push(frame(10, [[0, 0.3]])));
    e.render({ delta: 0.5 });
    near(k.value(0), 0.3);
    e.removePlugin(t.name);
    e.render({ delta: 0.5 });
    near(k.value(0), 0.35);
  } finally {
    e.dispose();
  }
});
test('Assembly BVH ray picking and vertex/edge snapping agree with translated mirrored geometry', async () => {
  const e = await scene(80);
  try {
    const nodes = Array.from({ length: 64 }, (_, i) =>
      e
        .createMesh()
        .setGeometry(box())
        .setPosition([i * 2, 0, 0])
        .setScale(i === 3 ? [-1, 1, 1] : [1, 1, 1]),
    );
    e.render();
    const bvh = await AssemblyBVH.create(nodes);
    const memory = bvh.triangles.buffer;
    for (let i = 0; i < 64; i++) {
      const hit = bvh.raycast([i * 2, 0, 4], [0, 0, -2]);
      assert.equal(hit.node, nodes[i]);
      near(hit.distance, 3.5);
    }
    assert.equal(bvh.raycast([0, 5, 4], [0, 0, -1]), null);
    assert.equal(bvh.raycast([0, 0, 4], [0, 0, -1], 3), null);
    assert.throws(() => bvh.raycast([0, 0, 0], [0, 0, 0]), /nonzero/);
    const hit = bvh.raycast([0.49, 0.49, 4], [0, 0, -1]),
      anchor = bvh.snap(hit, { maxDistance: 0.02 });
    assert.deepEqual(worldAnchor(anchor), [0.5, 0.5, 0.5]);
    assert.ok(bvh.snap(bvh.raycast([0, 0.49, 4], [0, 0, -1]), { kind: 'edge', maxDistance: 0.02 }));
    nodes[0].setPosition([0, 2, 0]);
    e.render();
    bvh.rebuild();
    assert.equal(bvh.raycast([0, 0, 4], [0, 0, -1]), null);
    assert.equal(bvh.raycast([0, 2, 4], [0, 0, -1]).node, nodes[0]);
    assert.equal(bvh.triangles.buffer, memory);
    nodes[0].visible = false;
    e.render();
    bvh.rebuild();
    assert.equal(bvh.raycast([0, 2, 4], [0, 0, -1]), null);
    bvh.dispose();
    assert.throws(() => bvh.raycast([0, 0, 4], [0, 0, -1]), /disposed/);
  } finally {
    e.dispose();
  }
});
test('Clearance computes box Euclidean distance, touching and interference in world space', async () => {
  const e = await scene();
  try {
    const a = e.createMesh().setGeometry(box()),
      b = e.createMesh().setGeometry(box()).setPosition([2, 2, 0]);
    e.render();
    near(measureClearance(a, b, 'aabb').distance, Math.SQRT2);
    assert.equal(measureClearance(a, b).interfering, false);
    b.setPosition([1, 0, 0]);
    e.render();
    assert.deepEqual([measureClearance(a, b).distance, measureClearance(a, b).interfering], [0, false]);
    b.setPosition([0.5, 0, 0]);
    e.render();
    assert.equal(measureClearance(a, b).interfering, true);
    b.setPosition([3, 0, 0]).setRotation([0, 0, Math.PI / 4]);
    e.render();
    near(measureClearance(a, b).distance, 2.5 - Math.SQRT1_2);
    const anchor = edgeAnchor(a, 0, 1);
    assert.equal(anchor.node, a);
    assert.ok(anchor.point.every(Number.isFinite));
    const parent = e.createMesh().setScale([2, 1, 1]);
    b.setParent(parent);
    e.render();
    assert.throws(() => measureClearance(a, b), /shear/);
    assert.ok(Number.isFinite(measureClearance(a, b, 'aabb').distance));
  } finally {
    e.dispose();
  }
});
test('Feature edges keep creases and open boundaries, drop smooth facets, and validate options', async () => {
  const { featureEdges, FeatureEdges } = await import('../packages/machinery/dist/edges.js'),
    g = await import('../packages/geometry/dist/index.js');
  assert.equal(featureEdges(box()).length, 24);
  assert.equal(featureEdges(box(), 100).length, 0);
  const cylinder = g.toGeometry(g.cylinderGeometry(1, 1, 1, 16));
  assert.equal(featureEdges(cylinder, 30).length / 2, 32);
  assert.equal(featureEdges(cylinder, 20).length / 2, 48);
  assert.equal(featureEdges(g.toGeometry(g.sphereGeometry(1, 16, 8)), 30).length, 0);
  assert.equal(featureEdges(g.toGeometry(g.planeGeometry(1, 1, 2, 2))).length / 2, 8);
  const pairs = featureEdges(box());
  assert.ok(pairs.every((v) => v < box().vertices.length / 6));
  assert.throws(() => featureEdges(box(), -1), /angle/);
  for (const options of [{ width: 0 }, { angle: 181 }, { depthBias: -1 }, { depthBias: 0.5 }, { order: NaN }])
    assert.throws(() => new FeatureEdges(options), /options/);
  const e = await scene();
  try {
    assert.throws(() => e.use(new FeatureEdges()), /WebGPU/);
  } finally {
    e.dispose();
  }
});
test('Exploded view writes positions only when the amount changes', async () => {
  const e = await scene();
  try {
    const node = e.createMesh(),
      view = new ExplodedView([{ node, offset: [2, 0, 0] }]);
    e.use(view);
    view.amount = 0.5;
    e.render();
    assert.equal(node.position.x, 1);
    node.position.x = 7;
    e.render();
    assert.equal(node.position.x, 7);
    view.amount = 1;
    e.render();
    assert.equal(node.position.x, 2);
  } finally {
    e.dispose();
  }
});
test('Assembly BVH shares local trees across instances beyond one million instanced triangles', async () => {
  const e = await scene(2100);
  try {
    const g = new Geometry(
      ...(() => {
        const p = [],
          n = [],
          f = [];
        for (let i = 0; i <= 20; i++)
          for (let j = 0; j <= 25; j++) {
            p.push(i / 20 - 0.5, j / 25 - 0.5, 0);
            n.push(0, 0, 1);
          }
        for (let i = 0; i < 20; i++)
          for (let j = 0; j < 25; j++) {
            const a = i * 26 + j;
            f.push(a, a + 26, a + 1, a + 1, a + 26, a + 27);
          }
        return [p, n, f];
      })(),
    );
    const nodes = Array.from({ length: 2048 }, (_, i) =>
      e
        .createMesh()
        .setGeometry(g)
        .setPosition([(i % 64) * 2, Math.floor(i / 64) * 2, 0])
        .setRotation([0, i % 2 ? Math.PI : 0, 0]),
    );
    e.render();
    assert.equal((g.indices.length / 3) * nodes.length, 2_048_000);
    const bvh = await AssemblyBVH.create(nodes);
    for (const i of [0, 77, 1023, 2047]) {
      const p = nodes[i].matrix,
        hit = bvh.raycast([p[12] + 0.1, p[13] + 0.2, 5], [0, 0, -1]);
      assert.equal(hit.node, nodes[i]);
      near(hit.distance, 5);
    }
    nodes[5].setScale([1, 1, 3]).setPosition([10, 0, -2]);
    nodes[5].visible = true;
    e.render();
    bvh.rebuild();
    near(bvh.raycast([10.1, 0.2, 5], [0, 0, -1]).distance, 7);
    bvh.dispose();
  } finally {
    e.dispose();
  }
});
