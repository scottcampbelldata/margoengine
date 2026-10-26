import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { evaluateSurfaceGraph, parseSurfaceGraph, serializeSurfaceGraph } from '../dist/graph.js';
import {
  EDITOR_OPERATIONS,
  GraphModel,
  INPUT_DEFAULTS,
  NODE_WIDTH,
  NodeEditor,
  inputSocket,
  outputSocket,
} from '../dist/editor.js';

const fixture = () => ({
  version: 1,
  nodes: [
    { id: 'position', op: 'position', inputs: [] },
    { id: 'scale', op: 'float', inputs: [], value: 2 },
    { id: 'scaled', op: 'mul', inputs: ['position', 'scale'] },
    { id: 'bands', op: 'sin', inputs: ['scaled'] },
    { id: 'color', op: 'saturate', inputs: ['bands'] },
  ],
  outputs: { color: 'color' },
  fallback: { color: [1, 1, 1], emissive: [0, 0, 0], roughness: 0.7, metalness: 0, opacity: 1 },
});
const sample = { position: [0.25, 0.5, 1], normal: [0, 1, 0] };

test('the palette lists every portable operation once, and every default names a real input', () => {
  const ops = EDITOR_OPERATIONS.map((o) => o.op);
  assert.equal(new Set(ops).size, ops.length);
  assert.equal(ops.length, 28);
  for (const [op, defaults] of Object.entries(INPUT_DEFAULTS)) assert.ok(ops.includes(op) && defaults.length > 0);
  for (const o of EDITOR_OPERATIONS) assert.ok(o.label && o.description.endsWith('.'), o.op);
});

test('a graph built through the model exports the portable graph, with hidden constants for defaulted inputs', () => {
  const m = new GraphModel();
  const position = m.addNode('position', [0, 0]),
    multiply = m.addNode('mul', [200, 0]),
    sine = m.addNode('sin', [400, 0]),
    split = m.addNode('component', [600, 0], 1);
  assert.deepEqual([position.id, multiply.id, sine.id, split.id], ['position1', 'mul1', 'sin1', 'component1']);
  assert.equal(m.status().ok, false, 'mul1 and the rest are not wired yet');
  m.connect('position1', 'mul1', 0);
  m.setInline('mul1', 1, 3);
  m.connect('mul1', 'sin1', 0);
  m.connect('sin1', 'component1', 0);
  m.connectOutput('sin1', 'color');
  m.connectOutput('component1', 'roughness');
  const status = m.status();
  assert.equal(status.ok, true, status.message);
  assert.deepEqual(status.types, { position1: 'vec3f', mul1: 'vec3f', sin1: 'vec3f', component1: 'f32' });
  const graph = m.toGraph();
  assert.equal(graph.nodes.filter((n) => n.op === 'float').length, 1, 'one hidden constant (the typed 3)');
  assert.equal(graph.nodes.find((n) => n.op === 'float').value, 3);
  assert.deepEqual(parseSurfaceGraph(m.toJSON()), graph, 'canonical JSON round-trips');
  const out = evaluateSurfaceGraph(graph, sample);
  assert.ok(Math.abs(out.color[1] - Math.sin(1.5)) < 1e-6);
  assert.ok(Math.abs(out.roughness - Math.sin(1.5)) < 1e-6);
  m.setInline('mul1', 1, undefined);
  assert.equal(m.toGraph().nodes.find((n) => n.op === 'float').value, 1, 'back to the default of 1');
});

test('an incomplete graph says which node and input to fix, and exporting it throws the same advice', () => {
  const m = new GraphModel();
  m.addNode('sin');
  const status = m.status();
  assert.equal(status.ok, false);
  assert.equal(status.node, 'sin1');
  assert.match(status.message, /connect a node to input 1 \(Value\) of sin1, or delete sin1/);
  assert.throws(
    () => m.toGraph(),
    (e) => e instanceof TypeError && /incomplete/.test(e.message),
  );
  m.removeNodes(['sin1']);
  assert.equal(m.status().ok, true);
});

