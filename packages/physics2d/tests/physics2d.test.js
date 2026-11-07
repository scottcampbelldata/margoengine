import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier2d-compat';
import { Physics2D, interactionGroups } from '../dist/index.js';

await RAPIER.init();

const solid = { id: 0, properties: { solid: true } };
/** An 8 x 4 map of 16 pixel tiles whose bottom row (y 48..64) is solid. */
function floorMap(extra = {}) {
  const data = new Uint32Array(32);
  data.fill(1, 24);
  return {
    tileWidth: 16,
    tileHeight: 16,
    tilesets: [{ firstGid: 1, tileCount: 2, tileWidth: 16, tileHeight: 16, tiles: [solid] }],
    layers: [{ type: 'tile', name: 'ground', width: 8, height: 4, data }],
    ...extra,
  };
}
const world = (options = {}) => new Physics2D(null, { rapier: RAPIER, ...options });
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
  physics.sync(1);
};

test('a falling box lands on a tile floor at the expected pixel', () => {
  const physics = world();
  physics.addTileMap(floorMap());
  const sprite = { x: 64, y: 0, rotation: 0 };
  const box = physics.addBody(sprite, { colliders: { shape: 'box', width: 16, height: 16 } });
  run(physics, 300);
  // Floor top at y 48, box half height 8: the centre rests at 40, within Rapier's contact tolerance.
  assert.equal(Math.round(sprite.y), 40);
  assert.ok(Math.abs(sprite.y - 40) < 0.1, `rest y ${sprite.y}`);
  assert.ok(Math.abs(sprite.x - 64) < 1e-3);
  assert.ok(Math.abs(sprite.rotation) < 1e-3);
  assert.equal(box.sleeping, true);
  physics.dispose();
});

test('a box slides over merged tile seams without losing speed (regression: seams catch bodies)', () => {
  const physics = world();
  physics.addTileMap(floorMap(), { friction: 0 });
  const sprite = { x: 8, y: 40, rotation: 0 };
  const box = physics.addBody(sprite, {
    colliders: { shape: 'box', width: 16, height: 16, friction: 0 },
    linearVelocity: [60, 0],
    canSleep: false,
  });
  run(physics, 60);
  assert.ok(sprite.x > 60, `moved to ${sprite.x}`);
  assert.ok(Math.abs(box.linearVelocity[0] - 60) < 0.5, `speed ${box.linearVelocity[0]}`);
  physics.dispose();
});

test('the whole floor is a single outline collider', () => {
  const physics = world();
  const tiles = physics.addTileMap(floorMap());
  assert.equal(tiles.colliders.length, 1);
  assert.equal(tiles.type, 'fixed');
  physics.dispose();
});

test('partial tile shapes follow flips and rotations', () => {
  const tile = (flags) => {
    const physics = world();
    const map = floorMap({
      tilesets: [
        {
          firstGid: 1,
          tileCount: 1,
          tileWidth: 16,
          tileHeight: 16,
          tiles: [{ id: 0, collision: [{ kind: 'rect', x: 0, y: 8, width: 16, height: 8 }] }],
        },
      ],
      layers: [{ type: 'tile', name: 'a', width: 1, height: 1, data: Uint32Array.of((1 | flags) >>> 0) }],
    });
    physics.addTileMap(map);
    const hit = physics.raycast([8, -10], [0, 1]);
    physics.dispose();
    return hit;
  };
  assert.ok(Math.abs(tile(0).point[1] - 8) < 1e-3, 'bottom half: top edge at y 8');
  assert.ok(Math.abs(tile(0x40000000).point[1] - 0) < 1e-3, 'flipped top to bottom: top edge at y 0');
  const hit = tile(0).distance;
  assert.ok(Math.abs(hit - 18) < 1e-3);
});

test('tile layers honour offsets and the map position', () => {
  const physics = world();
  const map = floorMap();
  map.layers[0].offset = [0, -16];
  physics.addTileMap(map, { position: [100, 0] });
  const hit = physics.raycast([108, -50], [0, 1]);
  assert.ok(Math.abs(hit.point[1] - 32) < 1e-3, `floor top ${hit.point[1]}`);
  assert.ok(physics.raycast([50, -50], [0, 1]) === null, 'nothing left of the map');
  physics.dispose();
});

