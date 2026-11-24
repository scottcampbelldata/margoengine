// A compound made of hull parts that meet face to face (the cuts of a convex decomposition), with its internal edges fixed
// (Rapier's `CompoundFlags.FIX_INTERNAL_EDGES`): a ball or a box crosses the join as it crosses one hull, where the unfixed
// compound kicks it. Rapier 0.21's JavaScript build has no such flag, so the oracle is the same floor as one hull.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

/** A slab 6 m deep, 0.5 m thick with its top at `top`, from x0 to x1, as the points of a hull. */
const slab = (x0, x1, top = 0) => {
  const points = [];
  for (const x of [x0, x1]) for (const y of [top - 0.5, top]) for (const z of [-3, 3]) points.push(x, y, z);
  return { shape: 'convexHull', points };
};

/** Sends a body along x over the floor; its largest vertical speed and where it ends. */
function roll(floor, body) {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', colliders: floor });
  const mover = physics.addBody(null, {
    position: [-3.5, 0.5, 0],
    linearVelocity: [4, 0, 0],
    canSleep: false,
    ...body,
  });
  let bump = 0;
  for (let i = 0; i < 120; i++) {
    physics.step();
    if (i > 5) bump = Math.max(bump, Math.abs(mover.linearVelocity[1]));
  }
  const out = { bump, x: mover.position[0], y: mover.position[1] };
  physics.dispose();
  return out;
}

const ball = { colliders: { shape: 'sphere', radius: 0.3, friction: 0 }, position: [-3.5, 0.3 + 1e-3, 0] };
const crate = {
  colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], friction: 0 },
  position: [-3.5, 0.3 + 1e-3, 0],
};
// Lying across the way it goes, a quarter turn about x, so it rolls.
const capsule = {
  colliders: { shape: 'capsule', halfHeight: 0.2, radius: 0.2, friction: 0 },
  position: [-3.5, 0.2 + 1e-3, 0],
  rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
};

test('a ball, a box and a capsule cross the join of two parts with fixInternalEdges as they cross one hull', () => {
  for (const [name, body] of [
    ['ball', ball],
    ['crate', crate],
    ['capsule', capsule],
  ]) {
    const one = roll(slab(-4, 4), body);
    const split = roll({ shape: 'compound', parts: [slab(-4, 0), slab(0, 4)] }, body);
    const fixed = roll({ shape: 'compound', fixInternalEdges: true, parts: [slab(-4, 0), slab(0, 4)] }, body);
    assert.ok(one.bump < 1e-4, `${name} on one hull is steady (${one.bump})`);
    assert.ok(fixed.bump < 1e-3, `${name} across the fixed join is steady (${fixed.bump})`);
    assert.ok(
      Math.abs(fixed.x - one.x) < 1e-3 && Math.abs(fixed.y - one.y) < 1e-3,
      `${name} ends where it does on one hull (${fixed.x}, ${fixed.y} against ${one.x}, ${one.y})`,
    );
    if (name !== 'crate') assert.ok(split.bump > 0.1, `${name} on the unfixed join is kicked (${split.bump})`);
  }
});

test('several joins, and a decomposition collider, are fixed the same way', () => {
  const parts = [slab(-4, -1.3), slab(-1.3, 0.7), slab(0.7, 4)];
  const fixed = roll({ shape: 'compound', fixInternalEdges: true, parts }, ball);
  assert.ok(fixed.bump < 1e-3, `three parts (${fixed.bump})`);
  const decomposed = roll({ shape: 'convexDecomposition', fixInternalEdges: true, parts }, ball);
  assert.ok(decomposed.bump < 1e-3, `as a convexDecomposition collider (${decomposed.bump})`);
});

test('a step between parts is not a join: nothing is fixed, and the run is the unfixed one bit for bit', () => {
  const parts = [slab(-4, 0), slab(0, 4, -0.3)];
  const same = (flag) => {
    const physics = new Physics(null);
    physics.addBody(null, { type: 'fixed', colliders: { shape: 'compound', fixInternalEdges: flag, parts } });
    const mover = physics.addBody(null, { ...ball, linearVelocity: [4, 0, 0], canSleep: false });
    for (let i = 0; i < 90; i++) physics.step();
    const out = [...mover.position, ...mover.linearVelocity];
    physics.dispose();
    return out;
  };
  assert.deepEqual(same(true), same(false));
});

test('a part meeting nothing, or a part that is not a hull, leaves the compound as it was', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    type: 'fixed',
    colliders: {
      shape: 'compound',
      fixInternalEdges: true,
      parts: [slab(-4, 0), { shape: 'box', halfExtents: [1, 0.25, 1], offset: [5, 0, 0] }],
    },
  });
  assert.equal(body.colliders.length, 1);
  assert.equal(physics.kernel.fixCompoundEdges(body.colliders[0].handle), 0, 'no cut faces to find');
  physics.dispose();
});
