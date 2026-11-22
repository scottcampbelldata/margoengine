// <MarchingCubes> on a real core engine and the real procedural surface extraction.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { MarchingCubes, MarchingCube, MarchingPlane } = await import('../dist/marching-cubes.js');
const { geometrySources } = await import('../dist/texture-geometry.js');
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
  for (const s of scenes) {
    assert.equal(s.engine.meshes.size, 0);
    s.engine.dispose();
  }
  scenes.length = 0;
});
const settle = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      for (const s of scenes) for (const callback of [...s.frames.callbacks]) callback(s.engine, 1 / 60);
    });
};
// Points of the surface, as [x, y, z] from the core geometry.
const points = (geometry) =>
  Array.from({ length: geometry.vertices.length / 6 }, (_, i) => [...geometry.vertices.slice(i * 6, i * 6 + 3)]);
test('one ball is a sphere of the metaball radius around its position, with outward normals', async () => {
  const s = await scene(),
    ref = createRef();
  render(
    tree(
      s,
      h(
        MarchingCubes,
        { ref, resolution: 48 },
        h(MarchingCube, { position: [0.2, 0, 0], strength: 0.5, subtract: 12 }),
      ),
    ),
  );
  await settle();
  const geometry = ref.current.geometry;
  assert.ok(geometry, 'a surface');
  // strength / d^2 - subtract = isolation: d = sqrt(0.5 / 92) in units of the field's width; the -1..1 cube is 2 wide.
  const radius = 2 * Math.sqrt(0.5 / 92),
    v = geometry.vertices;
  for (const [i, p] of points(geometry).entries()) {
    const r = Math.hypot(p[0] - 0.2, p[1], p[2]);
    // Linear interpolation on the grid's axis edges: within 2.8% of the radius at resolution 48 for this ball.
    assert.ok(Math.abs(r - radius) < 0.005, `vertex ${i} at ${r}, expected ${radius}`);
    const outward = (v[i * 6 + 3] * (p[0] - 0.2) + v[i * 6 + 4] * p[1] + v[i * 6 + 5] * p[2]) / r;
    assert.ok(outward > 0.9, `normal ${i} points out`);
  }
});
// The surface normal is the gradient of the field (Lorensen and Cline 1987, eq. 1). Central differences of the grid
// estimate it for sampled data; here the field is known, and at drei's default resolution a default ball spans about
// two cells, where the near-singular 1/d^2 field made the estimate up to 32 degrees off.
test('normals are the field gradient: radial for a ball and straight up for a floor, at the default resolution', async () => {
  const s = await scene(),
    ball = createRef(),
    floor = createRef(),
    centre = [0.013, 0.021, -0.017];
  render(tree(s, h(MarchingCubes, { ref: ball }, h(MarchingCube, { position: centre }))));
  render(tree(s, h(MarchingCubes, { ref: floor, resolution: 20 }, h(MarchingPlane, { planeType: 'y' }))));
  await settle();
  const v = ball.current.geometry.vertices;
  for (const [i, p] of points(ball.current.geometry).entries()) {
    // The angle by its sine (|n x d| / |d|), which float32 normals resolve where acos near 1 does not.
    const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]],
      n = [v[i * 6 + 3], v[i * 6 + 4], v[i * 6 + 5]],
      r = Math.hypot(...d),
      sin = Math.hypot(n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]) / r;
    assert.ok(
      n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0 && sin < 1e-5,
      `ball normal ${i} is ${Math.asin(Math.min(1, sin))} rad off radial`,
    );
  }
  const f = floor.current.geometry.vertices;
  for (let i = 0; i < f.length / 6; i++) assert.ok(f[i * 6 + 4] > 1 - 1e-6, `floor normal ${i} points up`);
});
test('a moved ball ref rebuilds the surface on the next frame; colours blend by field weight', async () => {
  const s = await scene(),
    ref = createRef(),
    ball = createRef();
  render(
    tree(
      s,
      h(
        MarchingCubes,
        { ref, resolution: 24, enableColors: true },
        h(MarchingCube, { ref: ball, position: [-0.5, 0, 0], color: '#ff0000' }),
        h(MarchingCube, { position: [0.5, 0, 0], color: [0, 0, 1] }),
      ),
    ),
  );
  await settle();
  const first = ref.current.geometry,
    colors = geometrySources.get(first).colors;
  for (const [i, p] of points(first).entries()) {
    const c = colors.slice(i * 3, i * 3 + 3);
    if (p[0] < -0.3) assert.ok(c[0] > 0.99 && c[2] < 0.01, `left vertex ${i} is red`);
    if (p[0] > 0.3) assert.ok(c[2] > 0.99 && c[0] < 0.01, `right vertex ${i} is blue`);
  }
  ball.current.position[1] = 0.5;
  await settle();
  const moved = ref.current.geometry;
  assert.notEqual(moved, first);
  assert.ok(
    points(moved).some((p) => p[0] < -0.3 && p[1] > 0.4),
    'the left ball moved up',
  );
  await settle();
  assert.equal(ref.current.geometry, moved, 'no rebuild while nothing changes');
});
test('a plane makes a floor along its face; bad props throw', async () => {
  const s = await scene(),
    ref = createRef();
  // Fine enough that linear interpolation of the 1/d^2 field between grid points lands within 0.005.
  render(tree(s, h(MarchingCubes, { ref, resolution: 64 }, h(MarchingPlane, { planeType: 'y' }))));
  await settle();
  const ys = points(ref.current.geometry).map((p) => p[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-4, 'flat');
  const expected = -1 + 2 * Math.sqrt(0.5 / 92);
  assert.ok(Math.abs(ys[0] - expected) < 0.005, `${ys[0]} is the metaball distance ${expected} above the -y face`);
  assert.throws(
    () => render(tree(s, h(MarchingCubes, { resolution: 2 }))),
    /MarchingCubes resolution must be an integer from 3 to 128/,
  );
  assert.throws(() => render(tree(s, h(MarchingCube))), /MarchingCube requires MarchingCubes/);
});
// drei's defaults: no uvs, no vertex colours, at most 10000 triangles.
test('uvs and colours only when enabled; maxPolyCount keeps the first triangles and only their vertices', async () => {
  const s = await scene(),
    plain = createRef(),
    rich = createRef(),
    capped = createRef(),
    full = createRef(),
    balls = () => [
      h(MarchingCube, { key: 'a', position: [-0.3, 0, 0], color: '#ff0000' }),
      h(MarchingCube, { key: 'b', position: [0.3, 0, 0] }),
    ];
  render(tree(s, h(MarchingCubes, { ref: plain }, ...balls())));
  render(tree(s, h(MarchingCubes, { ref: rich, enableUvs: true, enableColors: true }, ...balls())));
  render(tree(s, h(MarchingCubes, { ref: capped, maxPolyCount: 50 }, ...balls())));
  render(tree(s, h(MarchingCubes, { ref: full, maxPolyCount: 1e6 }, ...balls())));
  await settle();
  const a = geometrySources.get(plain.current.geometry);
  assert.equal(a.uvs, undefined, 'no uvs by default');
  assert.equal(a.colors, undefined, 'no colours by default, even with a coloured ball');
  const b = geometrySources.get(rich.current.geometry),
    count = b.positions.length / 3;
  assert.equal(b.uvs.length, count * 2);
  assert.equal(b.colors.length, count * 3);
  for (let i = 0; i < count; i++) {
    assert.equal(b.uvs[i * 2], Math.fround((b.positions[i * 3] + 1) / 2));
    assert.equal(b.uvs[i * 2 + 1], Math.fround((b.positions[i * 3 + 2] + 1) / 2));
  }
  // The default cap holds this surface whole; 50 keeps its first 50 triangles, same corners, compacted vertices.
  const whole = full.current.geometry,
    cut = capped.current.geometry,
    source = geometrySources.get(cut);
  assert.ok(plain.current.geometry.indices.length === whole.indices.length && whole.indices.length > 150 * 3);
  assert.equal(cut.indices.length, 150);
  assert.deepEqual([...source.indices], [...cut.indices]);
  const corner = (g, k) => [...g.vertices.slice(g.indices[k] * 6, g.indices[k] * 6 + 6)];
  for (let k = 0; k < 150; k++) assert.deepEqual(corner(cut, k), corner(whole, k));
  assert.equal(Math.max(...cut.indices) + 1, cut.vertices.length / 6, 'no unused vertex');
  assert.equal(new Set(cut.indices).size, cut.vertices.length / 6);
  for (const bad of [0, 2.5, -1, NaN])
    assert.throws(
      () => render(tree(s, h(MarchingCubes, { maxPolyCount: bad }))),
      /MarchingCubes maxPolyCount must be a whole number of at least 1/,
    );
});
