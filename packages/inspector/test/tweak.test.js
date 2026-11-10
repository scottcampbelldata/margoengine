import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TweakPanel } from '../dist/tweak.js';
import { EditHistory } from '../dist/history.js';

function setup(t) {
  const dom = new JSDOM('<body></body>'),
    history = new EditHistory(),
    panel = new TweakPanel({ parent: dom.window.document.body, history });
  t.after(() => {
    panel.dispose();
    dom.window.close();
  });
  return { dom, panel, history };
}
function input(dom, element, value, event = 'input') {
  element.value = value;
  element.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
}
test('standalone typed bindings, nested folders, enum identity, button inverse and shared undo', (t) => {
  const { panel, history } = setup(t),
    position = { x: 1, y: 2, z: 3 },
    color = new Float32Array([1, 0, 0, 0.5]),
    state = {
      speed: 1,
      label: 'A',
      visible: true,
      position,
      color,
      mode: 1,
      count: 0,
      run() {
        this.count++;
      },
    };
  const folder = panel.addFolder('Transform'),
    vector = folder.add(state, 'position'),
    speed = panel.add(state, 'speed', { min: 0, max: 10, step: 0.5 });
  speed.setValue(2.3);
  assert.equal(state.speed, 2.5);
  panel.add(state, 'label').setValue('B');
  panel.add(state, 'visible').setValue(false);
  vector.setValue({ x: 4, y: 5, z: 6 });
  assert.equal(state.position, position);
  panel.addColor(state, 'color').setValue([0, 1, 0, 0.75]);
  assert.equal(state.color, color);
  panel.add(state, 'mode', { options: { low: 1, high: 3 } }).setValue(3);
  panel.add(state, 'run', { undo: () => state.count-- }).fire();
  assert.equal(state.count, 1);
  assert.equal(history.undoCount, 7);
  while (panel.undo());
  assert.equal(state.speed, 1);
  assert.equal(state.label, 'A');
  assert.equal(state.visible, true);
  assert.deepEqual(position, { x: 1, y: 2, z: 3 });
  assert.deepEqual([...color], [1, 0, 0, 0.5]);
  assert.equal(state.mode, 1);
  assert.equal(state.count, 0);
  while (panel.redo());
  assert.equal(state.count, 1);
  assert.equal(state.speed, 2.5);
});
test('a long input gesture is one undo step, separate gestures never coalesce and Escape cancels', (t) => {
  const { panel, dom, history } = setup(t),
    state = { n: 0 },
    binding = panel.add(state, 'n', { min: 0, max: 100 }),
    range = binding.element.querySelector('input[type=range]');
  for (let i = 1; i < 50; i++) input(dom, range, String(i));
  assert.equal(state.n, 49);
  assert.equal(history.undoCount, 0);
  input(dom, range, '50', 'change');
  assert.equal(history.undoCount, 1);
  input(dom, range, '60', 'change');
  assert.equal(history.undoCount, 2);
  panel.undo();
  assert.equal(state.n, 50);
  panel.undo();
  assert.equal(state.n, 0);
  input(dom, range, '20');
  range.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(state.n, 0);
  assert.equal(history.undoCount, 0);
});
test('all native controls edit, retain vector references, and refresh after external writes and history', (t) => {
  const { panel, dom } = setup(t),
    state = {
      v: [1, 2, 3, 4],
      c: '#ff0000',
      hex: 0xff0000,
      rgb: { r: 255, g: 0, b: 0, a: 0.5 },
      n: 1,
      flag: false,
      mode: 'a',
    };
  const v = panel.add(state, 'v'),
    c = panel.addColor(state, 'c'),
    hex = panel.addColor(state, 'hex'),
    rgb = panel.addColor(state, 'rgb', { colorScale: 255 }),
    n = panel.add(state, 'n'),
    flag = panel.add(state, 'flag'),
    mode = panel.add(state, 'mode', { options: ['a', 'b'] });
  input(dom, v.element.querySelectorAll('input')[2], '9', 'change');
  assert.deepEqual(state.v, [1, 2, 9, 4]);
  input(dom, c.element.querySelector('input'), '#00ff00', 'change');
  assert.equal(state.c, '#00ff00');
  input(dom, hex.element.querySelector('input'), '#0000ff', 'change');
  assert.equal(state.hex, 255);
  input(dom, rgb.element.querySelector('input[type=color]'), '#00ff00', 'change');
  assert.deepEqual(state.rgb, { r: 0, g: 255, b: 0, a: 0.5 });
  const checkbox = flag.element.querySelector('input');
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change'));
  assert.equal(state.flag, true);
  input(dom, mode.element.querySelector('select'), '1', 'change');
  assert.equal(state.mode, 'b');
  state.n = 8;
  panel.refresh();
  assert.equal(n.element.querySelector('input').value, '8');
  n.setValue(4);
  panel.undo();
  assert.equal(n.element.querySelector('input').value, '8');
});
test('validation precedes writes, HTML is escaped, readonly and abort/dispose clean up', (t) => {
  const { panel, dom, history } = setup(t),
    state = { n: 1, vector: { x: 1, y: 2 }, text: '<script>x</script>' };
  assert.throws(() => panel.add(state, 'n', { step: 0 }), RangeError);
  const n = panel.add(state, 'n'),
    vector = panel.add(state, 'vector');
  const color = panel.addColor({ value: '#ff0000' }, 'value');
  assert.throws(() => color.setValue('#oops00'), TypeError);
  assert.throws(() => n.setValue(NaN), TypeError);
  assert.throws(() => vector.setValue({ x: 5, y: NaN }), TypeError);
  assert.deepEqual(state.vector, { x: 1, y: 2 });
  assert.equal(history.undoCount, 0);
  input(dom, n.element.querySelector('input'), '');
  assert.equal(state.n, 1);
  const readonly = panel.add(state, 'text', { label: '<script>', readonly: true });
  assert.equal(panel.element.querySelector('script'), null);
  assert.throws(() => readonly.setValue('x'), { code: 'state' });
  const abort = new AbortController(),
    other = new TweakPanel({ parent: dom.window.document.body, signal: abort.signal });
  other.addFolder('child').add(state, 'n');
  abort.abort();
  assert.equal(other.element.isConnected, false);
  assert.throws(() => other.add(state, 'n'), { code: 'disposed' });
  other.dispose();
});
test('object-valued enum choices retain exact identity through reset, undo and redo', (t) => {
  const { panel } = setup(t),
    a = { value: 1 },
    b = { value: 1 },
    state = { choice: a };
  const binding = panel.add(state, 'choice', { options: { a, b } });
  binding.setValue(b);
  assert.equal(state.choice, b);
  panel.undo();
  assert.equal(state.choice, a);
  panel.redo();
  assert.equal(state.choice, b);
  binding.reset();
  assert.equal(state.choice, a);
});
