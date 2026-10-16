import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GazeTarget } from '../examples/skinning-ik/gaze-target.ts';
import { gripPosition, localPoint, worldPosition } from '../examples/skinning-ik/rig-ik.ts';

const optical = [0, 0.19, -0.232],
  geometry = { front: -0.236, targetRadius: 0.10465342044830322, margin: 0.003 },
  near = (a, b, epsilon = 2e-6) =>
    assert.ok(Math.hypot(...a.map((v, i) => v - b[i])) < epsilon, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

async function fixture(transformed = false) {
  const store = await TransformStore.create(8),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    root = engine.createMesh(),
    body = engine.createMesh().setParent(root),
    head = engine.createMesh().setParent(body).setPosition([0, 1.15, 0]);
  if (transformed) root.setPosition([2, -0.3, 1]).setRotation([0.25, -0.55, 0.17]).setScale([1.7, 1.7, 1.7]);
  store.tick(false);
  return { store, engine, root, body, head, policy: new GazeTarget(head, root, optical, geometry) };
}

test('near-face conditioning derives the viewable radius from the actual optical and proxy geometry', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const out = [0, 0, 0],
    requested = [0.072093226, 1.2092939615, -0.2827683687],
    matrices = [f.root, f.body, f.head].map((node) => [...node.matrix]);
  assert.equal(f.policy.project(requested, out), out);
  assert.equal(f.policy.projected, true);
  assert.equal(out[0], requested[0]);
  assert.equal(out[1], requested[1]);
  assert.ok(out[2] < requested[2] - 0.09);
  const pivot = worldPosition(f.head),
    d = Math.hypot(...out.map((v, i) => v - pivot[i])),
    lambda = optical[2] + Math.sqrt(d * d - optical[0] ** 2 - optical[1] ** 2),
    targetHeadZ = optical[2] - lambda;
  assert.ok(Math.abs(d - f.policy.conditionedRadius) < 1e-12);
  assert.ok(targetHeadZ <= geometry.front - geometry.targetRadius - geometry.margin - 0.0009999);
  assert.deepEqual(
    [f.root, f.body, f.head].map((node) => [...node.matrix]),
    matrices,
    'conditioning never moves the rig',
  );
  const raw = [...requested];
  f.policy.project(raw, raw);
  near(raw, out);
});

test('world and local conditioning follow moving torso pivots, root rotation and uniform scale', async (t) => {
  for (const transformed of [false, true]) {
    const f = await fixture(transformed);
    t.after(() => f.engine.dispose());
    for (const yaw of [0, -0.4, -0.85, -0.1]) {
      f.body.setRotation([0, yaw, 0]);
      f.store.tick(false);
      const target = [0.08, 1.2, -0.25],
        local = [0, 0, 0],
        world = [0, 0, 0];
      f.policy.projectLocal(target, local);
      f.policy.project(gripPosition(f.root, target), world);
      near(localPoint(f.root, world), local);
      assert.equal(local[0], target[0]);
      assert.equal(local[1], target[1]);
      const pivot = localPoint(f.root, worldPosition(f.head));
      assert.ok(Math.abs(Math.hypot(...local.map((v, i) => v - pivot[i])) - f.policy.conditionedRadius) < 1e-6);
    }
    // The head's own aimed orientation must not feed back into the workspace.
    const before = f.policy.projectLocal([0, 1.18, -0.25], [0, 0, 0]);
    f.head.setRotation([0.7, -0.4, 0.2]);
    f.store.tick(false);
    near(f.policy.projectLocal([0, 1.18, -0.25], [0, 0, 0]), before);
  }
});

