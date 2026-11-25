// Bodies and colliders in the world: colliders with no body of yours, a removed body that leaves its colliders, a body's own
// joints, and handles that tell a row's old tenant from its new one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

test('a free collider belongs to no body of yours and holds up what falls on it', () => {
  const physics = new Physics(null),
    floor = physics.addFreeCollider({ shape: 'box', halfExtents: [20, 0.5, 20], offset: [0, -0.5, 0] }),
    ball = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  assert.equal(floor.parent, null);
  assert.equal(floor.free, true);
  assert.equal(physics.bodyCount, 1, 'the world keeps its own anchor out of the count');
  assert.deepEqual(physics.getBodies(), [ball]);
  assert.ok(physics.getColliders().includes(floor));
  for (let i = 0; i < 240; i++) physics.step();
  near(ball.position[1], 0.5, 0.01, 'the ball rests on the free floor');
  physics.dispose();
});

test('a removed body can leave its colliders in the world at the poses they had', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    plank = physics.addBody(null, {
      type: 'fixed',
      position: [2, 1, 0],
      rotation: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], offset: [1, 0, 0] },
    }),
    collider = plank.colliders[0],
    before = collider.translation();
  physics.removeBody(plank, { keepColliders: true });
  assert.equal(plank.valid, false);
  assert.equal(collider.valid, true, 'the collider outlives its body');
  assert.equal(collider.free, true);
  const after = collider.translation();
  near(after.x, before.x, 1e-5, 'x');
  near(after.y, before.y, 1e-5, 'y');
  near(after.z, before.z, 1e-5, 'z');
  // A quarter turn about y takes the offset (1, 0, 0) to (0, 0, -1): the box is at (2, 1, -1).
  near(after.z, -1, 1e-5, 'turned with the body');
  // What flies at it hits it.
  const ball = physics.addBody(null, {
    position: [2, 1, -5],
    linearVelocity: [0, 0, 5],
    colliders: { shape: 'sphere', radius: 0.25, restitution: 0 },
  });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(ball.position[2] < -1.5, `stopped by the left-behind box: z = ${ball.position[2]}`);
  // The default removes the colliders with the body.
  const other = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 } }),
    mine = other.colliders[0];
  physics.removeBody(other);
  assert.equal(mine.valid, false);
  physics.dispose();
});

test('a body lists the joints that hold it', () => {
  const physics = new Physics(null),
    a = physics.addBody(null, { type: 'fixed', colliders: [] }),
    b = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    c = physics.addBody(null, { position: [2, 0, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    first = physics.addJoint(a, b, { type: 'spherical' }),
    second = physics.addJoint(b, c, { type: 'spherical' });
  assert.deepEqual(a.joints(), [first]);
  assert.deepEqual(b.joints(), [first, second]);
  assert.deepEqual(c.joints(), [second]);
  physics.removeJoint(first);
  assert.deepEqual(b.joints(), [second]);
  assert.deepEqual(a.joints(), []);
  physics.dispose();
});

test('a handle tells a row from what is in it now, for bodies, colliders and joints', () => {
  const physics = new Physics(null),
    kernel = physics.kernel,
    a = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 } }),
    b = physics.addBody(null, { position: [3, 0, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    joint = physics.addJoint(a, b, { type: 'spherical' });
  const bodyHandle = kernel.handle('body', a.row),
    colliderHandle = kernel.handle('collider', a.colliders[0].handle),
    jointHandle = kernel.handle('joint', joint.row);
  for (const handle of [bodyHandle, colliderHandle, jointHandle]) {
    assert.equal(kernel.isLive(handle), true);
    kernel.assertLive(handle);
  }
  const row = a.row;
  physics.removeBody(a);
  physics.step();
  assert.equal(kernel.isLive(bodyHandle), false, 'the body is gone');
  const next = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 } });
  assert.equal(next.row, row, 'its row was reused');
  assert.equal(kernel.isLive(bodyHandle), false, 'the old handle does not name the new body');
  assert.throws(() => kernel.assertLive(bodyHandle), { code: 'state', message: /stale/ });
  assert.equal(kernel.isLive(kernel.handle('body', next.row)), true);
  assert.equal(kernel.isLive(colliderHandle), false, 'nor the old collider the new one');
  assert.equal(kernel.isLive(jointHandle), false, 'and the joint went with the body');
  assert.throws(() => kernel.handle('body', 999), { code: 'state', message: /holds nothing/ });
  physics.dispose();
});

test('two worlds, named differently in one scene, step on their own and one can leave without the other', () => {
  const plugins = new Map(),
    engine = {
      use(plugin) {
        plugin.setup(this);
        plugins.set(plugin.name, plugin);
        return this;
      },
      hasPlugin: (name) => plugins.has(name),
      sceneOf: (plugin) =>
        plugins.get(plugin.name) === plugin ? { removePlugin: (name) => engine.removePlugin(name) } : undefined,
      removePlugin(name) {
        const plugin = plugins.get(name);
        plugins.delete(name);
        plugin?.dispose?.();
      },
      render(delta) {
        for (const plugin of plugins.values()) plugin.onPreUpdate?.(delta);
      },
    };
  const moon = new Physics(engine, { name: 'moon', gravity: [0, -1.62, 0] }),
    earth = new Physics(engine, { name: 'earth', gravity: [0, -9.81, 0] });
  assert.equal(moon.name, 'moon');
  assert.ok(engine.hasPlugin('moon') && engine.hasPlugin('earth'));
  const fall = (world) => world.addBody(null, { position: [0, 100, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    onMoon = fall(moon),
    onEarth = fall(earth);
  for (let i = 0; i < 60; i++) engine.render(1 / 60);
  const moonDrop = 100 - onMoon.position[1],
    earthDrop = 100 - onEarth.position[1];
  near(moonDrop, 0.5 * 1.62, 0.1, 'a second of lunar gravity');
  near(earthDrop, 0.5 * 9.81, 0.2, 'a second of earth gravity');
  assert.equal(moon.bodyCount, 1);
  assert.equal(earth.bodyCount, 1);
  engine.removePlugin('moon');
  assert.ok(moon.isDisposed && !earth.isDisposed, 'only the named world left');
  engine.render(1 / 60);
  assert.ok(100 - onEarth.position[1] > earthDrop, 'the other world goes on');
  earth.dispose();
});