test('wires that would loop, point at nothing or miss an input are refused with the fix', () => {
  const m = new GraphModel();
  const a = m.addNode('add'),
    b = m.addNode('sin');
  m.connect(a.id, b.id, 0);
  assert.throws(
    () => m.connect(b.id, a.id, 0),
    (e) => e instanceof RangeError && /loop/.test(e.message) && /does not depend/.test(e.message),
  );
  assert.throws(() => m.connect(a.id, a.id, 0), /loop/);
  assert.throws(() => m.connect(a.id, b.id, 1), /has 1 inputs; pass an input index from 0 to 0/);
  assert.throws(() => m.connect('nope', b.id, 0), /There is no node "nope"/);
  assert.throws(() => m.connectOutput(a.id, 'shininess'), /not an output slot/);
  assert.throws(() => m.addNode('blur'), /not a surface operation/);
  assert.deepEqual(m.node('sin1').inputs, ['add1']);
});

test('type mistakes show in the status and clear when fixed', () => {
  const m = new GraphModel();
  const p = m.addNode('position');
  m.connectOutput(p.id, 'roughness');
  let status = m.status();
  assert.equal(status.ok, false);
  assert.match(status.message, /roughness output must be f32/);
  m.disconnectOutput('roughness');
  const len = m.addNode('length');
  m.connect(p.id, len.id, 0);
  m.connectOutput(len.id, 'roughness');
  status = m.status();
  assert.equal(status.ok, true, status.message);
  assert.equal(status.types.length1, 'f32');
});

test('undo and redo step through edits; a batch is one step; a failed batch changes nothing; a no-op is no step', () => {
  const m = new GraphModel();
  let events = 0;
  m.subscribe(() => events++);
  const a = m.addNode('position'),
    b = m.addNode('length');
  m.connect(a.id, b.id, 0);
  assert.equal(events, 3);
  m.connect(a.id, b.id, 0);
  assert.equal(events, 3, 'wiring what is already wired changes nothing');
  m.batch(() => {
    m.connectOutput(b.id, 'roughness');
    m.connectOutput(a.id, 'color');
  });
  assert.equal(events, 4);
  assert.throws(() =>
    m.batch(() => {
      m.removeNodes([a.id]);
      m.connect('missing', 'length1', 0);
    }),
  );
  assert.equal(m.nodes.length, 2, 'the removal inside the failed batch was rolled back');
  assert.equal(events, 4);
  assert.ok(m.undo());
  assert.deepEqual(m.outputs, {}, 'both outputs undone together');
  assert.ok(m.undo());
  assert.equal(m.node('length1').inputs[0], null);
  assert.ok(m.redo());
  assert.equal(m.node('length1').inputs[0], 'position1');
  assert.equal(m.canRedo, true, 'the undone output batch can still be redone');
  m.addNode('abs');
  assert.equal(m.canRedo, false, 'a new edit drops the redo history');
  while (m.undo());
  assert.equal(m.nodes.length, 0);
  assert.equal(m.undo(), false);
});

test('removing a node clears the wires and output slots that used it; duplicates keep outside wires', () => {
  const m = new GraphModel(fixture());
  m.removeNodes(['scaled']);
  assert.deepEqual(m.node('bands').inputs, [null]);
  m.undo();
  assert.deepEqual(m.node('bands').inputs, ['scaled']);
  m.removeNodes(['color']);
  assert.deepEqual(m.outputs, {});
  m.undo();
  const copies = m.duplicate(['scaled', 'bands']);
  assert.deepEqual(copies, ['mul1', 'sin1']);
  assert.deepEqual(m.node('mul1').inputs, ['position', 'scale'], 'wires from outside the copy are kept');
  assert.deepEqual(m.node('sin1').inputs, ['mul1'], 'wires inside the copy point at the copy');
  assert.equal(m.node('mul1').x, m.node('scaled').x + 24);
  assert.equal(m.status().ok, true);
});

test('loading a graph keeps its meaning, arranges it in columns and saves a layout', () => {
  const m = new GraphModel(fixture());
  assert.deepEqual(JSON.parse(m.toJSON()), JSON.parse(serializeSurfaceGraph(fixture())));
  const x = (id) => m.node(id).x;
  assert.ok(
    x('position') < x('scaled') && x('scaled') < x('bands') && x('bands') < x('color') && x('color') < m.output.x,
  );
  assert.equal(x('position'), x('scale'), 'sources share the first column');
  const layout = m.layout,
    again = new GraphModel(fixture(), layout);
  assert.deepEqual(again.layout, layout);
  m.checkpoint();
  m.move(['scaled', 'output'], 10, -5);
  assert.equal(m.layout.scaled[0], layout.scaled[0] + 10);
  assert.equal(m.output.y, layout.output[1] - 5);
  m.undo();
  assert.deepEqual(m.layout, layout, 'a checkpointed drag undoes in one step');
  assert.throws(() => m.move(['scaled'], Number.NaN, 0), /finite distances/);
  assert.throws(() => new GraphModel({ ...fixture(), version: 2 }), /Surface graph is invalid; set version to 1/);
});

