import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, Suspense } from 'react';
import { engines, render, act, flush, close, near } from './physics-xr-support.js';
import { Physics as RealPhysics } from '@margoengine/physics';
import RAPIER from '@dimforge/rapier3d-compat';
const warn = console.warn;
console.warn = () => {};
await RAPIER.init();
console.warn = warn;
const { Canvas, Mesh, BoxGeometry, useMargo } = await import('../dist/index.js');
const { Physics, RigidBody, CuboidCollider, BallCollider, usePhysics } = await import('../dist/physics.js');
const { useScene, useCommit } = await import('../dist/internal.js');
const { worldPose } = await import('../dist/scene-transform.js');
const h = React.createElement;
const tree = (children, props = {}) => h(StrictMode, null, h(Canvas, { frameloop: 'demand', ...props }, children));
const shape = () => h(Mesh, null, h(BoxGeometry));
// A loader-owned model with world bounds but no retained CPU position arrays.
// Its visual nodes deliberately have no core Geometry, as with PBR/FBX plugins.
function BoundsModel({ position = [0, 0, 0], brokenBounds = false }) {
  const { engine, registry, resources } = useScene();
  useCommit(() => {
    const root = engine.createMesh().setPosition(position),
      primitive = engine.createMesh().setParent(root);
    registry.register(root);
    const model = {
      root,
      disposed: false,
      primitives: [{ node: primitive }],
      get bounds() {
        if (brokenBounds) throw new TypeError('GPU-only primitive has no vertices');
        engine.store.tick(false);
        const m = root.matrix,
          bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
        for (let corner = 0; corner < 8; corner++) {
          const x = corner & 1 ? 1 : -1,
            y = corner & 2 ? 2 : -2,
            z = corner & 4 ? 3 : -3;
          for (let axis = 0; axis < 3; axis++) {
            const value = m[axis] * x + m[axis + 4] * y + m[axis + 8] * z + m[axis + 12];
            bounds[axis] = Math.min(bounds[axis], value);
            bounds[axis + 3] = Math.max(bounds[axis + 3], value);
          }
        }
        return bounds;
      },
    };
    resources.models.add(model);
    return () => {
      resources.models.delete(model);
      model.disposed = true;
      registry.unregister(root);
      primitive.dispose();
      root.dispose();
    };
  }, [engine, registry, resources, brokenBounds]);
  return null;
}
afterEach(close);

test('Physics dynamically binds a real Rapier world and RigidBody fits descendant geometry once in StrictMode', async () => {
  let world,
    body,
    ready = 0,
    hook;
  function Probe() {
    hook = usePhysics();
    return null;
  }
  render(
    tree(
      h(
        Physics,
        {
          rapier: RAPIER,
          interpolate: false,
          onReady: (value) => {
            world = value;
            ready++;
          },
        },
        h(Probe),
        h(
          RigidBody,
          {
            position: [0, 5, 0],
            onReady: (value) => {
              body = value;
            },
          },
          shape(),
        ),
      ),
    ),
  );
  await flush();
  assert.ok(world instanceof RealPhysics);
  assert.equal(ready, 1);
  assert.equal(hook, world);
  assert.equal(world.bodyCount, 1);
  assert.equal(body.colliders.length, 1);
  near(body.position[1], 5);
  assert.equal(body.mesh, null, 'world-space body must not bind a parented core mesh');
  const engine = engines.at(-1),
    root = [...engine.meshes.values()].find((mesh) => !mesh.geometry);
  engine.render({ delta: 1 / 60 });
  assert.ok(body.position[1] < 5);
  near(worldPose(root).position[1], body.position[1]);
  assert.equal(engine.starts, 0);
});

test('RigidBody retains translated, rotated and scaled parents while synchronizing world-space physics poses', async () => {
  let body;
  render(
    tree(
      h(
        Physics,
        { rapier: RAPIER, gravity: [0, 0, 0], interpolate: false },
        h(
          Mesh,
          { position: [10, 2, 0], rotation: [0, 0, Math.PI / 2], scale: [2, 2, 2] },
          h(
            RigidBody,
            {
              position: [1, 0, 0],
              onReady: (value) => {
                body = value;
              },
            },
            shape(),
          ),
        ),
      ),
    ),
  );
  await flush();
  near(body.position[0], 10);
  near(body.position[1], 4);
  const engine = engines.at(-1),
    root = [...engine.meshes.values()].find((mesh) => !mesh.geometry && engine.store.parents[mesh.id] !== -1);
  body.setPosition([14, 8, 2]);
  engine.render({ delta: 0 });
  const pose = worldPose(root);
  for (let axis = 0; axis < 3; axis++) near(pose.position[axis], [14, 8, 2][axis]);
  near(root.position.x, 3);
  near(root.position.y, -2);
  near(root.position.z, 1);
  const half = body.colliders[0].halfExtents();
  near(half.x, 1);
  near(half.y, 1);
  near(half.z, 1);
});