test('the layers option picks colliding layers by name or test', () => {
  const physics = world();
  const map = floorMap();
  map.layers.push({ type: 'tile', name: 'decor', width: 8, height: 4, data: new Uint32Array(32).fill(1) });
  const only = physics.addTileMap(map, { layers: ['ground'] });
  assert.equal(only.colliders.length, 1);
  const none = physics.addTileMap(map, { layers: () => false });
  assert.equal(none.colliders.length, 0);
  physics.dispose();
});

test('concave polygons keep their notch', () => {
  const physics = world();
  // An L: the notch is the empty top right quarter.
  physics.addBody(null, {
    type: 'fixed',
    colliders: {
      shape: 'polygon',
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
        [20, 10],
        [20, 20],
        [0, 20],
      ],
    },
  });
  assert.equal(physics.overlapPoint([15, 5]).length, 0, 'inside the notch');
  assert.equal(physics.overlapPoint([5, 5]).length, 1);
  assert.equal(physics.overlapPoint([15, 15]).length, 1);
  physics.dispose();
});

test('events: contact on landing, intersection with a sensor', () => {
  const physics = world();
  physics.addTileMap(floorMap());
  const zone = physics.addBody(null, {
    type: 'fixed',
    position: [64, 30],
    colliders: { shape: 'box', width: 40, height: 10, sensor: true },
  });
  const crate = physics.addBody({ x: 64, y: 0, rotation: 0 }, { colliders: { shape: 'box', width: 16, height: 16 } });
  const seen = [];
  physics.on('contactstart', (e) => seen.push(e.type));
  physics.on('intersectionstart', (e) => seen.push(`${e.type}:${e.bodyA === zone || e.bodyB === zone}`));
  physics.on('intersectionend', () => seen.push('intersectionend'));
  run(physics, 120);
  assert.ok(seen.includes('contactstart'));
  assert.ok(seen.includes('intersectionstart:true'));
  assert.ok(crate.position[1] > 30);
  physics.dispose();
});

test('a revolute joint keeps its anchor distance and its motor spins', () => {
  const physics = world({ gravity: [0, 0] });
  const pivot = physics.addBody(null, { type: 'fixed', position: [0, 0], colliders: [] });
  const arm = physics.addBody(null, {
    position: [20, 0],
    colliders: { shape: 'box', width: 40, height: 4 },
    canSleep: false,
  });
  physics.addJoint(pivot, arm, { type: 'revolute', anchorB: [-20, 0], motor: { targetVelocity: 2, factor: 100 } });
  run(physics, 120);
  assert.ok(Math.abs(arm.angularVelocity - 2) < 0.1, `angvel ${arm.angularVelocity}`);
  const [x, y] = arm.position;
  // The arm's far end moves on a circle around the pivot: the joint anchor stays at the pivot.
  const a = arm.rotation;
  assert.ok(Math.hypot(x - 20 * Math.cos(a), y - 20 * Math.sin(a)) < 0.2, 'anchor drifted from the pivot');
  physics.dispose();
});

test('a rope joint stops a falling body at its length; limits and removal work', () => {
  const physics = world();
  const top = physics.addBody(null, { type: 'fixed', position: [0, 0], colliders: [] });
  const weight = physics.addBody(null, {
    position: [0, 10],
    colliders: { shape: 'circle', radius: 4 },
    canSleep: false,
  });
  const rope = physics.addJoint(top, weight, { type: 'rope', length: 40 });
  run(physics, 240);
  assert.ok(weight.position[1] < 40.5, `rope stretched to ${weight.position[1]}`);
  assert.ok(weight.position[1] > 38, `rope slack at ${weight.position[1]}`);
  assert.throws(() => rope.setLimits(0, 1), TypeError);
  rope.remove();
  run(physics, 60);
  assert.ok(weight.position[1] > 60, 'free after the rope is removed');
  physics.dispose();
});

test('a prismatic joint slides along its axis within limits', () => {
  const physics = world({ gravity: [0, 0] });
  const rail = physics.addBody(null, { type: 'fixed', colliders: [] });
  const cart = physics.addBody(null, { colliders: { shape: 'box', width: 8, height: 8 }, canSleep: false });
  physics.addJoint(rail, cart, { type: 'prismatic', axis: [1, 0], limits: [0, 50] });
  cart.linearVelocity = [100, 0];
  run(physics, 120);
  assert.ok(Math.abs(cart.position[0] - 50) < 1, `stopped at ${cart.position[0]}`);
  assert.ok(Math.abs(cart.position[1]) < 0.1);
  physics.dispose();
});

