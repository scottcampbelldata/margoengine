import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode, createRef } from 'react';

// PivotControls and TransformControls drive the real @margoengine/controls/transform gizmo on a real core engine; only
// the renderer and the canvas are stand-ins.
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The annotation label goes through <Html>, whose optional peer is a stand-in here that keeps what it is given.
const labels = new Set();
mock.module('@margoengine/html', {
  namedExports: {
    HTML: class {
      static attach() {
        return new this();
      }
      add(element, options) {
        const label = {
          element,
          ...options,
          setMesh: () => label,
          setOffset: (value) => ((label.offset = value), label),
        };
        labels.add(label);
        return label;
      }
      remove(label) {
        labels.delete(label);
      }
      dispose() {}
    },
  },
});
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Box } = await import('../dist/geometry.js');
const { PivotControls, TransformControls } = await import('../dist/controls.js');
const { render, act, cleanup } = await import('@testing-library/react');
const { FakeElement, pointer } = await import('../../controls/tests/control-fakes.js');
const h = React.createElement,
  flush = () => act(async () => {}),
  engines = [];

class Canvas extends FakeElement {
  ownerDocument = dom.window.document;
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
afterEach(async () => {
  cleanup();
  await flush();
  for (const engine of engines.splice(0)) engine.dispose();
});
async function context() {
  const canvas = new Canvas(),
    renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine(
      canvas,
      await TransformStore.create(64),
      renderer,
      { position: [6, 4, 6], target: [0, 0, 0] },
      null,
    );
  engines.push(engine);
  engine.onError = (error) => {
    throw error;
  };
  const scene = {
    engine,
    world: null,
    registry: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
    resources: { models: new Set(), lighting: new Map() },
    shadows: null,
  };
  return { canvas, engine, scene, tree: (child) => h(StrictMode, null, h(Context.Provider, { value: scene }, child)) };
}
function pixel(cam, p) {
  const m = cam.matrix,
    x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [((x / w + 1) / 2) * 800, ((1 - y / w) / 2) * 600];
}
async function drag(canvas, engine, from, to) {
  await act(async () => {
    pointer(canvas, 'pointerdown', ...pixel(engine.camera, from));
    pointer(canvas, 'pointermove', ...pixel(engine.camera, to));
    pointer(canvas, 'pointerup', ...pixel(engine.camera, to));
  });
}
const round = (v) => Math.round(v * 1e4) / 1e4;
const near = (actual, expected, label, tolerance = 1e-4) =>
  assert.ok(
    expected.every((v, i) => Math.abs(actual[i] - v) < tolerance),
    `${label}: ${[...actual].map((v) => v.toFixed(5))} is not ${expected}`,
  );

test('PivotControls moves, turns and scales its children as one group from one gizmo', async () => {
  const { canvas, engine, tree } = await context(),
    ref = createRef(),
    box = createRef(),
    seen = [];
  render(
    tree(
      h(
        PivotControls,
        {
          ref,
          onDragStart: (event) => seen.push(['start', event.component, event.axis]),
          onDrag: (local, deltaLocal) => seen.push(['drag', round(local[12]), round(deltaLocal[12])]),
          onDragEnd: () => seen.push(['end']),
        },
        h(Box, { ref: box }),
      ),
    ),
  );
  await flush();
  const gizmo = ref.current,
    group = gizmo.object;
  assert.equal(gizmo.mode, 'all');
  assert.equal(gizmo.space, 'local');
  assert.equal(engine.store.parents[box.current.id], group.id, 'the children hang under the moved group');
  engine.render();
  const s = gizmo.frame().size;
  await drag(canvas, engine, [0.6 * s, 0, 0], [0.6 * s + 1, 0, 0]);
  near([group.position.x, group.position.y, group.position.z], [1, 0, 0], 'moved along X');
  assert.deepEqual(seen, [['start', 'Arrow', 0], ['drag', 1, 1], ['end']]);
  engine.render();
  const at = (deg) => [1 + Math.cos((deg * Math.PI) / 180) * s, 0, Math.sin((deg * Math.PI) / 180) * s];
  seen.length = 0;
  await drag(canvas, engine, at(45), at(15));
  assert.deepEqual(seen.slice(0, 1), [['start', 'Rotator', 1]]);
  near([Math.abs(group.rotation.y)], [Math.PI / 6], 'turned about Y');
  engine.render();
  const cube = gizmo.handles().find((handle) => handle.name === 'SY').pick,
    mid = cube.a.map((v, i) => (v + cube.b[i]) / 2);
  seen.length = 0;
  await drag(canvas, engine, mid, [mid[0], mid[1] * 2, mid[2]]);
  assert.deepEqual(seen[0], ['start', 'Scale', 1]);
  near([group.scale.y], [2], 'scaled along Y', 1e-3);
});

test('PivotControls: disable flags leave handles out, limits hold the group, autoTransform false only reports', async () => {
  const { canvas, engine, tree } = await context(),
    ref = createRef(),
    reported = [];
  const pivot = (props) =>
    tree(
      h(
        PivotControls,
        {
          ref,
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1],
          disableRotations: true,
          disableScaling: true,
          activeAxes: [true, true, false],
          translationLimits: [[-0.25, 0.25], undefined, undefined],
          onDrag: (local, deltaLocal, world) => reported.push([local[12], world[12], deltaLocal[13]]),
          ...props,
        },
        h(Box),
      ),
    );
  const view = render(pivot());
  await flush();
  const gizmo = ref.current,
    group = gizmo.object;
  near([group.position.x, group.position.y, group.position.z], [0, 0.5, 0], 'matrix places the group');
  assert.deepEqual(
    gizmo
      .handles()
      .map((handle) => handle.name)
      .sort(),
    ['X', 'XY', 'Y'],
  );
  engine.render();
  const s = gizmo.frame().size,
    o = [0, 0.6, 0];
  await drag(canvas, engine, [0.6 * s, 0.5, 0], [0.6 * s + 1, 0.5, 0]);
  near([group.position.x], [0.25], 'held at the limit');
  near(reported.at(-1), [0.25, 0.25, 0], 'reports the held transform');
  view.rerender(
    pivot({
      autoTransform: false,
      translationLimits: undefined,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...o, 1],
    }),
  );
  await flush();
  near([group.position.x], [0], 'the new matrix applies');
  engine.render();
  await drag(canvas, engine, [0.6 * s, 0.6, 0], [0.6 * s + 2, 0.6, 0]);
  near([group.position.x, group.position.y], [0, 0.6], 'the group stays at matrix');
  near(reported.at(-1), [2, 2, 0], 'onDrag says where it would go');
});

