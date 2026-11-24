// Height fields on the own solver: the layout Rapier's `heightfield` takes, checked against Rapier itself (the root entry)
// as a black box, and what a body on a field then does. The contact mechanics are proved in kernel/tests/mesh.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { KernelWorld, Physics, loadKernel } from '../dist/next.js';

await Promise.all([Physics.load(), RapierPhysics.load()]);

/** The same numbers every run. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const rows = 6,
  columns = 9,
  scale = [9, 1.5, 4.8],
  r = random(126),
  heights = Float32Array.from({ length: (rows + 1) * (columns + 1) }, () => r() * 2 - 1);

test('the kernel holds the grid where Rapier puts it: column major, rows along z, split from (r + 1, c) to (r, c + 1)', async () => {
  const kernel = new KernelWorld(await loadKernel()),
    mesh = kernel.addHeightfield(rows, columns, heights, scale),
    c = kernel.columns,
    v0 = c.meshFirstVertex[mesh];
  assert.equal(c.meshColumns[mesh], columns);
  assert.equal(c.meshTriangles[mesh], 0, 'no triangle rows');
  const point = (row, column) => {
    const i = v0 + row + (rows + 1) * column;
    return [c.meshVertexX[i], c.meshVertexY[i], c.meshVertexZ[i]];
  };
  // The surface the kernel's triangles make at (x, z): the cell, then the half the diagonal leaves it in.
  const surface = (x, z) => {
    const u = ((x + scale[0] / 2) / scale[0]) * columns,
      v = ((z + scale[2] / 2) / scale[2]) * rows,
      column = Math.min(columns - 1, Math.floor(u)),
      row = Math.min(rows - 1, Math.floor(v)),
      [s, t] = [u - column, v - row],
      h = (rr, cc) => point(rr, cc)[1];
    // First half: corners (r, c), (r + 1, c), (r, c + 1), where s + t <= 1.
    if (s + t <= 1) return h(row, column) + s * (h(row, column + 1) - h(row, column)) + t * (h(row + 1, column) - h(row, column));
    return h(row + 1, column + 1) + (1 - s) * (h(row + 1, column) - h(row + 1, column + 1)) + (1 - t) * (h(row, column + 1) - h(row + 1, column + 1));
  };
  const rapier = new RapierPhysics(null);
  rapier.addBody(null, { type: 'fixed', colliders: { shape: 'heightfield', rows, columns, heights, scale } });
  rapier.update(1 / 60);
  let worst = 0;
  for (let n = 0; n < 300; n++) {
    const x = (r() - 0.5) * scale[0] * 0.999,
      z = (r() - 0.5) * scale[2] * 0.999,
      hit = rapier.raycast([x, 10, z], [0, -1, 0]);
    assert.ok(hit, `Rapier's ray at ${x}, ${z} hits`);
    worst = Math.max(worst, Math.abs(hit.point[1] - surface(x, z)));
  }
  rapier.dispose();
  console.log(`heightfield: worst height difference from Rapier over 300 rays ${worst.toExponential(2)} m`);
  assert.ok(worst < 1e-5, `the kernel's surface stands ${worst} m off Rapier's`);
});

test('addHeightfield names what is wrong with a field', async () => {
  const kernel = new KernelWorld(await loadKernel());
  assert.throws(() => kernel.addHeightfield(0, 2, [0, 0, 0], [1, 1, 1]), /whole rows and columns of cells from 1 up/);
  assert.throws(() => kernel.addHeightfield(1, 2, [0, 0, 0], [1, 1, 1]), /takes \(rows \+ 1\) \* \(columns \+ 1\) = 6 heights \(got 3\)/);
  assert.throws(() => kernel.addHeightfield(1, 1, [0, 0, 0, Number.NaN], [1, 1, 1]), /height 3 is NaN; pass finite heights/);
  assert.throws(() => kernel.addHeightfield(1, 1, [0, 0, 0, 0], [1, 0, 1]), /scale is three finite sizes above zero/);
  assert.throws(() => kernel.addHeightfield(70000, 70000, [], [1, 1, 1]), /under 2\^31 cells/);
});

test('a ball and a box rest on a heightfield, which has no mass and refuses one', () => {
  const physics = new Physics(null),
    flat = new Float32Array(11 * 11).fill(0.25),
    floor = physics.addBody(null, { type: 'fixed', colliders: { shape: 'heightfield', rows: 10, columns: 10, heights: flat, scale: [10, 2, 10] } }),
    ball = physics.addBody(null, { position: [0.3, 2, 0.2], colliders: { shape: 'sphere', radius: 0.5 } }),
    box = physics.addBody(null, { position: [-2.2, 2, 1.7], colliders: { shape: 'box', halfExtents: [0.4, 0.3, 0.5] } });
  for (let i = 0; i < 180; i++) physics.step();
  assert.ok(Math.abs(ball.position[1] - 1) < 2e-3, `the ball rests at ${ball.position[1]}`);
  assert.ok(Math.abs(box.position[1] - 0.8) < 2e-3, `the box rests at ${box.position[1]}`);
  assert.equal(physics.touching(ball, floor), true);
  assert.equal(floor.mass, 0);
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'heightfield', rows: 1, columns: 1, heights: [0, 0, 0, 0], scale: [1, 1, 1], mass: 2 } }),
    /A heightfield has no volume, so no mass or density/,
  );
  physics.dispose();
});

test('a ball rolls down a heightfield ramp as it does on Rapier', () => {
  // A plane tilted 10 degrees about z, as a heightfield of 8 by 8 cells; the same scene on both solvers.
  const n = 8,
    size = 16,
    slope = Math.tan((10 * Math.PI) / 180),
    ramp = Float32Array.from({ length: (n + 1) * (n + 1) }, (_, i) => -(Math.floor(i / (n + 1)) * size) / n * slope),
    field = { shape: 'heightfield', rows: n, columns: n, heights: ramp, scale: [size, 1, size], fixInternalEdges: true, friction: 1 },
    run = (World) => {
      const physics = new World(null);
      physics.addBody(null, { type: 'fixed', colliders: field });
      const ball = physics.addBody(null, { position: [-6, 1.2 + 6 * slope, 0], canSleep: false, colliders: { shape: 'sphere', radius: 0.5, friction: 1 } });
      for (let i = 0; i < 30; i++) physics.step();
      const start = ball.position[0];
      for (let i = 0; i < 60; i++) physics.step();
      const travelled = ball.position[0] - start;
      physics.dispose();
      return travelled;
    };
  const own = run(Physics),
    rapier = run(RapierPhysics);
  console.log(`heightfield ramp: the ball runs ${own.toFixed(4)} m on the own solver and ${rapier.toFixed(4)} m on Rapier in 1 s`);
  assert.ok(Math.abs(own - rapier) < 0.02 * rapier, `own ${own} against Rapier ${rapier}`);
});