test('values, inline constants, fallback and limits are checked before they change anything', () => {
  const m = new GraphModel(fixture());
  assert.throws(() => m.setValue('scale', Number.POSITIVE_INFINITY), /finite number/);
  assert.throws(() => m.setValue('scale', [1, 2, 3]), /finite number/);
  assert.throws(() => m.setValue('position', 1), /has no value/);
  assert.throws(() => m.setInline('scaled', 0, 1), /has no default/);
  assert.throws(() => m.setInline('scaled', 1, Number.NaN), /finite number/);
  m.addNode('component');
  assert.throws(() => m.setValue('component1', 3), /0, 1 or 2/);
  m.addNode('vec3', [0, 0], [0.1, 0.2, 0.3]);
  assert.throws(() => m.setValue('vec31', [1, 2]), /three finite numbers/);
  assert.throws(() => m.setFallback({ roughness: 2 }), /from 0 to 1/);
  assert.throws(() => m.setFallback({ color: [-1, 0, 0] }), /nonnegative/);
  m.setFallback({ roughness: 0.2, color: [0.5, 0.5, 0.5] });
  assert.equal(m.fallback.roughness, 0.2);
  m.removeNodes(['component1', 'vec31']);
  assert.equal(m.toGraph().fallback.roughness, 0.2);
  const big = new GraphModel();
  for (let i = 0; i < 128; i++) big.addNode('position');
  assert.throws(() => big.addNode('position'), /at most 128 nodes/);
  assert.throws(() => big.duplicate(['position1']), /at most 128 nodes/);
});

// ------------------------------------------------------------------ the view

function mount(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true }),
    host = dom.window.document.getElementById('host'),
    editor = new NodeEditor(host, options),
    root = editor.element.shadowRoot,
    $ = (selector) => root.querySelector(selector),
    $$ = (selector) => [...root.querySelectorAll(selector)];
  const viewport = $('.viewport');
  const pointer = (target, type, x, y, init = {}) =>
    target.dispatchEvent(
      new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...init }),
    );
  const key = (k, init = {}) =>
    viewport.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
  const socket = (node, kind, input) =>
    $$(`.node[data-node="${node}"] .socket`).find(
      (s) => s.dataset.socket === kind && (input === undefined || s.dataset.input === String(input)),
    );
  return { dom, editor, root, $, $$, viewport, pointer, key, socket };
}

test('Shift+A opens the palette, typing filters it and Enter adds the first match to the graph', () => {
  const { editor, $, $$, viewport, key, dom } = mount();
  assert.equal($('.palette').hidden, true);
  key('A', { shiftKey: true });
  assert.equal($('.palette').hidden, false);
  assert.equal($$('.palette li').length, 28);
  const search = $('.palette input');
  search.value = 'multip';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(
    $$('.palette li').map((li) => li.textContent.split(' ')[0]),
    ['Multiply'],
  );
  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal($('.palette').hidden, true);
  assert.deepEqual(
    editor.model.nodes.map((n) => n.op),
    ['mul'],
  );
  assert.deepEqual(editor.selection, ['mul1']);
  assert.equal($$('.node').length, 2, 'the node and the output panel');
  assert.ok($('.node[data-node="mul1"]').hasAttribute('data-selected'));
  assert.equal(viewport.getAttribute('role'), 'application');
});