test('TransformControls: every gizmo prop follows a rerender, and a removed one goes back to its default', async () => {
  const { engine, tree } = await context(),
    ref = createRef();
  const gizmo = (props) => tree(h(TransformControls, { ref, ...props }, h(Box)));
  const occluder = () => null;
  const view = render(
    gizmo({
      mode: 'all',
      pivot: 'individual',
      flipAxes: true,
      showDelta: false,
      occlude: true,
      occluder,
      hide: ['RX'],
    }),
  );
  await flush();
  const controls = ref.current;
  assert.equal(controls.mode, 'all');
  view.rerender(
    gizmo({ mode: 'all', pivot: 'active', flipAxes: false, showDelta: true, occlude: false, hide: ['SX'] }),
  );
  await flush();
  assert.equal(controls.pivot, 'active');
  assert.equal(controls.flipAxes, false);
  assert.equal(controls.showDelta, true);
  assert.equal(controls.occlude, false);
  assert.equal(controls.occluder, undefined);
  assert.deepEqual(controls.hide, ['SX']);
  view.rerender(gizmo({}));
  await flush();
  assert.equal(controls.mode, 'translate');
  assert.equal(controls.pivot, 'median');
  assert.deepEqual(controls.hide, []);
  engine.render();
});

test('PivotControls: fixed, offset, anchor, colours and line width reach the gizmo and follow a rerender', async () => {
  const { engine, scene, tree } = await context(),
    ref = createRef();
  const pivot = (props) => tree(h(PivotControls, { ref, ...props }, h(Box)));
  const view = render(
    pivot({
      fixed: true,
      scale: 0.75,
      anchor: [1, -1, 0],
      offset: [0, 1, 0],
      axisColors: ['#ff2060', '#20df80', '#2080ff'],
      hoveredColor: '#ffff40',
      lineWidth: 4,
    }),
  );
  await flush();
  const gizmo = ref.current;
  engine.render();
  await flush();
  // A frame of <Canvas>: the anchored gizmo follows the children's box once they have geometry.
  await act(async () => {
    for (const callback of scene.frames.callbacks) callback(0, 0);
  });
  // The unit box spans -0.5..0.5: anchor [1, -1, 0] is its (0.5, -0.5, 0) corner side, and offset adds 1 in Y.
  near(gizmo.offset, [0.5, 0.5, 0], 'anchored offset');
  near(gizmo.frame().origin, [0.5, 0.5, 0], 'gizmo position');
  assert.equal(gizmo.fixed, true);
  near(gizmo.axisColors[0], [1, 0x20 / 255, 0x60 / 255, 1], 'X colour');
  near(gizmo.hoveredColor, [1, 1, 0x40 / 255, 1], 'hover colour');
  assert.equal(gizmo.handles().find((handle) => handle.name === 'X').prims[0].width, 4);
  view.rerender(pivot({}));
  await flush();
  near(gizmo.offset, [0, 0, 0], 'no anchor or offset');
  // drei's default: without `fixed` the gizmo is `scale` world units long.
  assert.equal(gizmo.fixed, false);
  assert.equal(gizmo.frame().size, 1);
  assert.equal(gizmo.axisColors, null);
  assert.equal(gizmo.hoveredColor, null);
  assert.equal(gizmo.lineWidth, 2.5);
  view.rerender(pivot({ offset: [0, 0, 2] }));
  await flush();
  near(gizmo.offset, [0, 0, 2], 'offset alone');
  view.unmount();
  const errors = [];
  assert.throws(
    () => render(pivot({ anchor: [0, Number.NaN, 0], onError: (error) => errors.push(error) })),
    /anchor must be three finite numbers/,
  );
});

