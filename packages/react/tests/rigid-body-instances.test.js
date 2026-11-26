import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { engines, render, flush, close, near } from './physics-xr-support.js';
import { Physics as RealPhysics } from '@margoengine/physics';
const warn = console.warn;
console.warn = () => {};
await RealPhysics.load();
console.warn = warn;
const { Canvas, BoxGeometry } = await (await import('./entries.js')).allEntries();
const { Physics, RigidBodyInstances } = await import('../dist/physics.js');
const { worldPose } = await import('../dist/scene-transform.js');
const h = React.createElement;
afterEach(close);

test('RigidBodyInstances drives one instanced draw from many bodies, fits each collider and follows the list', async () => {
  let world;
  const bodies = new Map();
  const instances = (count) =>
    Array.from({ length: count }, (_, index) => ({ key: index, position: [index * 3, 5 + index, 0] }));
  function App({ count }) {
    return h(
      React.Fragment,
      null,
      h(
        RigidBodyInstances,
        {
          instances: instances(count),
          linearDamping: 0.5,
          onReady: (body, index) => bodies.set(index, body),
        },
        h(BoxGeometry),
      ),
    );
  }
  const view = render(
    h(
      StrictMode,
      null,
      h(
        Canvas,
        { frameloop: 'demand' },
        h(Physics, { interpolate: false, onReady: (value) => (world = value) }, h(App, { count: 3 })),
      ),
    ),
  );
  await flush();
  const engine = engines.at(-1);
  assert.equal(world.bodyCount, 3);
  for (const [index, body] of bodies) {
    assert.equal(body.colliders.length, 1, 'each body fits a collider to the shared geometry');
    near(body.colliders[0].halfExtents().x, 0.5);
    near(body.position[0], index * 3);
    near(body.position[1], 5 + index);
  }
  // Three instance meshes share one geometry (one instanced draw); each follows its own body.
  const drawn = [...engine.meshes.values()].filter((mesh) => mesh.geometry);
  assert.equal(drawn.length, 3);
  assert.equal(new Set(drawn.map((mesh) => mesh.geometry)).size, 1);
  engine.render({ delta: 1 / 60 });
  for (const [index, body] of bodies) {
    assert.ok(body.position[1] < 5 + index, 'bodies fall under gravity');
    const mesh = drawn.find((item) => Math.abs(worldPose(item).position[0] - index * 3) < 1e-3);
    near(worldPose(mesh).position[1], body.position[1]);
  }
  view.rerender(
    h(StrictMode, null, h(Canvas, { frameloop: 'demand' }, h(Physics, { interpolate: false }, h(App, { count: 2 })))),
  );
  await flush();
  assert.equal(world.bodyCount, 2, 'a removed entry removes its body');
  assert.equal([...engine.meshes.values()].filter((mesh) => mesh.geometry).length, 2);
});

test('RigidBodyInstances needs Physics', async () => {
  const errors = [];
  class Boundary extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error) {
      errors.push(error);
    }
    render() {
      return this.state.failed ? null : this.props.children;
    }
  }
  const log = console.error;
  console.error = () => {};
  render(
    h(Canvas, { frameloop: 'demand' }, h(Boundary, null, h(RigidBodyInstances, { instances: [{}] }, h(BoxGeometry)))),
  );
  await flush();
  console.error = log;
  assert.match(String(errors[0]?.message), /requires <Physics>/);
});