test('queries: raycast, point and shape overlaps, shape cast, filters', () => {
  const physics = world();
  const wall = physics.addBody(null, {
    type: 'fixed',
    position: [100, 0],
    colliders: { shape: 'box', width: 20, height: 100 },
    userData: 'wall',
  });
  const ghost = physics.addBody(null, {
    type: 'fixed',
    position: [60, 0],
    colliders: { shape: 'box', width: 10, height: 100, sensor: true },
  });
  assert.equal(physics.raycast([0, 0], [1, 0]).body, ghost, 'sensors are hit unless excluded');
  const hit = physics.raycast([0, 0], [1, 0], { excludeSensors: true });
  assert.equal(hit.body, wall);
  assert.equal(hit.body.userData, 'wall');
  assert.ok(Math.abs(hit.distance - 90) < 1e-2, `distance ${hit.distance}`);
  assert.deepEqual(hit.normal.map(Math.round), [-1, 0]);
  assert.equal(physics.raycast([0, 0], [1, 0], { maxDistance: 50 }), null);
  assert.equal(physics.raycast([0, 0], [1, 0], { excludeSensors: true }).body, wall);
  assert.equal(physics.raycast([0, 0], [1, 0], { exclude: wall, excludeSensors: true }), null);
  assert.equal(physics.raycast([0, 0], [1, 0], { predicate: (body) => body !== ghost }).body, wall);
  assert.throws(() => physics.raycast([0, 0], [0, 0]), RangeError);
  assert.deepEqual(physics.overlapPoint([100, 10]), [wall]);
  assert.deepEqual(physics.overlapShape({ shape: 'circle', radius: 15 }, [100, 80]), []);
  assert.deepEqual(physics.overlapShape({ shape: 'circle', radius: 15 }, [100, 60]), [wall]);
  const cast = physics.castShape({ shape: 'circle', radius: 5 }, [0, 0], [1, 0], 200, { excludeSensors: true });
  assert.equal(cast.body, wall);
  assert.ok(Math.abs(cast.distance - 85) < 0.1, `cast ${cast.distance}`);
  physics.dispose();
});

test('collision groups filter queries', () => {
  const physics = world();
  // Member of group 0, collides with group 0 only.
  physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'box', width: 100, height: 10, collisionGroups: interactionGroups([0], [0]) },
  });
  assert.ok(physics.raycast([0, -50], [0, 1], { groups: interactionGroups([0], [0]) }), 'group 0 query sees it');
  assert.equal(
    physics.raycast([0, -50], [0, 1], { groups: interactionGroups([1], [1]) }),
    null,
    'group 1 query does not',
  );
  assert.equal(interactionGroups([0, 1], [2]), ((0b11 << 16) | 0b100) >>> 0);
  assert.throws(() => interactionGroups(0x10000), RangeError);
  assert.throws(() => interactionGroups([16]), RangeError);
  physics.dispose();
});

test('interpolation blends the last two steps and takes the short way round an angle', () => {
  const physics = world({ gravity: [0, 0] });
  const sprite = { x: 0, y: 0, rotation: 0 };
  physics.addBody(sprite, { colliders: { shape: 'circle', radius: 1 }, linearVelocity: [60, 0], canSleep: false });
  physics.step();
  physics.step();
  physics.sync(0.5);
  assert.ok(Math.abs(sprite.x - 1.5) < 1e-3, `x ${sprite.x}`);
  physics.sync(1);
  assert.ok(Math.abs(sprite.x - 2) < 1e-3);
  const spinner = { x: 0, y: 0, rotation: 0 };
  const b = physics.addBody(spinner, { colliders: { shape: 'circle', radius: 1 }, type: 'kinematicPosition' });
  b.teleport([0, 0], Math.PI - 0.01);
  physics.step();
  b.moveTo([0, 0], -Math.PI + 0.01);
  physics.step();
  physics.sync(0.5);
  assert.ok(Math.abs(Math.abs(spinner.rotation) - Math.PI) < 0.02, `rotation ${spinner.rotation}`);
  physics.dispose();
});