test('PivotControls: annotations label a drag with its distance, angle or scale factor, then go away', async () => {
  const { canvas, engine, tree } = await context(),
    ref = createRef();
  render(tree(h(PivotControls, { ref, annotations: true, annotationsClass: 'note' }, h(Box))));
  await flush();
  const gizmo = ref.current;
  engine.render();
  const s = gizmo.frame().size;
  const text = () => [...labels].map((label) => label.element.querySelector('.note')?.textContent);
  const hold = async (from, to) => {
    await act(async () => {
      pointer(canvas, 'pointerdown', ...pixel(engine.camera, from));
      pointer(canvas, 'pointermove', ...pixel(engine.camera, to));
    });
    await flush();
    await flush();
    const shown = text();
    await act(async () => pointer(canvas, 'pointerup', ...pixel(engine.camera, to)));
    await flush();
    assert.deepEqual(text(), [], 'the label goes when the drag ends');
    engine.render();
    return shown;
  };
  assert.deepEqual(text(), [], 'no label before a drag');
  assert.deepEqual(await hold([0.6 * s, 0, 0], [0.6 * s + 1, 0, 0]), ['1.00']);
  const at = (deg) => [1 + Math.cos((deg * Math.PI) / 180) * s, 0, Math.sin((deg * Math.PI) / 180) * s];
  const [angle] = await hold(at(45), at(15));
  assert.match(angle, /^-?30\.0\u00b0$/);
  const cube = gizmo.handles().find((handle) => handle.name === 'SY').pick,
    mid = cube.a.map((v, i) => (v + cube.b[i]) / 2);
  const [factor] = await hold(mid, [mid[0], mid[1] * 2, mid[2]]);
  assert.match(factor, /^\u00d72\.00$/);
});
