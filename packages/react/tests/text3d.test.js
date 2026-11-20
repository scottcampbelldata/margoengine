import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import React, { StrictMode, createRef } from 'react';

// Text3D builds its mesh with the real extrudeText of @margoengine/text/extrude from a real font on a real core engine;
// only the renderer and the network are stand-ins.
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { PbrMaterial } = await import('../dist/index.js');
const { Text3D } = await import('../dist/text.js');
const { extrudeText, parseFontOutlines } = await import('@margoengine/text/extrude');
const { render, act, cleanup } = await import('@testing-library/react');
const h = React.createElement,
  bytes = readFileSync(new URL('../../text/tests/fixtures/fonts/SourceSans3-Regular.ttf', import.meta.url)),
  engines = [],
  fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  return String(url).endsWith('missing.ttf')
    ? { ok: false, status: 404 }
    : {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      };
};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

afterEach(async () => {
  cleanup();
  await act(async () => {});
  for (const engine of engines.splice(0)) engine.dispose();
});
async function context() {
  const renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(64),
      renderer,
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    errors = [];
  engines.push(engine);
  engine.onError = (error) => errors.push(error);
  const scene = {
    engine,
    world: null,
    registry: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
    resources: { models: new Set(), lighting: new Map() },
    shadows: null,
  };
  return { engine, errors, tree: (child) => h(StrictMode, null, h(Context.Provider, { value: scene }, child)) };
}

test('Text3D extrudes its string children with the font, and rebuilds only when the text or an option changes', async () => {
  const { tree, errors } = await context(),
    ref = createRef(),
    font = parseFontOutlines(bytes),
    built = [];
  const text = (props, ...children) =>
    tree(
      h(
        Text3D,
        { ref, font, size: 0.5, height: 0.1, curveSegments: 4, onBuild: (box) => built.push(box), ...props },
        ...children,
      ),
    );
  const view = render(text({}, 'Margo ', 3, h(PbrMaterial, { color: '#ff0000' })));
  await settle();
  const mesh = ref.current,
    expected = extrudeText('Margo 3', { font, size: 0.5, depth: 0.1, curveSegments: 4 });
  assert.deepEqual(errors, []);
  assert.ok(mesh.geometry, 'the mesh has the extruded geometry');
  assert.equal(mesh.geometry.indices.length, expected.indices.length, 'the same triangles as extrudeText');
  assert.deepEqual(built.at(-1), expected.boundingBox, 'height is the depth of the extrusion');
  assert.deepEqual([...mesh.material.data.slice(0, 3)], [1, 0, 0], 'a material child goes inside the mesh');
  const first = mesh.geometry;
  view.rerender(text({}, 'Margo ', 3, h(PbrMaterial, { color: '#ff0000' })));
  await settle();
  assert.equal(mesh.geometry, first, 'an equal rerender keeps the geometry');
  view.rerender(text({ size: 1 }, 'Margo ', 3));
  await settle();
  assert.notEqual(mesh.geometry, first, 'a new size rebuilds it');
  assert.ok(built.at(-1).max[0] > 1.9 * expected.boundingBox.max[0]);
});

test('Text3D fetches a font URL once for every text using it, and reports a failed load', async () => {
  const { tree, errors } = await context(),
    a = createRef(),
    b = createRef(),
    failures = [];
  render(
    tree(
      h(
        React.Fragment,
        null,
        h(Text3D, { ref: a, font: '/fonts/sans.ttf' }, 'A'),
        h(Text3D, { ref: b, font: '/fonts/sans.ttf', text: 'B' }),
      ),
    ),
  );
  await settle();
  assert.deepEqual(
    fetched.filter((url) => url === '/fonts/sans.ttf'),
    ['/fonts/sans.ttf'],
  );
  assert.ok(a.current.geometry && b.current.geometry);
  assert.notEqual(a.current.geometry.indices.length, b.current.geometry.indices.length, 'each has its own text');
  render(tree(h(Text3D, { font: '/fonts/missing.ttf', onError: (error) => failures.push(error) }, 'C')));
  await settle();
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /missing\.ttf answered 404/);
  assert.equal(errors.length, 1, 'the Canvas hears of it too');
});

test('Text3D smooth averages the normals around each position, and smoothAngle keeps sharp corners', async () => {
  const { creasedNormals } = await import('@margoengine/geometry/utils');
  const { tree, errors } = await context(),
    ref = createRef(),
    font = parseFontOutlines(bytes),
    normals = (geometry) => [...geometry.vertices].filter((_, i) => i % 6 >= 3);
  const view = render(tree(h(Text3D, { ref, font, size: 0.5, height: 0.1, curveSegments: 4, smooth: 1e-4 }, 'O')));
  await settle();
  assert.deepEqual(errors, []);
  const flat = extrudeText('O', { font, size: 0.5, depth: 0.1, curveSegments: 4 }),
    round = creasedNormals(flat.positions, { indices: flat.indices, tolerance: 1e-4, angle: 180 });
  const got = normals(ref.current.geometry);
  assert.equal(got.length, round.length);
  assert.ok(
    got.every((v, i) => Math.abs(v - round[i]) < 1e-5),
    'the normals are the averaged ones',
  );
  assert.ok(
    got.some((v, i) => Math.abs(v - flat.normals[i]) > 0.1),
    'and differ from the flat ones at the cap edges',
  );
  view.rerender(
    tree(h(Text3D, { ref, font, size: 0.5, height: 0.1, curveSegments: 4, smooth: 1e-4, smoothAngle: 30 }, 'O')),
  );
  await settle();
  const sharp = normals(ref.current.geometry),
    capFacing = sharp.filter((_, i) => i % 3 === 2 && Math.abs(flat.normals[i]) > 0.999);
  assert.ok(
    capFacing.every((z) => Math.abs(z) > 0.999),
    'a 30 degree crease keeps the caps flat',
  );
});
