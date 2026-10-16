import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Input } from '../dist/index.js';

test('releasing a touch pointer leaves a held mouse action down', () => {
  const target = new EventTarget(),
    input = new Input({ fire: [{ type: 'mouse', button: 0 }] }, { target, gamepads: () => [] });
  const pointer = (type, pointerType) =>
    target.dispatchEvent(Object.assign(new Event(type), { pointerType, button: 0 }));
  try {
    pointer('pointerdown', 'mouse');
    input.update();
    assert.equal(input.state('fire').down, true);
    pointer('pointerdown', 'touch');
    pointer('pointerup', 'touch');
    input.update();
    assert.equal(input.state('fire').down, true);
    assert.equal(input.state('fire').released, false);
    pointer('pointerup', 'mouse');
    input.update();
    assert.equal(input.state('fire').released, true);
  } finally {
    input.dispose();
  }
});

test('constructor failure removes every listener installed before the failure', () => {
  for (let failAt = 1; failAt <= 8; failAt++) {
    const target = new EventTarget(),
      active = new Set(),
      failure = new Error(`listener ${failAt}`);
    const add = target.addEventListener.bind(target),
      remove = target.removeEventListener.bind(target);
    let calls = 0;
    target.addEventListener = (type, listener) => {
      if (++calls === failAt) throw failure;
      add(type, listener);
      active.add(listener);
    };
    target.removeEventListener = (type, listener) => {
      remove(type, listener);
      active.delete(listener);
    };
    assert.throws(
      () => new Input({ jump: [{ type: 'key', code: 'Space' }] }, { target, gamepads: () => [] }),
      (error) => error === failure,
    );
    assert.equal(active.size, 0, `listener failure ${failAt} retained callbacks`);
  }
});
test('semantic edges, opposite keys, gamepad deadzone and editable fields behave predictably', (t) => {
  const dom = new JSDOM('<body><input></body>'),
    pad = { axes: [0.1], buttons: [{ value: 1 }] };
  t.after(() => dom.window.close());
  const input = new Input(
    {
      move: [
        { type: 'key', code: 'KeyD' },
        { type: 'key', code: 'KeyA', scale: -1 },
        { type: 'gamepad-axis', index: 0 },
      ],
      jump: [{ type: 'gamepad-button', index: 0 }],
    },
    { target: dom.window, gamepads: () => [pad] },
  );
  t.after(() => input.dispose());
  const key = (type, code, target = dom.window) =>
    target.dispatchEvent(new dom.window.KeyboardEvent(type, { code, bubbles: true }));
  key('keydown', 'KeyD');
  input.update();
  assert.equal(input.state('move').value, 1);
  assert.equal(input.state('move').pressed, true);
  assert.equal(input.state('jump').pressed, true);
  input.update();
  assert.equal(input.state('move').pressed, false);
  key('keydown', 'KeyA');
  input.update();
  assert.equal(input.state('move').value, 0);
  assert.equal(input.state('move').released, true);
  input.reset();
  key('keydown', 'KeyD', dom.window.document.querySelector('input'));
  input.update();
  assert.equal(input.state('move').value, 0);
  pad.axes[0] = 0.575;
  input.update();
  assert.ok(Math.abs(input.state('move').value - 0.5) < 1e-9);
  dom.window.dispatchEvent(new dom.window.Event('blur'));
  pad.axes[0] = 0;
  input.update();
  assert.equal(input.state('move').released, true);
  input.dispose();
  assert.throws(() => input.update(), /disposed/);
});
test('unsupported and supported haptics return explicit results and validate strengths', async () => {
  let effect;
  const pad = {
    vibrationActuator: {
      async playEffect(type, options) {
        effect = [type, options];
      },
    },
  };
  const input = new Input(
    { go: [{ type: 'key', code: 'KeyW' }] },
    { target: new EventTarget(), gamepads: () => [pad] },
  );
  try {
    assert.equal(await input.rumble(200, 0.5), true);
    assert.equal(effect[0], 'dual-rumble');
    assert.equal(effect[1].strongMagnitude, 0.5);
    assert.equal(await input.rumble(200, 1, 1), false);
    await assert.rejects(input.rumble(10, 2), /Invalid/);
  } finally {
    input.dispose();
  }
});

test('touch sticks and buttons capture pointers, reset on focus loss and support keyboard activation', () => {
  const dom = new JSDOM('<body><button>Fire</button></body>'),
    input = new Input(
      { move: [{ type: 'touch', id: 'move', axis: 'x' }], fire: [{ type: 'touch', id: 'fire' }] },
      { target: dom.window, gamepads: () => [] },
    );
  const stick = input.createStick(dom.window.document.body, 'move'),
    button = dom.window.document.querySelector('button');
  input.bindTouchButton(button, 'fire');
  let capture;
  stick.setPointerCapture = button.setPointerCapture = (id) => {
    capture = id;
  };
  stick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 120, height: 120 });
  const pointer = (element, type, id, x = 60, y = 60) => {
    const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } });
    element.dispatchEvent(event);
  };
  pointer(stick, 'pointerdown', 1, 120);
  input.update();
  assert.equal(capture, 1);
  assert.equal(input.state('move').value, 1);
  input.reset();
  pointer(stick, 'pointerdown', 2, 0);
  input.update();
  assert.equal(input.state('move').value, -1);
  pointer(stick, 'lostpointercapture', 2);
  input.update();
  assert.equal(input.state('move').value, 0);
  pointer(button, 'pointerdown', 3);
  pointer(button, 'pointerdown', 4);
  pointer(button, 'pointerup', 4);
  input.update();
  assert.equal(input.state('fire').down, true);
  pointer(button, 'pointercancel', 3);
  input.update();
  assert.equal(input.state('fire').released, true);
  button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  input.update();
  assert.equal(input.state('fire').pressed, true);
  button.dispatchEvent(new dom.window.Event('blur'));
  input.update();
  assert.equal(input.state('fire').released, true);
  input.dispose();
  assert.equal(stick.isConnected, false);
  dom.window.close();
});
