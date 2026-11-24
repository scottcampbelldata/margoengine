// debugRender takes a query filter, as Rapier's debug-render pipeline filters by query flags and a predicate: only the
// colliders the filter sees are drawn, with their contacts, and joints only between bodies that are shown.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, collisionGroups } from '../dist/index.js';

await Physics.load();

function scene() {
  const physics = new Physics(null, { gravity: [0, -10, 0] });
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5], collisionGroups: collisionGroups([0], [0, 1, 2]) },
  });
  const ball = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'sphere', radius: 0.5, collisionGroups: collisionGroups([2], [0, 1, 2]) },
  });
  const ghost = physics.addBody(null, {
    position: [3, 1, 0],
    colliders: { shape: 'sphere', radius: 0.3, sensor: true, collisionGroups: collisionGroups([0], [0, 1, 2]) },
  });
  const arm = physics.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], collisionGroups: collisionGroups([0], [0, 1, 2]) },
  });
  const joint = physics.addJoint(ball, arm, { type: 'fixed', anchorA: [0, 0.5, 0], anchorB: [0, -0.5, 0] });
  for (let i = 0; i < 30; i++) physics.step();
  return { physics, floor, ball, ghost, arm, joint };
}
const segments = (lines) => lines.vertices.length / 6;

test('the filter keeps only what a query with it would see', () => {
  const { physics, floor, ball, ghost, arm } = scene();
  const all = segments(physics.debugRender());
  assert.ok(all > 0);
  const lines = (filter, extra) => segments(physics.debugRender({ filter, ...extra }));
  const only = (filter) => lines(filter, { joints: false, contacts: false });
  const sphereOnly = only({ exclude: floor, excludeSensors: true, excludeCollider: arm.colliders[0] });
  assert.ok(sphereOnly > 0 && sphereOnly < only({}), 'excluding bodies draws fewer lines');
  assert.equal(only({ onlyFixed: true }), only({ predicate: (body) => body === floor }));
  assert.equal(only({ excludeFixed: true }), only({ predicate: (body) => body !== floor }));
  assert.equal(only({ excludeSolids: true }), only({ predicate: (_, collider) => collider.isSensor() }));
  assert.ok(only({ excludeSensors: true }) < only({}));
  assert.equal(only({ predicate: () => false }), 0);
  assert.equal(only({ excludeDynamic: true, excludeKinematic: true }), only({ onlyFixed: true }));
  void ball;
  void ghost;
});

test('groups named in the filter are tested both ways, none means no test', () => {
  const { physics } = scene();
  const only = (filter) => segments(physics.debugRender({ filter, joints: false, contacts: false }));
  assert.equal(only({}), only({ groups: undefined }));
  const group2 = collisionGroups([2], [2]);
  const seen = only({ groups: group2 });
  assert.ok(seen > 0 && seen < only({}), 'the ball alone is in group 2');
});

test('contacts and joints are drawn only between what is shown', () => {
  const { physics, floor } = scene();
  const rest = (filter) => segments(physics.debugRender({ filter, colliders: false }));
  const base = rest({});
  assert.ok(base > 0);
  assert.ok(rest({ exclude: floor }) < base, 'a contact with the hidden floor is not drawn');
  assert.equal(rest({ predicate: () => false }), 0, 'with every collider hidden there are no joints or contacts');
});