test('click an output, then an input: the sockets are buttons, so the keyboard wires nodes too', () => {
  const { editor, $, $$, socket, dom } = mount();
  const a = editor.add('position', [0, 0]),
    b = editor.add('length', [300, 0]);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok($$('.socket').every((s) => s.tagName === 'BUTTON' && s.getAttribute('aria-label')));
  click(socket(a, 'out'));
  assert.ok(socket(a, 'out').hasAttribute('data-armed'));
  click(socket(b, 'in', 0));
  assert.deepEqual(editor.model.node(b).inputs, [a]);
  assert.equal($$('path.wire').length, 1);
  assert.equal($('path.wire').dataset.type, 'vec3f');
  assert.match(socket(b, 'in', 0).getAttribute('aria-label'), /wired from position1/);
  // Clicking the wired input picks the wire up; clicking the output slot drops it there.
  click(socket(b, 'in', 0));
  assert.deepEqual(editor.model.node(b).inputs, [null]);
  click($$('.socket').find((s) => s.dataset.slot === 'color'));
  assert.equal(editor.model.outputs.color, a);
  assert.equal(editor.status.ok, false, 'length1 is still unwired');
  editor.model.removeNodes([b]);
  assert.equal(editor.status.ok, true);
});

test('dragging from an output socket to an input socket connects them; dropping on empty space cancels', () => {
  const { editor, $$, socket, viewport, pointer } = mount();
  const a = editor.add('position', [0, 0]),
    b = editor.add('length', [300, 40]);
  editor.fit();
  // fit() changes the pan; read it back from the world transform.
  const m = /translate\((-?[\d.]+)px,(-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
    viewport.querySelector('.world').style.transform,
  );
  const [px, py, scale] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const client = ([x, y]) => [x * scale + px, y * scale + py];
  const from = client(outputSocket(editor.model.node(a))),
    to = client(inputSocket(editor.model.node(b), 0));
  pointer(socket(a, 'out'), 'pointerdown', ...from);
  pointer(viewport, 'pointermove', from[0] + 30, from[1] + 10);
  assert.equal($$('path.wire[data-pending]').length, 1, 'a dashed wire follows the pointer');
  pointer(viewport, 'pointermove', ...to);
  pointer(viewport, 'pointerup', ...to);
  assert.deepEqual(editor.model.node(b).inputs, [a]);
  assert.equal($$('path.wire[data-pending]').length, 0);
  // Pick the wire up by its input socket and drop it on nothing: it is removed in one undo step.
  pointer(socket(b, 'in', 0), 'pointerdown', ...to);
  pointer(viewport, 'pointermove', to[0] + 80, to[1] + 120);
  pointer(viewport, 'pointerup', to[0] + 80, to[1] + 120);
  assert.deepEqual(editor.model.node(b).inputs, [null]);
  editor.model.undo();
  assert.deepEqual(editor.model.node(b).inputs, [a]);
  // From an output to empty space: nothing changes and no undo step is added.
  const before = editor.model.canUndo;
  pointer(socket(a, 'out'), 'pointerdown', ...from);
  pointer(viewport, 'pointermove', from[0] + 5, from[1] + 90);
  pointer(viewport, 'pointerup', from[0] + 5, from[1] + 90);
  assert.equal(editor.model.canUndo, before);
  assert.deepEqual(editor.model.node(b).inputs, [a]);
});

test('a refused wire is explained in the status line and leaves the graph as it was', () => {
  const { editor, $, socket, dom } = mount();
  const a = editor.add('sin', [0, 0]),
    b = editor.add('cos', [300, 0]);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  editor.model.connect(a, b, 0);
  click(socket(b, 'out'));
  click(socket(a, 'in', 0));
  assert.match($('.status').textContent, /would make a loop/);
  assert.equal($('.status').dataset.ok, 'false');
  assert.deepEqual(editor.model.node(a).inputs, [null]);
});

test('dragging a header moves the selection as one undo step; the arrow keys nudge', () => {
  const { editor, $, viewport, pointer, key } = mount();
  const a = editor.add('position', [0, 0]),
    b = editor.add('length', [300, 0]);
  editor.select([a, b]);
  const header = $('.node[data-node="position1"] .head');
  const start = [100, 100];
  pointer(header, 'pointerdown', ...start);
  pointer(viewport, 'pointermove', start[0] + 20, start[1] + 10);
  const scale = Number(/scale\(([\d.]+)\)/.exec(viewport.querySelector('.world').style.transform)[1]);
  pointer(viewport, 'pointermove', start[0] + 40, start[1] + 20);
  pointer(viewport, 'pointerup', start[0] + 40, start[1] + 20);
  assert.ok(Math.abs(editor.model.node(a).x - 40 / scale) < 1e-9);
  assert.ok(Math.abs(editor.model.node(b).x - (300 + 40 / scale)) < 1e-9);
  editor.model.undo();
  assert.equal(editor.model.node(a).x, 0);
  assert.equal(editor.model.node(b).x, 300);
  key('ArrowRight');
  key('ArrowDown', { shiftKey: true });
  assert.deepEqual([editor.model.node(a).x, editor.model.node(a).y], [8, 32]);
  assert.equal($('.node[data-node="position1"]').style.left, '8px');
});

test('Delete, Ctrl+Z, Ctrl+Y, Ctrl+D and Ctrl+A edit the graph like other node editors', () => {
  const { editor, key } = mount({ graph: fixture() });
  editor.select(['bands']);
  key('Delete');
  assert.equal(editor.model.node('bands'), undefined);
  assert.deepEqual(editor.model.node('color').inputs, [null]);
  key('z', { ctrlKey: true });
  assert.ok(editor.model.node('bands'));
  key('y', { ctrlKey: true });
  assert.equal(editor.model.node('bands'), undefined);
  key('Z', { ctrlKey: true, shiftKey: true });
  assert.ok(!editor.model.canRedo);
  key('z', { ctrlKey: true });
  key('a', { ctrlKey: true });
  assert.equal(editor.selection.length, 5);
  editor.select(['scale']);
  key('d', { ctrlKey: true });
  assert.deepEqual(editor.selection, ['float1']);
  assert.equal(editor.model.node('float1').value, 2);
  key('Escape');
});

test('typing in a value field changes the graph; a bad number is explained and the field resets', () => {
  const { editor, $, dom } = mount({ graph: fixture() });
  const input = $('.node[data-node="scale"] input');
  assert.equal(input.value, '2');
  input.value = '4.5';
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(editor.model.node('scale').value, 4.5);
  const again = $('.node[data-node="scale"] input');
  again.value = '1e9';
  again.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(editor.model.node('scale').value, 4.5);
  assert.match($('.status').textContent, /finite number within \+-1000000/);
  assert.equal($('.node[data-node="scale"] input').value, '4.5');
  // An unconnected input with a default shows a field; wiring it removes the field.
  const m = editor.model;
  m.addNode('mix', [0, 300]);
  assert.equal($('.node[data-node="mix1"] input').getAttribute('aria-label'), 'mix1 Factor (default 0.5)');
  m.connect('scale', 'mix1', 2);
  assert.equal($('.node[data-node="mix1"] input'), null);
});

test('onGraph reports each valid graph that differs, not moves or invalid states; dispose stops everything', () => {
  const { editor, $, dom } = mount({ graph: fixture() });
  const seen = [];
  const stop = editor.onGraph((g) => seen.push(g));
  assert.equal(seen.length, 1, 'called once with the current valid graph');
  editor.model.checkpoint();
  editor.model.move(['scale'], 5, 5);
  assert.equal(seen.length, 1, 'a move is not a new graph');
  editor.model.setValue('scale', 3);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].nodes.find((n) => n.id === 'scale').value, 3);
  editor.model.addNode('sin');
  assert.equal(seen.length, 2, 'an incomplete graph is not reported');
  assert.equal($('.status').dataset.ok, 'false');
  editor.model.undo();
  assert.equal(seen.length, 2, 'back to the graph already reported');
  editor.model.undo();
  assert.equal(seen.length, 3);
  const statuses = [];
  editor.onChange((s) => statuses.push(s.ok));
  editor.model.redo();
  assert.deepEqual(statuses, [true]);
  assert.equal(seen.length, 4, 'redo brings back the edited graph');
  stop();
  editor.model.setValue('scale', 6);
  assert.equal(seen.length, 4, 'stopped');
  editor.dispose();
  editor.dispose();
  assert.equal(dom.window.document.querySelector('[data-margo-node-editor]'), null);
  assert.throws(
    () => editor.onGraph(() => {}),
    (e) => e.code === 'disposed' && /create a new NodeEditor/.test(e.message),
  );
});