test('far workspace and full side extent stay unchanged while close targets preserve X and Y', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  for (const target of [
    [-0.48, 1.17, -0.23],
    [-0.4, 0.7, -0.05],
    [-0.24, 1.69, 0],
    [0.235, 1.16, -0.32],
    [0, 1.2, 2],
  ]) {
    const out = [0, 0, 0];
    f.policy.project(target, out);
    assert.deepEqual(out, target);
    assert.equal(f.policy.projected, false);
  }
  for (const target of [
    [0, 1.18, -0.25],
    [0.235, 1.16, -0.3],
    [0.05, 1.2, -0.25],
  ]) {
    const out = [0, 0, 0];
    f.policy.projectLocal(target, out);
    assert.equal(out[0], target[0]);
    assert.equal(out[1], target[1]);
    assert.ok(out[2] < target[2]);
  }
});

test('candidate clearance catches interpolated chords, and enabling gaze inside recovers without invalidating the held pose', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const out = new Float64Array(1),
    pivot = worldPosition(f.head),
    r = f.policy.conditionedRadius,
    a = [pivot[0] - r * 0.8, pivot[1], pivot[2] - r * 0.6],
    b = [pivot[0] + r * 0.8, pivot[1], pivot[2] - r * 0.6],
    chord = a.map((v, i) => (v + b[i]) / 2);
  f.policy.beginStep(a);
  f.policy.clearance(a, out);
  assert.ok(out[0] > 0);
  f.policy.clearance(chord, out);
  assert.ok(out[0] < -0.1);
  const inside = [0, 1.18, -0.25];
  f.policy.beginStep(inside);
  f.policy.clearance(inside, out);
  assert.ok(out[0] >= 0 && out[0] < 0.000011);
  f.policy.clearance([0, 1.18, -0.24], out);
  assert.ok(out[0] < 0);
  f.policy.clearance([0, 1.18, -0.26], out);
  assert.ok(out[0] > 0);
  f.policy.beginStep([0, 1.18, -0.26]);
  f.policy.clearance(inside, out);
  assert.ok(out[0] < 0, 'newly gained workspace is retained on the next real step');
});

test('invalid inputs and changed hierarchy scales fail without mutating destinations or the rig', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const out = [4, 5, 6],
    rotation = [...f.head.matrix];
  for (const target of [
    [NaN, 0, 0],
    [0, Infinity, 0],
    [1e40, 0, 0],
    ['1', 0, 0],
    [true, 0, 0],
    [0, 0],
  ]) {
    assert.throws(() => f.policy.project(target, out), /finite/);
    assert.deepEqual(out, [4, 5, 6]);
  }
  for (const options of [
    { ...geometry, front: NaN },
    { ...geometry, targetRadius: -1 },
    { ...geometry, margin: -1 },
    { ...geometry, reserve: Infinity },
  ])
    assert.throws(() => new GazeTarget(f.head, f.root, optical, options), /geometry/);
  assert.deepEqual([...f.head.matrix], rotation);
  f.body.setScale([1, 2, 1]);
  assert.throws(() => f.policy.project([0, 1.18, -0.25], out), /uniform/);
  assert.deepEqual(out, [4, 5, 6]);
});

test('unchanged far world targets survive tiny model scales, while projected world overflow fails atomically', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const out = [4, 5, 6];
  f.root.setScale([1e-20, 1e-20, 1e-20]);
  f.store.tick(false);
  f.policy.project([1e20, 0, 0], out);
  assert.deepEqual(out, [1e20, 0, 0]);
  assert.equal(f.policy.projected, false);
  f.head.setPosition([0, 0, 0]);
  f.root.setPosition([0, 0, 3e38]).setRotation([0, Math.PI, 0]).setScale([3e38, 3e38, 3e38]);
  f.store.tick(false);
  out[0] = 4;
  out[1] = 5;
  out[2] = 6;
  assert.throws(() => f.policy.project([0, 0, 3e38], out), /precision/);
  assert.deepEqual(out, [4, 5, 6]);
  assert.equal(f.policy.projected, false);
});

