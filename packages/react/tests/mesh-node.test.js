import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { engines, render, flush, close } from './physics-xr-support.js';
const { Canvas, Mesh, MeshNode, BoxGeometry, Scene, useEngine } = await (await import('./entries.js')).allEntries();
const { ScenePortal } = await import('../dist/portals.js');
const { useModelParts } = await import('../dist/gltf.js');
const { ModelContext } = await import('../dist/internal.js');
const h = React.createElement,
  tree = (children) => h(StrictMode, null, h(Canvas, { frameloop: 'demand' }, children));
const parentOf = (engine, mesh) => engine.meshes.get(engine.store.parents[mesh.id]) ?? null;
afterEach(close);

test('MeshNode mounts a caller-owned mesh under the nearest Mesh, keeps its transform and never disposes it', async () => {
  const outer = createRef(),
    handle = createRef(),
    child = createRef();
  let made;
  function App({ show, position }) {
    const engine = useEngine();
    made ??= engine.createMesh().setPosition([4, 5, 6]);
    return h(
      Mesh,
      { ref: outer },
      show && h(MeshNode, { node: made, ref: handle, position }, h(Mesh, { ref: child }, h(BoxGeometry))),
    );
  }
  const view = render(tree(h(App, { show: true })));
  await flush();
  const engine = engines.at(-1);
  assert.equal(handle.current, made, 'the ref is the mounted mesh itself');
  assert.equal(parentOf(engine, made), outer.current, 'a root mesh is placed under the nearest Mesh');
  assert.equal(parentOf(engine, child.current), made, 'children attach under the mounted mesh');
  assert.deepEqual(
    [made.position.x, made.position.y, made.position.z],
    [4, 5, 6],
    'an omitted position keeps the mesh transform',
  );
  view.rerender(tree(h(App, { show: true, position: [1, 2, 3] })));
  await flush();
  assert.deepEqual([made.position.x, made.position.y, made.position.z], [1, 2, 3]);
  view.rerender(tree(h(App, { show: false })));
  await flush();
  assert.equal(engine.meshes.get(made.id), made, 'a caller-owned mesh survives unmount');
  assert.equal(parentOf(engine, made), null, 'and is unparented again');
  made.dispose();
});

test('MeshNode leaves a parented node where it is, disposes only when told and rejects a foreign mesh', async () => {
  let root, node, owned, errors;
  function App({ show }) {
    const engine = useEngine();
    root ??= engine.createMesh();
    node ??= engine.createMesh().setParent(root);
    owned ??= engine.createMesh();
    return h(Mesh, null, show && h(MeshNode, { node }), show && h(MeshNode, { node: owned, dispose: true }));
  }
  const view = render(tree(h(App, { show: true })));
  await flush();
  const engine = engines.at(-1);
  assert.equal(parentOf(engine, node), root, 'a node that has a parent keeps it');
  view.rerender(tree(h(App, { show: false })));
  await flush();
  assert.equal(parentOf(engine, node), root);
  assert.equal(engine.meshes.has(owned.id), false, 'dispose: true disposes the mesh on unmount');
  root.dispose();
  node.dispose();
  view.unmount();
  await flush();
  // A mesh of another scene cannot be mounted here.
  errors = [];
  let other;
  function Foreign() {
    const engine = useEngine();
    other ??= engine.createScene('other').createMesh();
    return h(MeshNode, { node: other });
  }
  class Boundary extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
      return { error };
    }
    componentDidCatch(error) {
      errors.push(error);
    }
    render() {
      return this.state.error ? null : this.props.children;
    }
  }
  const warn = console.error;
  console.error = () => {};
  render(tree(h(Boundary, null, h(Foreign))));
  await flush();
  console.error = warn;
  assert.match(String(errors[0]?.message), /another scene/);
});

test('ScenePortal builds children in a named Scene, a core scene or under an existing node, and releases them', async () => {
  const inScene = createRef(),
    inCore = createRef(),
    underNode = createRef();
  let core, node;
  function App({ show }) {
    const engine = useEngine();
    core ??= engine.createScene('made-outside');
    node ??= engine.createMesh();
    return h(
      React.Fragment,
      null,
      h(Scene, { name: 'overlay' }),
      show && h(ScenePortal, { scene: 'overlay' }, h(Mesh, { ref: inScene })),
      show && h(ScenePortal, { scene: core }, h(Mesh, { ref: inCore })),
      show && h(ScenePortal, { node }, h(Mesh, { ref: underNode })),
    );
  }
  const view = render(tree(h(App, { show: true })));
  await flush();
  const engine = engines.at(-1);
  assert.equal(inScene.current.scene.name, 'overlay');
  assert.equal(inCore.current.scene, core);
  assert.equal(underNode.current.scene, engine.scene);
  assert.equal(parentOf(engine, underNode.current), node, 'children attach under the node');
  const made = [inScene.current, inCore.current, underNode.current];
  view.rerender(tree(h(App, { show: false })));
  await flush();
  for (const mesh of made) assert.equal(engine.meshes.has(mesh.id), false, 'portal children are disposed on unmount');
  assert.equal(engine.meshes.get(node.id), node, 'the target node is not');
  node.dispose();
  core.dispose();
});

test('useModelParts returns the named nodes and materials of the enclosing model, first name wins', async () => {
  const mesh = (name) => ({ name }),
    paint = { name: 'Paint' },
    glass = { name: 'Glass' },
    wheel = mesh('Wheel'),
    model = {
      disposed: false,
      root: mesh(''),
      nodes: [wheel, mesh('Wheel'), mesh('Body'), mesh('')],
      primitives: [
        { material: paint },
        { material: { name: 'Paint' } },
        { material: glass },
        { material: { name: '' } },
      ],
    };
  let parts, direct;
  function Probe() {
    parts = useModelParts();
    direct = useModelParts(model);
    return null;
  }
  render(h(ModelContext.Provider, { value: model }, h(Probe)));
  assert.deepEqual(Object.keys(parts.nodes), ['Wheel', 'Body']);
  assert.equal(parts.nodes.Wheel, wheel);
  assert.deepEqual(parts.materials, { Paint: paint, Glass: glass });
  assert.deepEqual(direct, parts);
  render(
    h(
      ModelContext.Provider,
      { value: null },
      h(() => ((parts = useModelParts()), null)),
    ),
  );
  assert.equal(parts, null, 'null while the model loads');
  assert.throws(() => render(h(() => useModelParts())), /inside <Model> children/);
});
