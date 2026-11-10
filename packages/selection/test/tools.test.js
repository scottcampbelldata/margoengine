// Marquee, lasso, face/edge/vertex picking, the pointer-driven tool and the hover highlight, on real core meshes with a stub renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { HoverHighlight, SelectionTool, pickElement, selectInPolygon, selectInRect } from '../dist/index.js';

class FakeElement {
  listeners = new Map();
  clientWidth = 800;
  clientHeight = 600;
  width = 800;
  height = 600;
  captured = new Set();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  getContext() {
    return null;
  }
  dispatch(type, props = {}) {
    const event = {
      type,
      stopped: false,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      stopImmediatePropagation() {
        this.stopped = true;
      },
      preventDefault() {},
      ...props,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
      if (event.stopped) break;
    }
    return event;
  }
}
async function scene() {
  const canvas = new FakeElement();
  const store = await TransformStore.create(32);
  const renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Runtime(canvas, store, renderer, { position: [0, 0, 10], target: [0, 0, 0] }, null);
  const left = engine.createMesh().setGeometry(box()).setPosition([-3, 0, 0]),
    middle = engine.createMesh().setGeometry(box()).setPosition([0, 0, 0]),
    right = engine.createMesh().setGeometry(box()).setPosition([3, 0, 0]);
  engine.render();
  return { engine, canvas, left, middle, right };
}
const names = (meshes, all) => meshes.map((m) => ['left', 'middle', 'right'][all.indexOf(m)]);

test('selectInRect picks by centre, overlap and containment', async () => {
  const { engine, left, middle, right } = await scene();
  const all = [left, middle, right];
  // Pixel scale at distance 10, fov 60: 600 / (2 * 10 * tan 30) = 51.96 px per unit; x = 400 + 51.96 * world x.
  assert.deepEqual(names(selectInRect(engine, { x: 500, y: 0, width: 300, height: 600 }), all), ['right']);
  assert.deepEqual(names(selectInRect(engine, { x: 0, y: 0, width: 800, height: 600 }), all), [
    'left',
    'middle',
    'right',
  ]);
  assert.deepEqual(
    selectInRect(engine, { x: 0, y: 0, width: 100, height: 100 }),
    [],
    'an empty corner selects nothing',
  );
  assert.deepEqual(
    names(selectInRect(engine, { x: 800, y: 600, width: -300, height: -600 }), all),
    ['right'],
    'negative sizes are normalised',
  );
  // A thin strip just left of the middle box touches it only by overlap.
  const strip = { x: 380, y: 250, width: 10, height: 100 };
  assert.deepEqual(selectInRect(engine, strip, { mode: 'center' }), []);
  assert.deepEqual(names(selectInRect(engine, strip, { mode: 'overlap' }), all), ['middle']);
  assert.deepEqual(selectInRect(engine, strip, { mode: 'contain' }), []);
  // A window holding the middle box completely contains it and not its neighbours.
  assert.deepEqual(names(selectInRect(engine, { x: 250, y: 100, width: 300, height: 400 }, { mode: 'contain' }), all), [
    'middle',
  ]);
  // Hidden meshes and meshes behind the camera are skipped; an explicit list narrows the test.
  middle.visible = false;
  engine.render();
  assert.deepEqual(names(selectInRect(engine, { x: 0, y: 0, width: 800, height: 600 }), all), ['left', 'right']);
  right.setPosition([3, 0, 20]);
  engine.render();
  assert.deepEqual(names(selectInRect(engine, { x: 0, y: 0, width: 800, height: 600 }), all), ['left']);
  assert.deepEqual(selectInRect(engine, { x: 0, y: 0, width: 800, height: 600 }, { meshes: [] }), []);
  engine.dispose();
});

test('selectInPolygon is a lasso: centre, overlap and containment, and needs three points', async () => {
  const { engine, left, middle, right } = await scene();
  const all = [left, middle, right];
  const triangle = [
    [200, 50],
    [800, 50],
    [800, 550],
  ];
  // The right box (centre x 556) sits inside the triangle's upper right; the middle (400, 300) is outside its slanted edge.
  assert.deepEqual(names(selectInPolygon(engine, triangle), all), ['right']);
  const wide = [
    [0, 0],
    [800, 0],
    [800, 600],
    [0, 600],
  ];
  assert.deepEqual(names(selectInPolygon(engine, wide, { mode: 'contain' }), all), ['left', 'middle', 'right']);
  const sliver = [
    [395, 280],
    [405, 280],
    [400, 320],
  ];
  assert.deepEqual(names(selectInPolygon(engine, sliver), all), ['middle'], 'centre inside');
  const beside = [
    [365, 280],
    [367, 280],
    [366, 320],
  ];
  assert.deepEqual(selectInPolygon(engine, beside), []);
  assert.deepEqual(names(selectInPolygon(engine, beside, { mode: 'overlap' }), all), ['middle']);
  assert.throws(
    () =>
      selectInPolygon(engine, [
        [0, 0],
        [1, 1],
      ]),
    RangeError,
  );
  engine.dispose();
});

