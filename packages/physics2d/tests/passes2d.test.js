// Extra solver passes through the facade: set, read, validated, carried by a snapshot, and they carry a heavy stack to rest where the
// other island, which asked for none, is untouched. The kernel's own proof is kernel/tests/passes.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

/** Two columns of 20 boxes 40 m apart, the top box of each 100 times as heavy; the first column's bodies ask for `extra` passes. */
function columns(extra) {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, -10] });
  physics.addBody(null, { type: 'fixed', position: [0, -0.5], colliders: { shape: 'box', width: 120, height: 1 } });
  const out = [[], []];
  [-20, 20].forEach((x, k) => {
    for (let i = 0; i < 20; i++) {
      const body = physics.addBody(null, {
        position: [x, 0.5 + i],
        canSleep: false,
        colliders: { shape: 'box', width: 1, height: 1, density: i === 19 ? 100 : 1 },
      });
      if (k === 0 && extra) body.additionalPgsIterations = extra;
      out[k].push(body);
    }
  });
  return { physics, left: out[0], right: out[1] };
}

const top = (column) => 19.5 - column[19].position[1];

test('extra solver passes read back, reject what is not a count, and survive a snapshot', () => {
  const { physics, left, right } = columns(3);
  assert.equal(left[5].additionalPgsIterations, 3);
  assert.equal(right[5].additionalPgsIterations, 0);
  for (const bad of [-1, 1.5, Number.NaN, 2 ** 32])
    assert.throws(() => (left[5].additionalPgsIterations = bad), RangeError);
  const bytes = physics.snapshot();
  left[5].additionalPgsIterations = 0;
  physics.restore(bytes);
  assert.equal(left[5].additionalPgsIterations, 3, 'a snapshot carries it');
});

test('a column with extra passes reaches its resting squash, and the column that asked for none is the one it was', () => {
  const plain = columns(0);
  const asked = columns(16);
  const converged = columns(64);
  for (let i = 0; i < 120; i++) {
    plain.physics.step();
    asked.physics.step();
    converged.physics.step();
  }
  // Two seconds in, one pass is still creeping toward the squash the heavy top gives the column (0.2641 against 0.3661); sixteen
  // more are at it. The converged one, 64 more, is the reference.
  const rest = top(converged.left);
  assert.ok(Math.abs(rest - 0.3661) < 1e-3, `the converged squash moved to ${rest}`);
  assert.ok(Math.abs(top(plain.left) - rest) > 0.05, `one pass has already arrived: ${top(plain.left)}`);
  assert.ok(Math.abs(top(asked.left) - rest) < 1e-3, `sixteen more have not: ${top(asked.left)}`);
  assert.deepEqual(
    asked.right.map((b) => [...b.position, b.rotation]),
    plain.right.map((b) => [...b.position, b.rotation]),
    'the island that asked for nothing changed',
  );
});
