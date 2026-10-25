import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, useState } from 'react';
import { engines, render, act, flush, close, near } from './physics-xr-support.js';
import RAPIER from '@dimforge/rapier3d-compat';
const warn = console.warn;
console.warn = () => {};
await RAPIER.init();
console.warn = warn;
const { Canvas } = await import('../dist/index.js');
const {
  Physics,
  RigidBody,
  CuboidCollider,
  BallCollider,
  CapsuleCollider,
  CylinderCollider,
  ConeCollider,
  ConvexHullCollider,
  TrimeshCollider,
  HeightfieldCollider,
  useJoint,
  useBeforePhysicsStep,
  useAfterPhysicsStep,
} = await import('../dist/physics.js');
const h = React.createElement;
const tree = (children, props = {}) => h(StrictMode, null, h(Canvas, { frameloop: 'demand', ...props }, children));
const step = async (count = 1) => {
  for (let i = 0; i < count; i++) await act(async () => engines.at(-1).render({ delta: 1 / 60 }));
};
afterEach(close);

test('every collider shape mounts on its body and takes the parent scale', async () => {
  let body;
  render(
    tree(
      h(
        Physics,
        { rapier: RAPIER, gravity: [0, 0, 0] },
        h(
          RigidBody,
          { colliders: false, scale: [2, 3, 2], onReady: (value) => (body = value) },
          h(CapsuleCollider, { args: [0.5, 0.25] }),
          h(CylinderCollider, { args: [1, 0.5], position: [1, 0, 0] }),
          h(ConeCollider, { args: [1, 0.5], position: [2, 0, 0] }),
          h(ConvexHullCollider, { args: [[0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]], position: [3, 0, 0] }),
          h(TrimeshCollider, {
            args: [
              [0, 0, 0, 1, 0, 0, 0, 0, 1],
              [0, 1, 2],
            ],
            position: [4, 0, 0],
          }),
          h(HeightfieldCollider, { args: [1, 1, [0, 0, 0, 1], [1, 1, 1]], position: [5, 0, 0] }),
        ),
      ),
    ),
  );
  await flush();
  assert.equal(body.colliders.length, 6);
  const [capsule, cylinder, cone, hull, mesh, field] = body.colliders;
  near(capsule.halfHeight(), 1.5);
  near(capsule.radius(), 0.5);
  near(cylinder.halfHeight(), 3);
  near(cylinder.radius(), 1);
  near(cone.halfHeight(), 3);
  near(cone.radius(), 1);
  // Hull and trimesh vertices are scaled per axis: the unit axis points land at 2, 3 and 2.
  const hullVertices = Array.from(hull.vertices()),
    extent = (axis) => Math.max(...hullVertices.filter((_, at) => at % 3 === axis));
  near(extent(0), 2);
  near(extent(1), 3);
  near(extent(2), 2);
  assert.equal(mesh.indices().length, 3);
  assert.ok(Math.max(...mesh.vertices()) >= 2 - 1e-4);
  assert.ok(field.isValid());
  assert.deepEqual(engines.at(-1).errors, []);
});

test('RigidBody contact and intersection callbacks fire for their own body only and follow prop changes', async () => {
  const log = [];
  const scene = (label) =>
    tree(
      h(
        Physics,
        { rapier: RAPIER, interpolate: false },
        h(
          RigidBody,
          {
            type: 'fixed',
            colliders: false,
            onContactStart: (event) => log.push(`ground ${label}`),
          },
          h(CuboidCollider, { args: [5, 0.5, 5], position: [0, -0.5, 0] }),
        ),
        h(
          RigidBody,
          {
            position: [0, 0.6, 0],
            colliders: false,
            onContactStart: (event) => log.push(`ball ${label} ${event.type}`),
            onContactEnd: () => log.push('ball end'),
          },
          h(BallCollider, { args: [0.5] }),
        ),
        h(
          RigidBody,
          {
            type: 'fixed',
            colliders: false,
            position: [8, 0.6, 0],
            onContactStart: () => log.push('unrelated contact'),
            onIntersectionStart: () => log.push('unrelated sensor'),
          },
          h(CuboidCollider, { args: [0.5, 0.5, 0.5] }),
        ),
      ),
    );
  const view = render(scene('a'));
  await flush();
  await step(30);
  assert.ok(log.includes('ball a contactstart'), log.join('|'));
  assert.ok(log.includes('ground a'), 'the fixed body is told about the same contact');
  assert.ok(!log.some((entry) => entry.startsWith('unrelated')), 'bodies not in the pair hear nothing');
  const count = log.length;
  view.rerender(scene('b'));
  await flush();
  assert.equal(log.length, count, 'a new handler must not recreate the body or replay the contact');
});

test('a sensor collider reports intersection start and end to its body', async () => {
  const log = [];
  render(
    tree(
      h(
        Physics,
        { rapier: RAPIER, interpolate: false, gravity: [0, 0, 0] },
        h(
          RigidBody,
          {
            type: 'fixed',
            colliders: false,
            onIntersectionStart: () => log.push('in'),
            onIntersectionEnd: () => log.push('out'),
          },
          h(CuboidCollider, { args: [1, 1, 1], sensor: true }),
        ),
        h(
          RigidBody,
          { position: [-3, 0, 0], linearVelocity: [6, 0, 0], colliders: false },
          h(BallCollider, { args: [0.25] }),
        ),
      ),
    ),
  );
  await flush();
  await step(120);
  assert.deepEqual(log, ['in', 'out']);
});

test('useJoint links two bodies, rebuilds on option changes and removes the joint on unmount', async () => {
  let joints = [],
    world;
  function Rig({ limit }) {
    const [a, setA] = useState(null),
      [b, setB] = useState(null),
      joint = useJoint(a, b, { type: 'revolute', axis: [0, 0, 1], limits: [-limit, limit] });
    if (joint) joints.push(joint);
    return h(
      React.Fragment,
      null,
      h(RigidBody, { type: 'fixed', colliders: false, onReady: setA }, h(CuboidCollider, { args: [0.5, 0.5, 0.5] })),
      h(RigidBody, { position: [2, 0, 0], colliders: false, onReady: setB }, h(BallCollider, { args: [0.25] })),
    );
  }
  const scene = (limit) => tree(h(Physics, { rapier: RAPIER, onReady: (value) => (world = value) }, h(Rig, { limit })));
  const view = render(scene(0.5));
  await flush();
  assert.ok(joints.length > 0);
  const first = joints.at(-1);
  assert.equal(first.valid, true);
  assert.equal(first.type, 'revolute');
  view.rerender(scene(1));
  await flush();
  const second = joints.at(-1);
  assert.notEqual(second, first);
  assert.equal(first.valid, false, 'the replaced joint is removed');
  assert.equal(second.valid, true);
  view.unmount();
  await flush();
  assert.equal(second.valid, false);
  assert.equal(world.isDisposed, true);
});

test('useBeforePhysicsStep and useAfterPhysicsStep run once per fixed step and see the latest callback', async () => {
  const log = [];
  function Probe({ tag }) {
    useBeforePhysicsStep((dt) => log.push(`before ${tag} ${dt > 0}`));
    useAfterPhysicsStep(() => log.push(`after ${tag}`));
    return null;
  }
  const scene = (tag) => tree(h(Physics, { rapier: RAPIER }, h(Probe, { tag })));
  const view = render(scene('a'));
  await flush();
  await step(1);
  assert.deepEqual(log, ['before a true', 'after a']);
  log.length = 0;
  view.rerender(scene('b'));
  await flush();
  await step(1);
  assert.deepEqual(log, ['before b true', 'after b']);
  view.unmount();
  await flush();
});
