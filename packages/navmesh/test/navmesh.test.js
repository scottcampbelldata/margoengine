import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh, avoid } from '../dist/index.js';
test('A* and funnel shorten shared-edge corridors without leaving walkable polygons', () => {
  const mesh = new NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [4, 0, 0],
      [4, 0, 2],
      [4, 0, 4],
      [2, 0, 4],
    ],
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [2, 5, 6, 7],
    ],
  );
  assert.deepEqual(mesh.path([0.5, 0, 1], [3.5, 0, 1]), [
    [0.5, 0, 1],
    [3.5, 0, 1],
  ]);
  const bent = mesh.path([0.5, 0, 0.5], [3, 0, 3.5]);
  assert.ok(bent.length >= 2);
  for (let i = 1; i < bent.length; i++)
    for (let t = 0; t <= 1; t += 0.05)
      assert.ok(mesh.locate(bent[i].map((v, k) => v * t + bent[i - 1][k] * (1 - t))) >= 0);
  assert.equal(mesh.path([-1, 0, 0], [3, 0, 3]), null);
  assert.throws(
    () =>
      new NavMesh(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 0, 1],
          [0.2, 0, 0.2],
        ],
        [[0, 1, 3, 2]],
      ),
    /convex/,
  );
  const disconnected = new NavMesh(
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
      [3, 0, 0],
      [4, 0, 0],
      [3, 0, 1],
    ],
    [
      [0, 1, 2],
      [3, 4, 5],
    ],
  );
  assert.equal(disconnected.path([0.1, 0, 0.1], [3.1, 0, 0.1]), null);
});
test('ORCA agents avoid head-on collision, remain speed bounded and handle overlap', () => {
  const a = { id: 1, position: [-2, 0], velocity: [1, 0], preferred: [1, 0], radius: 0.4, maxSpeed: 1 };
  const b = { ...a, id: 2, position: [2, 0], velocity: [-1, 0], preferred: [-1, 0] };
  for (let i = 0; i < 180; i++) {
    const va = avoid(a, [b]),
      vb = avoid(b, [a]);
    assert.ok(Math.hypot(...va) <= 1.00001 && Math.hypot(...vb) <= 1.00001);
    a.velocity = [...va];
    b.velocity = [...vb];
    a.position = a.position.map((v, k) => v + va[k] / 60);
    b.position = b.position.map((v, k) => v + vb[k] / 60);
    assert.ok(Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]) >= 0.799);
  }
  b.position = [...a.position];
  assert.ok([...avoid(a, [b])].every(Number.isFinite));
  assert.throws(() => avoid(a, [b], 0), /timestep/);
});
test('ORCA validates component values without spreading vectors on stable ticks', () => {
  let iterations = 0;
  const vector = (values) =>
    Object.defineProperty(values, Symbol.iterator, {
      value: function* () {
        iterations++;
        yield this[0];
        yield this[1];
      },
    });
  const a = {
    id: 1,
    position: vector([-2, 0]),
    velocity: vector([1, 0]),
    preferred: vector([1, 0]),
    radius: 0.4,
    maxSpeed: 1,
  };
  const b = {
    id: 2,
    position: vector([2, 0]),
    velocity: vector([-1, 0]),
    preferred: vector([-1, 0]),
    radius: 0.4,
    maxSpeed: 1,
  };
  const output = new Float64Array(2),
    neighbors = [b];
  for (let i = 0; i < 120; i++) {
    assert.equal(avoid(a, neighbors, 1 / 60, 2, output), output);
    assert.deepEqual(Array.from(output), [0.96, -0.19595917942265426]);
  }
  assert.equal(iterations, 0, 'validation must not allocate a six-component spread array for each agent');
  for (const field of ['position', 'velocity', 'preferred'])
    for (const axis of [0, 1])
      for (const invalid of [NaN, Infinity, -Infinity]) {
        const previous = a[field][axis];
        a[field][axis] = invalid;
        assert.throws(() => avoid(a, neighbors, 1 / 60, 2, output), /Invalid ORCA agent/);
        a[field][axis] = previous;
      }
  for (const field of ['position', 'velocity', 'preferred'])
    assert.throws(() => avoid({ ...a, [field]: [0] }, neighbors), /Invalid ORCA agent/);
});