test('removing a RigidBody releases only its body; unmount disposes the optional world and plugin', async () => {
  let world, body;
  const scene = (show) =>
    tree(
      h(
        Physics,
        {
          rapier: RAPIER,
          onReady: (value) => {
            world = value;
          },
        },
        show
          ? h(
              RigidBody,
              {
                onReady: (value) => {
                  body = value;
                },
              },
              shape(),
            )
          : null,
      ),
    );
  const view = render(scene(true));
  await flush();
  assert.equal(world.bodyCount, 1);
  view.rerender(scene(false));
  await flush();
  assert.equal(body.valid, false);
  assert.equal(world.bodyCount, 0);
  assert.equal(world.isDisposed, false);
  view.unmount();
  await flush();
  assert.equal(world.isDisposed, true);
  assert.equal(engines.at(-1).hasPlugin('physics'), false);
});

test('Physics initializes the default optional Rapier peer and advances through demand invalidate', async () => {
  let context, world;
  function Probe() {
    context = useMargo();
    return null;
  }
  render(
    tree(
      h(
        Physics,
        {
          onReady: (value) => {
            world = value;
          },
        },
        h(Probe),
        h(RigidBody, null, shape()),
      ),
    ),
  );
  for (let i = 0; i < 20 && !world; i++) await flush();
  assert.ok(world instanceof RealPhysics);
  const before = world.stepCount;
  await act(async () => {
    context.invalidate();
    engines.at(-1).render({ delta: 1 / 60 });
  });
  assert.ok(world.stepCount > before);
});

test('Physics updates mutable world properties without recreating bodies', async () => {
  let world,
    body,
    ready = 0;
  const scene = (paused, gravity) =>
    tree(
      h(
        Physics,
        {
          rapier: RAPIER,
          paused,
          gravity,
          onReady: (value) => {
            world = value;
            ready++;
          },
        },
        h(
          RigidBody,
          {
            onReady: (value) => {
              body = value;
            },
          },
          shape(),
        ),
      ),
    );
  const view = render(scene(false, [0, -2, 0]));
  await flush();
  const original = body;
  view.rerender(scene(true, [0, -4, 0]));
  await flush();
  assert.equal(body, original);
  assert.equal(ready, 1);
  assert.equal(world.paused, true);
  assert.deepEqual(world.gravity, [0, -4, 0]);
});

test('pending Physics initialization cannot attach a world after its provider unmounts', async () => {
  let resolve,
    ready = 0;
  const pending = new Promise((value) => {
    resolve = value;
  });
  const view = render(tree(h(Physics, { rapier: pending, onReady: () => ready++ }, h(RigidBody, null, shape()))));
  await flush();
  const engine = engines.at(-1);
  view.unmount();
  await flush();
  await act(async () => resolve(RAPIER));
  assert.equal(ready, 0);
  assert.equal(engine.hasPlugin('physics'), false);
});

test('RigidBody transform prop changes reset the body at the requested world pose without stale synchronization', async () => {
  let world, body;
  const scene = (position) =>
    tree(
      h(
        Physics,
        {
          rapier: RAPIER,
          gravity: [0, 0, 0],
          onReady: (value) => {
            world = value;
          },
        },
        h(
          RigidBody,
          {
            position,
            onReady: (value) => {
              body = value;
            },
          },
          shape(),
        ),
      ),
    );
  const view = render(scene([1, 2, 3]));
  await flush();
  const old = body;
  view.rerender(scene([4, 5, 6]));
  await flush();
  assert.equal(old.valid, false);
  assert.equal(world.bodyCount, 1);
  assert.deepEqual(body.position, [4, 5, 6]);
  engines.at(-1).render({ delta: 0 });
  assert.deepEqual(body.position, [4, 5, 6]);
});

test('Physics reports initialization errors through onError and Canvas without leaking a world', async () => {
  const failures = [];
  render(tree(h(Physics, { rapier: {}, onError: (error) => failures.push(error) })));
  await flush();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /initialized Rapier/);
  assert.equal(engines.at(-1).hasPlugin('physics'), false);
});

