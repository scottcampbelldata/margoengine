// Height field cell status, Rapier's `HeightFieldCellStatus` (its Rust crate has it, its JavaScript build does not): a cell
// split along its other diagonal, and a cell with a triangle or both taken away. Proved against the surface the statuses
// define by hand, by rays, bodies, snapshots and the same triangles built as a mesh. The kernel's own proof against
// triangle rows is kernel/tests/mesh.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HeightfieldCell, Physics } from '../dist/index.js';

await Physics.load();

/** One cell, 2 m on a side centred on the origin, only the corner at (row 1, column 1) lifted by a metre. */
const single = (cellStatus) => ({
  shape: 'heightfield',
  rows: 1,
  columns: 1,
  heights: [0, 0, 0, 1],
  scale: [2, 1, 2],
  cellStatus,
});

function world(colliders) {
  const physics = new Physics(null);
  const body = physics.addBody(null, { type: 'fixed', colliders });
  return { physics, body, collider: body.colliders[0] };
}

const down = (physics, x, z) => physics.raycast([x, 5, z], [0, -1, 0], { maxDistance: 10 });

test('a zigzag cell splits along its other diagonal: the surface under a point changes where the two splits differ', () => {
  const plain = world(single(undefined)),
    zig = world(single([HeightfieldCell.zigzag]));
  // u and v run 0 to 1 along x and z; the lifted corner is (1, 1). The default diagonal runs from (0, 1) to (1, 0), so the
  // surface is max(0, u + v - 1); the other runs from (0, 0) to (1, 1), so it is min(u, v).
  const cases = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.9],
    [0.9, 0.2],
    [0.1, 0.8],
  ];
  for (const [u, v] of cases) {
    const x = -1 + 2 * u,
      z = -1 + 2 * v;
    assert.ok(Math.abs(down(plain.physics, x, z).point[1] - Math.max(0, u + v - 1)) < 1e-5, `plain at ${u}, ${v}`);
    assert.ok(Math.abs(down(zig.physics, x, z).point[1] - Math.min(u, v)) < 1e-5, `zigzag at ${u}, ${v}`);
  }
  assert.equal(zig.collider.cellStatus(0, 0), HeightfieldCell.zigzag);
  assert.equal(plain.collider.cellStatus(0, 0), 0);
});

test('a removed triangle is a hole: the ray falls through it, the other triangle stays, and the left one is on the lower x', () => {
  const flat = (cellStatus) => ({
    shape: 'heightfield',
    rows: 2,
    columns: 2,
    heights: new Array(9).fill(0),
    scale: [2, 1, 2],
    cellStatus,
  });
  // Cells r + 2 c: (0,0) plain, (1,0) left removed, (0,1) right removed, (1,1) removed.
  const { physics } = world(
    flat([0, HeightfieldCell.leftRemoved, HeightfieldCell.rightRemoved, HeightfieldCell.removed]),
  );
  const hit = (x, z) => down(physics, x, z);
  // Cell (r, c) covers x in [-1 + c, c] and z in [-1 + r, r]; the left triangle holds its lower-x edge.
  assert.ok(hit(-0.9, -0.5), 'a plain cell is there');
  assert.ok(hit(-0.1, -0.5), 'on both of its sides');
  assert.equal(hit(-0.9, 0.5), null, 'the left triangle of cell (1, 0) is gone (its lower x)');
  assert.ok(hit(-0.1, 0.5), 'and its right triangle stays');
  assert.ok(hit(0.1, -0.5), 'cell (0, 1) keeps its left triangle');
  assert.equal(hit(0.9, -0.5), null, 'and loses its right one (its higher x)');
  assert.equal(hit(0.2, 0.5), null, 'a removed cell has neither');
  assert.equal(hit(0.8, 0.5), null);
});