test('Symbol.dispose and an AbortSignal both remove the editor', () => {
  const a = mount();
  a.editor[Symbol.dispose]();
  assert.equal(a.dom.window.document.querySelector('[data-margo-node-editor]'), null);
  const controller = new AbortController(),
    b = mount({ signal: controller.signal });
  assert.ok(b.dom.window.document.querySelector('[data-margo-node-editor]'));
  controller.abort();
  assert.equal(b.dom.window.document.querySelector('[data-margo-node-editor]'), null);
  const done = new AbortController();
  done.abort();
  const c = mount({ signal: done.signal });
  assert.equal(c.dom.window.document.querySelector('[data-margo-node-editor]'), null);
});

test('a read-only editor shows the graph but refuses edits with an error that names the fix', () => {
  const { editor, $, $$, key, dom } = mount({ graph: fixture(), readOnly: true });
  assert.throws(
    () => editor.add('sin'),
    (e) => e.code === 'state' && /without readOnly/.test(e.message),
  );
  editor.select(['scaled']);
  key('Delete');
  key('A', { shiftKey: true });
  assert.ok(editor.model.node('scaled'));
  assert.equal($('.palette').hidden, true);
  assert.ok($$('.node input').every((i) => i.disabled));
  assert.ok(
    $$('.toolbar button')
      .filter((b) => ['Add node', 'Undo', 'Redo', 'Arrange'].includes(b.textContent))
      .every((b) => b.disabled),
  );
  $('.viewport').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal($('.palette').hidden, true);
});