test('automatic cuboid uses loader bounds for GPU-only model geometry under transformed parents', async () => {
  let body;
  render(
    tree(
      h(
        Physics,
        { rapier: RAPIER, gravity: [0, 0, 0] },
        h(
          Mesh,
          { position: [10, 2, 0], rotation: [0, 0, Math.PI / 2], scale: [2, 2, 2] },
          h(
            RigidBody,
            { position: [1, 0, 0], colliders: 'cuboid', onReady: (value) => (body = value) },
            h(BoundsModel, { position: [1, 0, 0] }),
          ),
        ),
      ),
    ),
  );
  await flush();
  assert.equal(body.colliders.length, 1);
  assert.deepEqual(engines.at(-1).errors, []);
  const half = body.colliders[0].halfExtents(),
    offset = body.colliders[0].translationWrtParent();
  near(half.x, 2);
  near(half.y, 4);
  near(half.z, 6);
  near(offset.x, 2);
  near(offset.y, 0);
  near(offset.z, 0);
});

test('hull falls back to bounds corners and unusable bounds report a handled diagnostic', async () => {
  let hull, broken;
  const failures = [];
  render(
    tree(
      h(
        Physics,
        { rapier: RAPIER },
        h(RigidBody, { colliders: 'hull', onReady: (value) => (hull = value) }, h(BoundsModel)),
        h(RigidBody, { onReady: (value) => (broken = value) }, h(BoundsModel, { brokenBounds: true })),
      ),
      { onError: (error) => failures.push(error) },
    ),
  );
  await flush();
  assert.equal(hull.colliders.length, 1);
  assert.equal(hull.colliders[0].shapeType(), RAPIER.ShapeType.ConvexPolyhedron);
  near(hull.mass, 48);
  for (let frame = 0; frame < 3; frame++) engines.at(-1).render({ delta: 0 });
  assert.equal(broken.colliders.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /mesh bounds or retained CPU geometry/);
  assert.equal(failures[0] instanceof TypeError, false);
});

test('exact trimesh from retained CPU geometry uses indexed triangles without replacing the native collider API', async () => {
  let exact, native;
  render(
    tree(
      h(
        Physics,
        { rapier: RAPIER },
        h(RigidBody, { type: 'fixed', colliders: 'trimesh', onReady: (value) => (exact = value) }, shape()),
        h(
          RigidBody,
          { colliders: [{ shape: 'sphere', radius: 0.75 }], onReady: (value) => (native = value) },
          h(BoundsModel),
        ),
      ),
    ),
  );
  await flush();
  assert.equal(exact.colliders.length, 1);
  assert.equal(exact.colliders[0].shapeType(), RAPIER.ShapeType.TriMesh);
  assert.equal(exact.colliders[0].vertices().length, 72);
  assert.equal(exact.colliders[0].indices().length, 36);
  assert.equal(native.colliders.length, 1);
  near(native.colliders[0].radius(), 0.75);
  assert.deepEqual(engines.at(-1).errors, []);
});

test('missing CPU geometry reports the actionable automatic trimesh diagnostic once through onError and Canvas', async () => {
  let body;
  const failures = [],
    canvasFailures = [];
  render(
    tree(
      h(
        Physics,
        { rapier: RAPIER },
        h(
          RigidBody,
          { colliders: 'trimesh', onReady: (value) => (body = value), onError: (error) => failures.push(error) },
          h(BoundsModel),
        ),
      ),
      { onError: (error) => canvasFailures.push(error) },
    ),
  );
  await flush();
  const engine = engines.at(-1);
  for (let frame = 0; frame < 4; frame++) engine.render({ delta: 0 });
  assert.equal(body.valid, true);
  assert.equal(body.colliders.length, 0);
  assert.equal(failures.length, 1);
  assert.deepEqual(canvasFailures, failures);
  assert.equal(
    failures[0].message,
    'RigidBody: automatic trimesh collider generation requires retained CPU geometry. Provide an explicit <CuboidCollider> or configure loader geometry retention.',
  );
});

test('explicit cuboid and ball children bypass automatic fitting and release only their own native colliders', async () => {
  let body;
  const failures = [],
    scene = (show) =>
      tree(
        h(
          Physics,
          { rapier: RAPIER, gravity: [0, 0, 0] },
          h(
            RigidBody,
            { colliders: 'trimesh', scale: [2, 2, 2], onReady: (value) => (body = value) },
            show
              ? h(CuboidCollider, { args: [0.5, 0.75, 0.25], position: [1, 0, 0], friction: 0.2 })
              : h(BallCollider, { args: [0.4] }),
            h(BoundsModel),
          ),
        ),
        { onError: (error) => failures.push(error) },
      );
  const view = render(scene(true));
  await flush();
  assert.equal(body.colliders.length, 1);
  const cuboid = body.colliders[0],
    half = cuboid.halfExtents();
  near(half.x, 1);
  near(half.y, 1.5);
  near(half.z, 0.5);
  near(cuboid.translationWrtParent().x, 2);
  near(cuboid.friction(), 0.2);
  view.rerender(scene(false));
  await flush();
  assert.equal(cuboid.isValid(), false);
  assert.equal(body.colliders.length, 1);
  near(body.colliders[0].radius(), 0.8);
  assert.deepEqual(failures, []);
  assert.equal(view.queryByRole('alert'), null);
  const sphere = body.colliders[0];
  view.rerender(tree(h(Physics, { rapier: RAPIER })));
  await flush();
  assert.equal(body.valid, false);
  assert.equal(sphere.isValid(), false);
});