test('reversal waypoints leave the inward chord with bounded useful tangent progress', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const accepted = [0.35, 1.15, -0.2],
    goal = [-0.48, 1.17, -0.23],
    out = [0, 0, 0],
    pivot = worldPosition(f.head),
    gap = new Float64Array(1),
    limit = 1.8 / 60;
  f.policy.beginStep(accepted);
  assert.equal(f.policy.waypoint(accepted, goal, limit, out), out);
  assert.ok(Math.hypot(...out.map((v, i) => v - accepted[i])) <= limit + 1e-12);
  assert.ok(Math.hypot(...out.map((v, i) => v - goal[i])) < Math.hypot(...accepted.map((v, i) => v - goal[i])));
  // Independent samples of the short requested chord stay outside the full
  // physical radius; the raw accepted->Home segment passes through its inside.
  let rawMinimum = Infinity;
  for (let i = 0; i <= 100; i++) {
    const blend = i / 100,
      intermediate = accepted.map((v, axis) => v + (out[axis] - v) * blend);
    f.policy.clearance(intermediate, gap);
    assert.ok(gap[0] > 0);
    rawMinimum = Math.min(
      rawMinimum,
      Math.hypot(...accepted.map((v, axis) => v + (goal[axis] - v) * blend - pivot[axis])),
    );
  }
  assert.ok(rawMinimum < f.policy.minimumRadius - 0.1);
  for (const invalid of [-1, NaN, Infinity]) {
    const before = [...out];
    assert.throws(() => f.policy.waypoint(accepted, goal, invalid, out), /step/);
    assert.deepEqual(out, before);
  }
});

test('a lagged clear command is capped from the accepted hand, and antipodes choose a stable model-space tangent', async (t) => {
  for (const transformed of [false, true]) {
    const f = await fixture(transformed);
    t.after(() => f.engine.dispose());
    const out = [0, 0, 0],
      limit = 0.03,
      accepted = gripPosition(f.root, [-0.7, 1.15, -0.4]),
      far = gripPosition(f.root, [-1.5, 1.15, -0.4]);
    f.policy.beginStep(accepted);
    f.policy.waypoint(accepted, far, limit, out);
    assert.ok(Math.abs(Math.hypot(...out.map((v, i) => v - accepted[i])) - limit) < 1e-12);
    const p = gripPosition(f.root, [0, 1.15, -0.45]),
      routes = [];
    f.policy.beginStep(p);
    for (const side of [-1e-8, 0, 1e-8]) {
      f.policy.waypoint(p, gripPosition(f.root, [side, 1.15, 0.45]), limit, out);
      assert.ok(Math.hypot(...out.map((v, i) => v - p[i])) <= limit + 1e-12);
      const local = localPoint(f.root, out);
      assert.ok(Math.abs(local[0]) > 0.01, 'opposition makes actual lateral progress');
      routes.push(local);
    }
    near(routes[0], routes[1]);
    near(routes[1], routes[2]);
  }
});

test('no-solve clearance refreshes external geometry without advancing recovery history', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const accepted = [0, 1.18, -0.25],
    candidate = [0, 1.18, -0.26],
    out = new Float64Array(1);
  f.policy.beginStep(accepted);
  f.policy.clearance(candidate, out);
  const before = out[0];
  f.root.setPosition([2, -0.3, 1]).setRotation([0.25, -0.55, 0.17]).setScale([1.7, 1.7, 1.7]);
  f.store.tick(false);
  f.policy.clearance(gripPosition(f.root, candidate), out);
  assert.ok(Math.abs(out[0] / 1.7 - before) < 2e-7);
  const value = out[0];
  for (let probe = 0; probe < 20; probe++) {
    f.policy.clearance(gripPosition(f.root, candidate), out);
    assert.equal(out[0], value);
  }
  f.body.setScale([1, 2, 1]);
  assert.throws(() => f.policy.clearance(gripPosition(f.root, candidate), out), /uniform/);
  assert.equal(out[0], value);
});