test('pickElement returns the face, point, nearest vertex and nearest edge under a pixel', async () => {
  const { engine, middle, right } = await scene();
  const hit = pickElement(engine, 400, 300);
  assert.ok(hit, 'the middle box is under the centre');
  assert.equal(hit.mesh, middle);
  assert.ok(Math.abs(hit.point[2] - 0.5) < 1e-4 && Math.abs(hit.point[0]) < 1e-3, `front face point ${hit.point}`);
  assert.ok(Math.abs(hit.distance - 9.5) < 1e-3, `distance ${hit.distance}`);
  assert.equal(hit.vertices.length, 3);
  assert.ok(
    hit.vertices.includes(hit.vertex) && hit.edge.every((v) => hit.vertices.includes(v)) && hit.edge[0] !== hit.edge[1],
  );
  // Near the top left corner of the front face: the nearest vertex is that corner (x -0.5, y 0.5, z 0.5).
  const geometry = middle.geometry,
    corner = [400 - 0.45 * 51.96, 300 - 0.45 * 51.96];
  const near = pickElement(engine, corner[0], corner[1]);
  const v = near.vertex * 6;
  assert.deepEqual(
    [geometry.vertices[v], geometry.vertices[v + 1], geometry.vertices[v + 2]].map((n) => Math.round(n * 10) / 10),
    [-0.5, 0.5, 0.5],
  );
  // The right box is hit at its own pixel, and a miss is null.
  assert.equal(pickElement(engine, 400 + 3 * 51.96, 300).mesh, right);
  assert.equal(pickElement(engine, 40, 40), null);
  assert.equal(pickElement(engine, 400, 300, { meshes: [right] }), null, 'only the listed meshes are tested');
  middle.visible = false;
  engine.render();
  assert.equal(pickElement(engine, 400, 300), null, 'hidden meshes are not picked');
  engine.dispose();
});

test('SelectionTool: Shift + drag selects, Ctrl adds, Alt removes, and other presses pass through', async () => {
  const { engine, canvas, left, middle, right } = await scene();
  const calls = [];
  const tool = SelectionTool.attach(engine, {
    onSelect: (meshes, operation) => calls.push([meshes.length, operation]),
    overlay: false,
  });
  const seen = [];
  tool.addEventListener('select', (e) => seen.push(e.operation));
  const drag = (from, to, extra = {}) => {
    const down = canvas.dispatch('pointerdown', { clientX: from[0], clientY: from[1], ...extra });
    canvas.dispatch('pointermove', { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, ...extra });
    canvas.dispatch('pointermove', { clientX: to[0], clientY: to[1], ...extra });
    canvas.dispatch('pointerup', { clientX: to[0], clientY: to[1], ...extra });
    return down;
  };
  const plain = drag([500, 50], [790, 550]);
  assert.equal(plain.stopped, false, 'no Shift: the press reaches the camera controls');
  assert.deepEqual(tool.selected, []);
  const down = drag([500, 50], [790, 550], { shiftKey: true });
  assert.equal(down.stopped, true, 'the tool takes the press');
  assert.deepEqual(tool.selected, [right]);
  drag([10, 50], [450, 550], { shiftKey: true, ctrlKey: true });
  assert.deepEqual(new Set(tool.selected), new Set([right, left, middle]), 'Ctrl adds');
  drag([300, 50], [450, 550], { shiftKey: true, altKey: true });
  assert.deepEqual(new Set(tool.selected), new Set([right, left]), 'Alt removes');
  drag([500, 50], [790, 550], { shiftKey: true });
  assert.deepEqual(tool.selected, [right], 'plain Shift replaces');
  assert.deepEqual(
    calls.map((c) => c[1]),
    ['replace', 'add', 'subtract', 'replace'],
  );
  assert.deepEqual(seen, ['replace', 'add', 'subtract', 'replace']);
  // A click inside the threshold leaves the selection alone.
  canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, shiftKey: true });
  canvas.dispatch('pointermove', { clientX: 101, clientY: 101, shiftKey: true });
  canvas.dispatch('pointerup', { clientX: 101, clientY: 101, shiftKey: true });
  assert.deepEqual(tool.selected, [right]);
  tool.dispose();
  assert.equal(canvas.listenerCount, 0);
  engine.dispose();
});

test('SelectionTool lasso follows the pointer path; a custom trigger and disabled state are honoured; abort detaches', async () => {
  const { engine, canvas, middle, right } = await scene();
  const controller = new AbortController();
  const tool = new SelectionTool(engine, {
    shape: 'lasso',
    trigger: (e) => e.button === 2,
    overlay: false,
    signal: controller.signal,
  });
  const path = [
    [330, 220],
    [470, 220],
    [470, 380],
    [330, 380],
  ];
  const run = (button) => {
    canvas.dispatch('pointerdown', { clientX: path[0][0], clientY: path[0][1], button });
    for (const [x, y] of path.slice(1)) canvas.dispatch('pointermove', { clientX: x, clientY: y, button });
    canvas.dispatch('pointerup', { clientX: path[3][0], clientY: path[3][1], button });
  };
  run(0);
  assert.deepEqual(tool.selected, [], 'left button is not the trigger');
  tool.enabled = false;
  run(2);
  assert.deepEqual(tool.selected, []);
  tool.enabled = true;
  run(2);
  assert.deepEqual(tool.selected, [middle]);
  assert.ok(!tool.selected.includes(right));
  controller.abort();
  assert.equal(canvas.listenerCount, 0, 'abort removes the listeners');
  tool.dispose();
  engine.dispose();
});

