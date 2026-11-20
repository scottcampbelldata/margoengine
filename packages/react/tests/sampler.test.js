// <Sampler> and useSurfaceSampler on a real core engine and the real geometry sampler.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { MeshSurfaceSampler } = await import('@margoengine/geometry/sample');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { Sampler, useSurfaceSampler } = await import('../dist/sampler.js');
const { Plane, SphereGeometry } = await import('../dist/geometry.js');
const h = React.createElement,
  scenes = [];
async function scene() {
  const canvas = document.createElement('canvas'),
    engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }),
    });
  const value = {
    engine,
    world: null,
    registry: null,
    shadows: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
  };
  scenes.push(value);
  return value;
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) s.engine.dispose();
  scenes.length = 0;
});
const settle = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      for (const s of scenes) for (const callback of [...s.frames.callbacks]) callback(s.engine, 1 / 60);
    });
};
const close = (a, b, label) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${label}: ${a} vs ${b}`));
test('Sampler places one instance per surface point of the referenced mesh, by the geometry sampler', async () => {
  const s = await scene(),
    source = createRef(),
    batch = createRef();
  render(
    tree(
      s,
      h(
        React.Fragment,
        null,
        h(Plane, { ref: source, args: [2, 2] }),
        h(Sampler, { ref: batch, mesh: source, count: 8, seed: 7 }, h(SphereGeometry, { args: [0.05] })),
      ),
    ),
  );
  await settle();
  const geometry = source.current.geometry,
    v = geometry.vertices,
    n = v.length / 6,
    positions = new Float32Array(n * 3),
    normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions.set(v.subarray(i * 6, i * 6 + 3), i * 3);
    normals.set(v.subarray(i * 6 + 3, i * 6 + 6), i * 3);
  }
  const expected = new MeshSurfaceSampler(
    { positions, normals, uvs: new Float32Array(n * 2), indices: Uint32Array.from(geometry.indices) },
    { seed: 7 },
  ).samplePoints(8);
  const instances = [...s.engine.meshes.values()].filter((m) => m !== source.current && m !== batch.current);
  assert.equal(instances.length, 8);
  instances.forEach((m, i) =>
    close([m.position.x, m.position.y, m.position.z], expected.positions.subarray(i * 3, i * 3 + 3), `point ${i}`),
  );
});
test('transform gets a rotation that stands an instance on the surface normal', async () => {
  const s = await scene(),
    seen = [];
  const geometry = (await import('@margoengine/geometry')).sphereGeometry(1, 16, 12);
  const { Geometry } = await import('@margoengine/core/extension');
  const core = new Geometry(geometry.positions, geometry.normals, geometry.indices);
  const batch = createRef();
  render(
    tree(
      s,
      h(
        Sampler,
        {
          ref: batch,
          mesh: core,
          count: 6,
          transform: (p) => {
            seen.push(p);
            return { position: p.position, rotation: p.rotation, scale: [1, 2, 1] };
          },
        },
        h(BoxGeometry),
      ),
    ),
  );
  await settle();
  const instances = [...s.engine.meshes.values()].filter((m) => m !== batch.current);
  assert.equal(instances.length, 6);
  for (const [i, m] of instances.entries()) {
    const p = seen.find((q) => q.index === i);
    // +Y of the instance, from its Euler rotation (XYZ, R = Rx Ry Rz): the second column of R.
    const [x, y, z] = [m.rotation.x, m.rotation.y, m.rotation.z],
      up = [
        -Math.cos(y) * Math.sin(z),
        Math.cos(x) * Math.cos(z) - Math.sin(x) * Math.sin(y) * Math.sin(z),
        Math.sin(x) * Math.cos(z) + Math.cos(x) * Math.sin(y) * Math.sin(z),
      ];
    close(up, p.normal, `instance ${i} up`);
    assert.deepEqual([m.scale.x, m.scale.y, m.scale.z], [1, 2, 1]);
  }
});
test('useSurfaceSampler waits for a ref and refuses a bad count', async () => {
  const s = await scene(),
    got = [];
  function Probe({ mesh }) {
    got.push(useSurfaceSampler(mesh, 4));
    return null;
  }
  const ref = createRef();
  render(tree(s, h(React.Fragment, null, h(Mesh, { ref }, h(BoxGeometry)), h(Probe, { mesh: ref }))));
  await settle();
  assert.equal(got.at(-1).positions.length, 12);
  for (let i = 0; i < 12; i++) assert.ok(Math.abs(got.at(-1).positions[i]) <= 0.5 + 1e-6);
  function Bad() {
    useSurfaceSampler(null, -1);
    return null;
  }
  assert.throws(() => render(tree(s, h(Bad))), /Sampler count must be a nonnegative integer/);
});