test('update runs whole fixed steps from frame time and caps a slow frame', () => {
  const physics = world();
  assert.equal(physics.update(1 / 60), 1);
  assert.equal(physics.update(0.0083), 0);
  assert.equal(physics.update(10), 4);
  assert.ok(physics.alpha >= 0 && physics.alpha < 1);
  physics.paused = true;
  assert.equal(physics.update(1), 0);
  assert.throws(() => physics.update(-1), RangeError);
  assert.throws(() => physics.update(Number.NaN), RangeError);
  physics.dispose();
});

test('a character controller walks, stops at a wall and reports ground', () => {
  const physics = world();
  physics.addTileMap(floorMap());
  physics.addBody(null, { type: 'fixed', position: [100, 40], colliders: { shape: 'box', width: 10, height: 16 } });
  const hero = physics.addBody(
    { x: 20, y: 38, rotation: 0 },
    { type: 'kinematicPosition', colliders: { shape: 'box', width: 10, height: 20 } },
  );
  const controller = physics.createCharacterController(hero, { snapToGround: 2, offset: 0.2 });
  let last;
  physics.on('beforestep', (dt) => {
    last = controller.move([120 * dt, 300 * dt]);
  });
  run(physics, 120);
  assert.ok(last.grounded, 'grounded');
  assert.ok(hero.position[0] > 70 && hero.position[0] < 95, `stopped at ${hero.position[0]}`);
  assert.ok(Math.abs(hero.position[1] - 38) < 1, `rests at ${hero.position[1]}`);
  assert.throws(() => physics.createCharacterController(physics.addBody(null, { colliders: [] })), TypeError);
  controller.dispose();
  physics.dispose();
});

test('a sprite rect gives a default box around the pivot', () => {
  const physics = world();
  const body = physics.addBody(
    { x: 50, y: 50, rotation: 0, rect: [0, 0, 16, 32], pivotX: 0.5, pivotY: 1, scaleX: 2 },
    { type: 'fixed' },
  );
  assert.equal(body.colliders.length, 1);
  assert.equal(physics.overlapPoint([50, 20]).length, 1, 'above the pivot, inside the 32 x 32 box');
  assert.equal(physics.overlapPoint([50, 55]).length, 0, 'below the pivot');
  physics.dispose();
});

test('600 steps with joints, contacts and a map are bit-for-bit repeatable', () => {
  const simulate = () => {
    const physics = world();
    physics.addTileMap(floorMap());
    const sprites = [];
    const bodies = [];
    for (let i = 0; i < 6; i++) {
      const sprite = { x: 20 + i * 14, y: -i * 20, rotation: 0 };
      sprites.push(sprite);
      bodies.push(
        physics.addBody(sprite, {
          colliders: i % 2 ? { shape: 'circle', radius: 6, restitution: 0.5 } : { shape: 'box', width: 12, height: 12 },
          canSleep: false,
        }),
      );
    }
    physics.addJoint(bodies[0], bodies[1], { type: 'rope', length: 30 });
    for (let i = 0; i < 600; i++) physics.step();
    physics.sync(1);
    const out = sprites.map((s) => [s.x, s.y, s.rotation]).flat();
    physics.dispose();
    return out;
  };
  const a = simulate();
  assert.deepEqual(simulate(), a);
  assert.ok(a.every(Number.isFinite));
  assert.ok(a[1] < 64, 'bodies stayed above the map bottom');
});

test('errors name the fix; removed bodies and disposed worlds are refused', () => {
  assert.throws(() => new Physics2D(null, { rapier: {} }), TypeError);
  assert.throws(() => world({ fixedTimestep: 0 }), RangeError);
  assert.throws(() => world({ pixelsPerMeter: -1 }), RangeError);
  assert.throws(() => world({ gravity: [0] }), TypeError);
  const physics = world();
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'blob' } }), /Unknown collider shape "blob"/);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'box', width: 0, height: 4 } }), RangeError);
  assert.throws(() => physics.addBody(null, { type: 'wobbly' }), TypeError);
  assert.equal(physics.bodyCount, 0, 'a failed addBody leaves no body behind');
  assert.throws(
    () =>
      physics.addBody(null, {
        colliders: {
          shape: 'polygon',
          points: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        },
      }),
    RangeError,
  );
  const body = physics.addBody(null, { colliders: { shape: 'circle', radius: 2 } });
  body.remove();
  assert.equal(body.isRemoved, true);
  assert.throws(() => body.position, /removed/);
  assert.throws(() => physics.addJoint(body, body, { type: 'rope', length: 1 }), /state|belong/);
  physics.gravity = [0, 100];
  assert.deepEqual(physics.gravity, [0, 100]);
  physics.dispose();
  physics.dispose();
  assert.equal(physics.isDisposed, true);
  assert.equal(physics.update(1), 0);
  assert.throws(() => physics.world, /disposed/);
});