test('SelectionTool draws and removes a rubber band when the canvas has a parent', async () => {
  const { engine, canvas } = await scene();
  const children = [];
  canvas.ownerDocument = {
    createElement: () => ({
      style: {},
      remove() {
        children.splice(0, children.length);
      },
    }),
  };
  canvas.parentElement = { appendChild: (node) => children.push(node), removeChild() {} };
  const tool = new SelectionTool(engine);
  canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, shiftKey: true });
  canvas.dispatch('pointermove', { clientX: 200, clientY: 250, shiftKey: true });
  assert.equal(children.length, 1);
  assert.deepEqual(
    [children[0].style.left, children[0].style.top, children[0].style.width, children[0].style.height],
    ['100px', '100px', '100px', '150px'],
  );
  canvas.dispatch('pointerup', { clientX: 200, clientY: 250, shiftKey: true });
  assert.equal(children.length, 0, 'removed on release');
  tool.dispose();
  engine.dispose();
});

test('HoverHighlight outlines the picked mesh, keeps one pick in flight and clears on leave, drag and dispose', async () => {
  const { engine, canvas, left, right } = await scene();
  const picks = [],
    resolvers = [];
  const picking = {
    pick: (x, y) =>
      new Promise((resolve) => {
        picks.push([x, y]);
        resolvers.push(resolve);
      }),
  };
  const sets = [];
  const hovers = [];
  const hover = HoverHighlight.attach(engine, {
    picking,
    outline: { set: (m) => sets.push([...m]) },
    onHover: (m) => hovers.push(m),
  });
  canvas.dispatch('pointermove', { clientX: 10, clientY: 10 });
  canvas.dispatch('pointermove', { clientX: 20, clientY: 20 });
  canvas.dispatch('pointermove', { clientX: 30, clientY: 30 });
  assert.equal(picks.length, 1, 'one pick in flight');
  resolvers[0]({ mesh: left });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(picks.at(-1), [30, 30], 'the newest position is picked next');
  assert.equal(hover.mesh, null, 'a stale result is not shown');
  resolvers[1]({ mesh: right });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hover.mesh, right);
  assert.deepEqual(sets, [[right]]);
  canvas.dispatch('pointermove', { clientX: 5, clientY: 5, buttons: 1 });
  assert.equal(hover.mesh, null, 'cleared while dragging');
  canvas.dispatch('pointermove', { clientX: 5, clientY: 5, pointerType: 'touch' });
  assert.equal(picks.length, 2, 'touch does not hover');
  canvas.dispatch('pointermove', { clientX: 6, clientY: 6 });
  resolvers[2]({ mesh: left });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hover.mesh, left);
  canvas.dispatch('pointerleave', {});
  assert.equal(hover.mesh, null);
  assert.deepEqual(hovers, [right, null, left, null]);
  hover.dispose();
  assert.equal(canvas.listenerCount, 0);
  engine.dispose();
});

test('marquee bounds hold the whole perspective image of an off-axis bounding sphere', async () => {
  const canvas = new FakeElement(),
    store = await TransformStore.create(8),
    renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Runtime(canvas, store, renderer, { position: [0, 0, 10], target: [0, 0, 0] }, null),
    mesh = engine.createMesh().setGeometry(box()).setPosition([2.4, 0, 7]);
  engine.render();
  // Sampled independently (fov 60, 800 x 600): the unit box's bounding sphere (radius sqrt(3) / 2) images to x 649.3 to
  // 1057.6, while a radius offset beside the centre reaches only 665.7. A strip at x 652 to 662 meets the image.
  assert.deepEqual(selectInRect(engine, { x: 652, y: 250, width: 10, height: 100 }, { mode: 'overlap' }), [mesh]);
  // Nearer the axis, at (1.2, 0.8, 7): image x 456.9 to 796.5 and y -13.8 to 311.5, so this window does not hold it,
  // though the circle of a radius offset (x 457.8 to 757.8, y 11.4 to 311.4) would fit inside.
  mesh.setPosition([1.2, 0.8, 7]);
  engine.render();
  const window = { x: 450, y: 5, width: 330, height: 315 };
  assert.deepEqual(selectInRect(engine, window, { mode: 'contain' }), []);
  assert.deepEqual(selectInRect(engine, { x: 450, y: -20, width: 350, height: 340 }, { mode: 'contain' }), [mesh]);
  engine.dispose();
});