test('invalid nodes are outlined, the status line selects them, and the WGSL panel shows the generated shader', () => {
  const { editor, $, dom } = mount({ graph: fixture() });
  $$$(editor, 'button')
    .find((b) => b.textContent === 'WGSL')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal($('.code').hidden, false);
  assert.match($('.code').textContent, /sin\(/);
  const id = editor.model.addNode('sin', [0, 400]).id;
  assert.ok($(`.node[data-node="${id}"]`).hasAttribute('data-invalid'));
  assert.match($('.code').textContent, /incomplete/);
  $('.status').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(editor.selection, [id]);
  editor.model.removeNodes([id]);
  assert.match($('.code').textContent, /sin\(/);
  assert.match($('.status').textContent, /Valid graph driving color/);
});
function $$$(editor, selector) {
  return [...editor.element.shadowRoot.querySelectorAll(selector)];
}

test('wheel zooms around the pointer, dragging empty space pans, and Fit shows everything', () => {
  const { editor, $, viewport, pointer, dom } = mount({ graph: fixture() });
  const world = viewport.querySelector('.world');
  const t = () =>
    /translate\((-?[\d.]+)px,(-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform).slice(1).map(Number);
  const [x0, y0, z0] = t();
  viewport.dispatchEvent(
    new dom.window.WheelEvent('wheel', { deltaY: -200, clientX: 300, clientY: 200, bubbles: true, cancelable: true }),
  );
  const [x1, y1, z1] = t();
  assert.ok(z1 > z0);
  assert.ok(
    Math.abs((300 - x1) / z1 - (300 - x0) / z0) < 1e-6 && Math.abs((200 - y1) / z1 - (200 - y0) / z0) < 1e-6,
    'the point under the cursor stays put',
  );
  pointer(viewport, 'pointerdown', 10, 10);
  pointer(viewport, 'pointermove', 40, 30);
  pointer(viewport, 'pointerup', 40, 30);
  const [x2, y2] = t();
  assert.equal(x2 - x1, 30);
  assert.equal(y2 - y1, 20);
  editor.fit();
  const [, , z3] = t();
  assert.ok(z3 <= 1 && z3 >= 0.25);
  assert.equal($('.node[data-node="output"]').getAttribute('aria-label'), 'Material output');
});

test('Arrange lays nodes out again and Add node opens the palette from the toolbar', () => {
  const { editor, $, $$, dom } = mount({ graph: fixture() });
  const press = (label) =>
    $$('.toolbar button')
      .find((b) => b.textContent === label)
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  editor.model.checkpoint();
  editor.model.move(['scaled'], 500, 500);
  press('Arrange');
  assert.ok(editor.model.node('scaled').x < editor.model.node('bands').x);
  press('Undo');
  assert.ok(Math.abs(editor.model.node('scaled').x - editor.model.layout.scaled[0]) < 1e-9);
  press('Add node');
  assert.equal($('.palette').hidden, false);
  assert.equal(NODE_WIDTH, 176);
});
