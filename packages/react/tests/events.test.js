// Pointer events of the React Canvas (src/events.ts): picking stand-in, a real DOM (JSDOM) canvas and real DOM events.
// The order and bubbling rules checked here are the DOM's (UI Events, Pointer Events): an event goes to the hit mesh,
// then each parent, until a handler stops it; over/out bubble, enter/leave do not; a click targets the nearest mesh both
// the press and the release hit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<canvas></canvas>');
const { attachPointerEvents, liveHandlers, hasPointerHandlers } = await import('../dist/events.js');

/** A stand-in engine: meshes with a parent table, and a pick that answers `under(x)` after a microtask. */
function scene() {
  const meshes = new Map(),
    parents = new Int32Array(64).fill(-1),
    errors = [];
  let under = () => null;
  const engine = {
    disposed: false,
    meshes,
    store: { parents },
    onError: (error) => errors.push(error),
    pick: async (x) => under(x),
  };
  const mesh = (parent) => {
    const node = { id: meshes.size, engine };
    meshes.set(node.id, node);
    if (parent) parents[node.id] = parent.id;
    return node;
  };
  const element = window.document.createElement('canvas');
  element.getBoundingClientRect = () => ({ left: 0, top: 0 });
  element.setPointerCapture = (id) => (element.captured = id);
  element.hasPointerCapture = (id) => element.captured === id;
  element.releasePointerCapture = () => (element.captured = undefined);
  const handlers = new Map(),
    missed = [];
  const detach = attachPointerEvents(
    engine,
    element,
    handlers,
    { models: new Set() },
    { callbacks: new Set() },
    () => true,
    () => (event) => missed.push(event.type),
  );
  const on = (node, props) => handlers.set(node.id, liveHandlers({ current: props }));
  const send = (type, x, init = {}) => {
    const Event = type === 'wheel' ? window.WheelEvent : window.MouseEvent;
    const event = new Event(type, { clientX: x, clientY: 5, button: 0, ...init });
    Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
    Object.defineProperty(event, 'isPrimary', { value: true });
    element.dispatchEvent(event);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { engine, mesh, on, handlers, send, settle, detach, missed, errors, element, setUnder: (f) => (under = f) };
}

test('an event bubbles from the hit mesh through its parents until a handler stops it', async () => {
  const s = scene(),
    root = s.mesh(),
    group = s.mesh(root),
    leaf = s.mesh(group),
    log = [];
  const record = (name) => (event) => log.push([name, event.type, event.target.id, event.currentTarget.id]);
  s.on(root, { onClick: record('root'), onPointerDown: record('root') });
  s.on(group, { onClick: record('group') });
  s.on(leaf, { onClick: record('leaf'), onPointerDown: (event) => (record('leaf')(event), event.stopPropagation()) });
  s.setUnder(() => leaf);
  s.send('pointerdown', 10);
  s.send('pointerup', 10);
  await s.settle();
  assert.deepEqual(log, [
    ['leaf', 'pointerdown', leaf.id, leaf.id],
    ['leaf', 'click', leaf.id, leaf.id],
    ['group', 'click', leaf.id, group.id],
    ['root', 'click', leaf.id, root.id],
  ]);
  assert.deepEqual(s.missed, [], 'a click on a mesh is not missed');
  s.detach();
});

test('over and out bubble, enter and leave fire once per mesh entered or left, in the DOM order', async () => {
  const s = scene(),
    root = s.mesh(),
    a = s.mesh(root),
    b = s.mesh(root),
    log = [];
  for (const [name, node] of [
    ['root', root],
    ['a', a],
    ['b', b],
  ])
    s.on(node, {
      onPointerOver: (e) => log.push(`${name} over`),
      onPointerOut: (e) => log.push(`${name} out`),
      onPointerEnter: (e) => log.push(`${name} enter`),
      onPointerLeave: (e) => log.push(`${name} leave`),
      onPointerMove: (e) => log.push(`${name} move`),
    });
  s.setUnder((x) => (x < 50 ? a : x < 100 ? b : null));
  s.send('pointermove', 10);
  await s.settle();
  assert.deepEqual(log, ['a over', 'root over', 'root enter', 'a enter', 'a move', 'root move']);
  log.length = 0;
  s.send('pointermove', 60);
  await s.settle();
  // Moving between siblings leaves and enters only them: the shared parent sees out and over, never leave or enter.
  assert.deepEqual(log, ['a out', 'root out', 'a leave', 'b over', 'root over', 'b enter', 'b move', 'root move']);
  log.length = 0;
  s.send('pointermove', 200);
  await s.settle();
  assert.deepEqual(log, ['b out', 'root out', 'b leave', 'root leave']);
  s.detach();
});

test('a click goes to the nearest mesh both the press and the release hit, and a click on nothing is missed', async () => {
  const s = scene(),
    root = s.mesh(),
    a = s.mesh(root),
    b = s.mesh(root),
    other = s.mesh(),
    log = [];
  s.on(root, { onClick: (e) => log.push(`root click on ${e.target.id}`) });
  s.on(a, { onClick: () => log.push('a click') });
  s.on(other, { onPointerMissed: (event) => log.push(`other missed ${event.type}`) });
  s.setUnder(() => a);
  s.send('pointerdown', 10);
  s.setUnder(() => b);
  s.send('pointerup', 12);
  await s.settle();
  // Pressed on a, released on b (2 px apart): the click is the shared parent's, with the release hit as the target.
  assert.deepEqual(log, [`root click on ${b.id}`, 'other missed pointerup']);
  log.length = 0;
  s.setUnder(() => null);
  s.send('pointerdown', 300);
  s.send('pointerup', 300);
  await s.settle();
  assert.deepEqual(log, ['other missed pointerup']);
  assert.deepEqual(s.missed, ['pointerup'], 'the Canvas onPointerMissed hears a click on nothing');
  s.detach();
});

test('a drag is not a click, and a captured pointer keeps its mesh without a pick', async () => {
  const s = scene(),
    a = s.mesh(),
    b = s.mesh(),
    log = [];
  let picks = 0;
  s.on(a, {
    onPointerDown: (e) => e.setPointerCapture(),
    onPointerMove: (e) => log.push(`a move ${e.target.id} ${e.hasPointerCapture()}`),
    onPointerUp: (e) => log.push(`a up ${Math.round(e.delta)}`),
    onClick: () => log.push('a click'),
  });
  s.on(b, { onPointerMove: () => log.push('b move') });
  s.setUnder(() => (picks++, a));
  s.send('pointerdown', 10);
  await s.settle();
  assert.equal(s.element.captured, 1, 'the canvas captures the pointer');
  s.setUnder(() => (picks++, b));
  const before = picks;
  s.send('pointermove', 40);
  s.send('pointerup', 40);
  await s.settle();
  assert.equal(picks, before, 'a captured pointer needs no pick');
  assert.deepEqual(log, [`a move ${a.id} true`, 'a up 30']);
  s.send('pointermove', 41);
  await s.settle();
  assert.deepEqual(log.at(-1), 'b move', 'the release ends the capture');
  s.detach();
});

test('double click, context menu and wheel reach their handlers and bubble', async () => {
  const s = scene(),
    root = s.mesh(),
    leaf = s.mesh(root),
    log = [];
  s.on(root, {
    onDoubleClick: (e) => log.push(`dbl ${e.nativeEvent.type}`),
    onContextMenu: (e) => log.push(`menu ${e.nativeEvent.type}`),
    onWheel: (e) => log.push(`wheel ${e.nativeEvent.deltaY}`),
  });
  s.setUnder(() => leaf);
  s.send('dblclick', 5);
  s.send('contextmenu', 5);
  s.send('wheel', 5, { deltaY: 1 });
  s.send('wheel', 5, { deltaY: 2 });
  await s.settle();
  // Wheel turns in one burst collapse to the latest, like moves.
  assert.deepEqual(log, ['dbl dblclick', 'menu contextmenu', 'wheel 2']);
  s.detach();
});

test('a handlers record seen at several meshes fires once, as its owner', async () => {
  const s = scene(),
    group = s.mesh(),
    root = s.mesh(group),
    node = s.mesh(root),
    log = [];
  // A model registers one record for all its nodes, with its root as the owner.
  const record = liveHandlers({ current: { onClick: (e) => log.push(`model ${e.currentTarget.id}`) } }, root);
  s.handlers.set(root.id, record);
  s.handlers.set(node.id, record);
  s.on(group, { onClick: () => log.push('group') });
  s.setUnder(() => node);
  s.send('pointerdown', 1);
  s.send('pointerup', 1);
  await s.settle();
  assert.deepEqual(log, [`model ${root.id}`, 'group']);
  assert.equal(hasPointerHandlers({}), false);
  assert.equal(hasPointerHandlers({ onWheel() {} }), true);
  s.detach();
});

test('a bordered canvas picks and reports x/y from the padding box, as engine.pick measures it', async () => {
  // Batch 132 audit: coordinates came from the border box, so a CSS border shifted every pick by its width.
  const s = scene(),
    leaf = s.mesh(),
    picked = [],
    seen = [];
  Object.defineProperty(s.element, 'clientLeft', { value: 7 });
  Object.defineProperty(s.element, 'clientTop', { value: 3 });
  s.element.getBoundingClientRect = () => ({ left: 100, top: 50 });
  s.engine.pick = async (x, y) => (picked.push([x, y]), leaf);
  s.on(leaf, { onPointerDown: (event) => seen.push([event.x, event.y]) });
  s.element.dispatchEvent(Object.assign(new window.MouseEvent('pointerdown', { clientX: 120, clientY: 60, button: 0 })));
  await s.settle();
  assert.deepEqual(picked, [[13, 7]]);
  assert.deepEqual(seen, [[13, 7]]);
  s.detach();
});