test('explicit collider is available before the visual model loads and colliders=false never creates an automatic duplicate', async () => {
  let body;
  const scene = (loaded) =>
    tree(
      h(
        Physics,
        { rapier: RAPIER },
        h(
          RigidBody,
          { colliders: false, onReady: (value) => (body = value) },
          h(CuboidCollider, { args: [0.5, 0.75, 0.25] }),
          loaded ? h(BoundsModel) : null,
        ),
      ),
    );
  const view = render(scene(false));
  await flush();
  const original = body.colliders[0];
  assert.equal(body.colliders.length, 1);
  view.rerender(scene(true));
  await flush();
  engines.at(-1).render({ delta: 0 });
  assert.equal(body.colliders.length, 1);
  assert.equal(body.colliders[0], original);
  assert.deepEqual(engines.at(-1).errors, []);
});

test('explicit collider transform prop updates replace only their collider after the complete layout commit', async () => {
  let body;
  const failures = [],
    scene = (updated) =>
      tree(
        h(
          Physics,
          { rapier: RAPIER, gravity: [0, 0, 0] },
          h(
            RigidBody,
            { colliders: false, scale: [2, 2, 2], onReady: (value) => (body = value) },
            h(CuboidCollider, {
              args: [0.5, 0.75, 0.25],
              position: updated ? [0, 1, 0] : [1, 0, 0],
              rotation: updated ? [0, 0, Math.PI / 2] : [0, 0, 0],
              scale: updated ? [1, 3, 2] : [1, 1, 1],
            }),
            h(BallCollider, {
              args: [0.4],
              position: updated ? [0, 0, 1] : [0, 0, 0],
              scale: updated ? [1, 2, 1] : [1, 1, 1],
            }),
          ),
        ),
        { onError: (error) => failures.push(error) },
      );
  const view = render(scene(false));
  await flush();
  const original = body,
    [oldBox, oldBall] = body.colliders;
  assert.equal(body.colliders.length, 2);
  view.rerender(scene(true));
  await flush();
  assert.equal(body, original);
  assert.equal(body.colliders.length, 2);
  assert.equal(oldBox.isValid(), false);
  assert.equal(oldBall.isValid(), false);
  const box = body.colliders.find((collider) => collider.shapeType() === RAPIER.ShapeType.Cuboid),
    ball = body.colliders.find((collider) => collider.shapeType() === RAPIER.ShapeType.Ball),
    half = box.halfExtents(),
    position = box.translationWrtParent(),
    rotation = box.rotationWrtParent();
  near(half.x, 1);
  near(half.y, 4.5);
  near(half.z, 1);
  near(position.x, 0);
  near(position.y, 2);
  near(position.z, 0);
  near(rotation.z, Math.SQRT1_2);
  near(rotation.w, Math.SQRT1_2);
  near(ball.radius(), 1.6);
  near(ball.translationWrtParent().z, 2);
  assert.deepEqual(failures, []);
});

test('late loader bounds fit after a StrictMode Suspense hide and reveal replaces the visual root', async () => {
  let body,
    loaded = false,
    resolve;
  const pending = new Promise(
    (done) =>
      (resolve = () => {
        loaded = true;
        done();
      }),
  );
  function DelayedModel({ pause }) {
    if (pause && !loaded) throw pending;
    return loaded ? h(BoundsModel) : null;
  }
  const scene = (pause) =>
    tree(
      h(
        Physics,
        { rapier: RAPIER, gravity: [0, 0, 0] },
        h(
          Suspense,
          { fallback: h('span', null, 'model pending') },
          h(RigidBody, { colliders: 'cuboid', onReady: (value) => (body = value) }, h(DelayedModel, { pause })),
        ),
      ),
    );
  const view = render(scene(false));
  await flush();
  view.rerender(scene(true));
  await flush();
  assert.ok(body);
  assert.equal(body.colliders.length, 0);
  assert.ok(view.queryByText('model pending'));
  const original = body;
  await act(async () => {
    resolve();
    await pending;
  });
  await flush();
  engines.at(-1).render({ delta: 0 });
  assert.equal(body, original);
  assert.equal(body.colliders.length, 1);
  assert.equal(view.queryByText('model pending'), null);
  near(body.colliders[0].halfExtents().y, 2);
  assert.deepEqual(engines.at(-1).errors, []);
});