test('gravity changes wake sleeping bodies (regression: they floated in the old field)', () => {
  const physics = world({ gravity: [0, 0] });
  const body = physics.addBody({ x: 0, y: 0, rotation: 0 }, { colliders: { shape: 'circle', radius: 2 } });
  run(physics, 120);
  assert.equal(body.sleeping, true);
  physics.gravity = [0, 200];
  run(physics, 30);
  assert.ok(body.position[1] > 10, `fell to ${body.position[1]}`);
  physics.dispose();
});

test('pixelsPerMeter changes the unit, not the behaviour', () => {
  const land = (ppm) => {
    const physics = world({ pixelsPerMeter: ppm });
    physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 200, height: 20 } });
    const ball = physics.addBody({ x: 0, y: 0, rotation: 0 }, { colliders: { shape: 'circle', radius: 10 } });
    run(physics, 400);
    const y = ball.position[1];
    physics.dispose();
    return y;
  };
  assert.ok(Math.abs(land(32) - 80) < 0.5, `ppm 32: ${land(32)}`);
  assert.ok(Math.abs(land(64) - 80) < 0.5, `ppm 64: ${land(64)}`);
});

test('queries see colliders added or moved since the last step (regression: the broad phase was stale)', () => {
  const physics = world({ gravity: [0, 0] });
  const wall = physics.addBody(null, {
    type: 'fixed',
    position: [50, 0],
    colliders: { shape: 'box', width: 10, height: 10 },
  });
  assert.equal(physics.raycast([0, 0], [1, 0]).body, wall, 'before any step');
  const mover = physics.addBody(null, {
    type: 'fixed',
    position: [500, 500],
    colliders: { shape: 'circle', radius: 5 },
  });
  mover.teleport([0, 100]);
  assert.deepEqual(physics.overlapPoint([0, 100]), [mover], 'after a teleport');
  mover.remove();
  assert.deepEqual(physics.overlapPoint([0, 100]), [], 'after removal');
  physics.dispose();
});

test('cells that touch only at a corner keep every edge', () => {
  const physics = world();
  const data = new Uint32Array(4);
  data[0] = data[3] = 1;
  const map = floorMap({ layers: [{ type: 'tile', name: 'x', width: 2, height: 2, data }] });
  physics.addTileMap(map);
  assert.deepEqual(physics.overlapShape({ shape: 'circle', radius: 2 }, [8, 8]), [], 'outlines have no area');
  assert.ok(Math.abs(physics.raycast([8, -10], [0, 1]).point[1]) < 1e-3, 'top edge of the top-left cell');
  assert.ok(Math.abs(physics.raycast([24, 60], [0, -1]).point[1] - 32) < 1e-3, 'bottom edge of the bottom-right cell');
  assert.ok(Math.abs(physics.raycast([40, 8], [-1, 0]).point[0] - 16) < 1e-3, 'right edge of the top-left cell');
  assert.equal(physics.raycast([40, 24], [-1, 0]).point[0], 32, 'right edge of the bottom-right cell');
  physics.dispose();
});

test('ellipses, circles and rotated rectangles in a tile become matching colliders', () => {
  const physics = world();
  const map = floorMap({
    tilesets: [
      {
        firstGid: 1,
        tileCount: 1,
        tileWidth: 16,
        tileHeight: 16,
        tiles: [
          {
            id: 0,
            collision: [
              { kind: 'ellipse', x: 0, y: 0, width: 16, height: 16 },
              { kind: 'rect', x: 8, y: 0, width: 8, height: 8, rotation: 45 },
              { kind: 'point', x: 1, y: 1 },
            ],
          },
        ],
      },
    ],
    layers: [{ type: 'tile', name: 'a', width: 1, height: 1, data: Uint32Array.of(1) }],
  });
  const body = physics.addTileMap(map);
  assert.equal(body.colliders.length, 2, 'circle and rotated polygon; the point is skipped');
  assert.equal(physics.overlapPoint([8, 8]).length, 1);
  assert.equal(physics.overlapPoint([0.5, 0.5]).length, 0, 'outside the circle');
  physics.dispose();
});