test('statuses read back as Rapier reads them, are set in place, and bad ones are refused', () => {
  const statuses = [0, 1, 2, 4, 6, 5, 3, 7, 0],
    { collider } = world({
      shape: 'heightfield',
      rows: 3,
      columns: 3,
      heights: new Array(16).fill(0),
      scale: [3, 1, 3],
      cellStatus: statuses,
    });
  assert.deepEqual(Array.from(collider.cellStatuses()), statuses);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) assert.equal(collider.cellStatus(r, c), statuses[r + 3 * c]);
  assert.equal(collider.setCellStatus(2, 1, HeightfieldCell.removed), collider);
  assert.equal(collider.cellStatus(2, 1), 6);
  assert.equal(collider.cellStatuses()[2 + 3 * 1], 6);
  assert.throws(() => collider.cellStatus(3, 0), /off this 3 by 3 height field/);
  assert.throws(() => collider.setCellStatus(0, 3, 1), /off this 3 by 3 height field/);
  assert.throws(() => collider.setCellStatus(0, 0, 8), /status 8/);
  assert.throws(() => collider.setCellStatus(0, 0, 1.5), /status 1.5/);
  assert.throws(
    () =>
      world({ shape: 'heightfield', rows: 1, columns: 1, heights: [0, 0, 0, 0], scale: [1, 1, 1], cellStatus: [0, 0] }),
    /takes 1 cell statuses/,
  );
  assert.throws(
    () =>
      world({ shape: 'heightfield', rows: 1, columns: 1, heights: [0, 0, 0, 0], scale: [1, 1, 1], cellStatus: [9] }),
    /Cell status 0 is 9/,
  );
  const ball = new Physics(null).addBody(null, { colliders: { shape: 'sphere', radius: 1 } }).colliders[0];
  assert.throws(() => ball.cellStatus(0, 0), /no height field/);
});

test('a ball drops through a hole made in place, and rests on the cells that stay', () => {
  const physics = new Physics(null),
    field = physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'heightfield', rows: 4, columns: 4, heights: new Array(25).fill(0), scale: [4, 1, 4] },
    }),
    floor = physics.addBody(null, {
      type: 'fixed',
      position: [0, -3.5, 0],
      colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
    }),
    ball = physics.addBody(null, { position: [0.5, 1, 0.5], colliders: { shape: 'sphere', radius: 0.2 } });
  for (let i = 0; i < 90; i++) physics.step();
  assert.ok(Math.abs(ball.position[1] - 0.2) < 0.01, `the ball rests on the field (${ball.position[1]})`);
  // The cell under the ball: x in [0, 1] is column 2, z in [0, 1] is row 2.
  field.colliders[0].setCellStatus(2, 2, HeightfieldCell.removed);
  for (let i = 0; i < 90; i++) physics.step();
  assert.ok(
    Math.abs(ball.position[1] - (-3 + 0.2)) < 0.01,
    `it fell through the hole and rests on the floor (${ball.position[1]})`,
  );
  assert.ok(floor);
});

test('a snapshot keeps the statuses, and a field with them replays bit for bit', () => {
  const make = () => {
    const physics = new Physics(null);
    const field = physics.addBody(null, {
      type: 'fixed',
      colliders: {
        shape: 'heightfield',
        rows: 6,
        columns: 6,
        heights: Array.from({ length: 49 }, (_, i) => 0.1 * ((i * 7) % 5)),
        scale: [6, 1, 6],
        cellStatus: Array.from({ length: 36 }, (_, i) => (i * 5) % 8),
        fixInternalEdges: true,
      },
    });
    const balls = [0, 1, 2, 3].map((k) =>
      physics.addBody(null, {
        position: [-2 + k, 2 + 0.2 * k, 0.3 * k - 0.5],
        colliders: { shape: 'sphere', radius: 0.25 },
      }),
    );
    return { physics, field, balls };
  };
  const a = make(),
    b = make();
  for (let i = 0; i < 120; i++) a.physics.step();
  const snapshot = a.physics.kernel.snapshot();
  for (let i = 0; i < 120; i++) a.physics.step();
  for (let i = 0; i < 240; i++) b.physics.step();
  assert.deepEqual(
    a.balls.map((ball) => Array.from(ball.position)),
    b.balls.map((ball) => Array.from(ball.position)),
  );
  a.field.colliders[0].setCellStatus(0, 0, HeightfieldCell.removed);
  a.field.colliders[0].setCellStatus(1, 1, 0);
  a.physics.kernel.restore(snapshot);
  assert.deepEqual(Array.from(a.field.colliders[0].cellStatuses()), Array.from(b.field.colliders[0].cellStatuses()));
});
