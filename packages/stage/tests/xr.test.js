import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// The button's logic against a stand-in XR; tests/modern-xr.ts drives the real XR with a real click and real WebGPU.
class Session extends EventTarget {}
const world = { supported: true, supportFailure: null, createFailure: null, sessionFailure: null, created: [] };
class XR {
  session = null;
  ended = 0;
  disposed = 0;
  requests = [];
  static async isSupported(mode) {
    if (world.supportFailure) throw world.supportFailure;
    return world.supported === true || world.supported === mode;
  }
  static async create(engine, { signal }) {
    if (world.createFailure) throw world.createFailure;
    if (world.gate) await world.gate;
    signal.throwIfAborted();
    const xr = new XR();
    world.created.push(xr);
    return xr;
  }
  async requestSession(mode, options) {
    this.requests.push([mode, options]);
    if (world.sessionFailure) throw world.sessionFailure;
    return (this.session = new Session());
  }
  async end() {
    this.ended++;
    const session = this.session;
    this.session = null;
    session.dispatchEvent(new Event('end'));
  }
  dispose() {
    this.disposed++;
  }
}
mock.module('@margoengine/xr', { namedExports: { XR } });
const { addXRButton } = await import('@margoengine/stage/xr');

function fixture(t, { backend = 'webgpu', parentStyle = '' } = {}) {
  Object.assign(world, {
    supported: true,
    supportFailure: null,
    createFailure: null,
    sessionFailure: null,
    gate: null,
    created: [],
  });
  const { window } = new JSDOM(`<div id="host" style="${parentStyle}"><canvas></canvas></div>`),
    host = window.document.querySelector('#host'),
    disposal = new AbortController(),
    errors = [];
  t.after(() => window.close());
  const stage = {
    canvas: host.querySelector('canvas'),
    signal: disposal.signal,
    engine: { backend, onError: (error) => errors.push(error) },
  };
  return { stage, host, errors, dispose: () => disposal.abort(), window };
}
const settled = () => new Promise((resolve) => setTimeout(resolve));

test('a click enters, the label follows the session and a second click leaves', async (t) => {
  const { stage, host } = fixture(t),
    onFrame = () => {};
  const button = await addXRButton(stage, { onFrame, referenceSpace: 'local-floor' }),
    { element, xr } = button;
  assert.equal(element.parentElement, host);
  assert.equal(element.tagName, 'BUTTON');
  assert.equal(element.type, 'button', 'inside a form it must not submit');
  assert.equal(element.textContent, 'Enter VR');
  assert.equal(element.disabled, false);
  assert.equal(button.supported, true);
  element.click();
  assert.equal(element.getAttribute('aria-busy'), 'true');
  element.click();
  await settled();
  assert.equal(xr.requests.length, 1, 'a second click while the first is pending starts nothing');
  assert.deepEqual(xr.requests[0], ['immersive-vr', { onFrame, referenceSpace: 'local-floor' }]);
  assert.equal(element.textContent, 'Exit VR');
  assert.equal(element.hasAttribute('aria-busy'), false);
  element.click();
  await settled();
  assert.equal(xr.ended, 1);
  assert.equal(element.textContent, 'Enter VR');
  element.click();
  await settled();
  assert.equal(xr.requests.length, 2, 'the button works again after a session');
});

test('a session ended by the browser or the headset resets the label', async (t) => {
  const { stage } = fixture(t),
    { element, xr } = await addXRButton(stage, { mode: 'immersive-ar' });
  assert.equal(element.textContent, 'Enter AR');
  element.click();
  await settled();
  assert.equal(element.textContent, 'Exit AR');
  xr.session.dispatchEvent(new Event('end'));
  assert.equal(element.textContent, 'Enter AR');
});

test('where the session cannot start the button stays, disabled and saying so', async (t) => {
  const cases = [
    ['no support', {}, () => (world.supported = false)],
    ['a WebGL2 stage', { backend: 'webgl2' }, () => {}],
    [
      'a blocking permissions policy',
      {},
      () => (world.supportFailure = Object.assign(new Error('blocked'), { name: 'SecurityError' })),
    ],
    [
      'a compatibility adapter',
      {},
      () => (world.createFailure = Object.assign(new Error('no'), { code: 'unsupported' })),
    ],
  ];
  for (const [name, options, arrange] of cases) {
    const { stage } = fixture(t, options);
    arrange();
    const button = await addXRButton(stage, { mode: 'immersive-vr' });
    assert.equal(button.supported, false, name);
    assert.equal(button.xr, null, name);
    assert.equal(button.element.disabled, true, name);
    assert.equal(button.element.textContent, 'VR not available', name);
    button.element.click();
    button.dispose();
    assert.equal(button.element.isConnected, false, name);
  }
});

test('real failures reject or report instead of showing an unavailable button', async (t) => {
  const { stage, host, errors } = fixture(t);
  world.supportFailure = new Error('browser broke');
  await assert.rejects(addXRButton(stage), /browser broke/);
  world.supportFailure = null;
  world.createFailure = Object.assign(new Error('no device'), { code: 'failed' });
  await assert.rejects(addXRButton(stage), /no device/);
  assert.equal(host.querySelector('button'), null);
  world.createFailure = null;
  const { element } = await addXRButton(stage);
  world.sessionFailure = new Error('permission refused');
  element.click();
  await settled();
  assert.deepEqual(errors, [world.sessionFailure]);
  assert.equal(element.textContent, 'Enter VR');
  const seen = [];
  const second = await addXRButton(stage, { onError: (error) => seen.push(error) });
  second.element.click();
  await settled();
  assert.deepEqual(seen, [world.sessionFailure]);
});

test('labels, parent and class come from the caller; a class leaves the page styles alone', async (t) => {
  const { stage, host, window } = fixture(t),
    panel = window.document.createElement('div');
  window.document.body.append(panel);
  const { element } = await addXRButton(stage, {
    parent: panel,
    label: 'Betreten',
    exitLabel: 'Verlassen',
    className: 'mine',
  });
  assert.equal(element.parentElement, panel);
  assert.equal(element.className, 'mine');
  assert.equal(element.getAttribute('style'), null);
  assert.equal(panel.style.position, '');
  assert.equal(host.style.position, '');
  assert.equal(element.textContent, 'Betreten');
  element.click();
  await settled();
  assert.equal(element.textContent, 'Verlassen');
  world.supported = false;
  const off = await addXRButton(stage, { unavailableLabel: 'Nicht da', parent: panel });
  assert.equal(off.element.textContent, 'Nicht da');
});

test('the built-in style anchors to the parent, and a second button stacks above the first', async (t) => {
  const { stage, host } = fixture(t, { parentStyle: 'position:static' });
  const vr = await addXRButton(stage),
    ar = await addXRButton(stage, { mode: 'immersive-ar' });
  assert.equal(host.style.position, 'relative');
  assert.equal(vr.element.style.bottom, '20px');
  assert.equal(ar.element.style.bottom, '76px');
  const positioned = fixture(t, { parentStyle: 'position:fixed' });
  await addXRButton(positioned.stage);
  assert.equal(positioned.host.style.position, 'fixed');
});

test('buttons of a stage share one XR and the last one releases it', async (t) => {
  const { stage } = fixture(t),
    [vr, ar] = await Promise.all([addXRButton(stage), addXRButton(stage, { mode: 'immersive-ar' })]);
  assert.equal(world.created.length, 1);
  assert.equal(vr.xr, ar.xr);
  vr.dispose();
  vr.dispose();
  await settled();
  assert.equal(vr.xr.disposed, 0, 'the AR button still uses it');
  ar[Symbol.dispose]();
  await settled();
  assert.equal(ar.xr.disposed, 1);
  const next = await addXRButton(stage);
  assert.equal(world.created.length, 2, 'a new button gets a new XR');
  assert.notEqual(next.xr, vr.xr);
});

test('stage disposal removes the button and aborts a pending one, adding nothing', async (t) => {
  const { stage, host, dispose } = fixture(t),
    { element, xr } = await addXRButton(stage);
  dispose();
  await settled();
  assert.equal(element.isConnected, false);
  assert.equal(xr.disposed, 1);
  await assert.rejects(addXRButton(stage), { name: 'AbortError' });
  const next = fixture(t);
  let open;
  world.gate = new Promise((resolve) => (open = resolve));
  const pending = addXRButton(next.stage);
  await settled();
  next.dispose();
  open();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(next.host.querySelector('button'), null);
  assert.equal(host.querySelector('button'), null);
});

test("one caller's abort fails only that caller, and frees nothing the other button uses", async (t) => {
  const { stage, host } = fixture(t),
    caller = new AbortController();
  let open;
  world.gate = new Promise((resolve) => (open = resolve));
  const first = addXRButton(stage, { signal: caller.signal }),
    second = addXRButton(stage, { mode: 'immersive-ar' });
  await settled();
  caller.abort();
  open();
  await assert.rejects(first, { name: 'AbortError' });
  const { xr, element } = await second;
  await settled();
  assert.equal(xr.disposed, 0);
  assert.deepEqual([...host.querySelectorAll('button')], [element]);
});

test('a stage without a page rejects with a state error, naming the fix', async (t) => {
  const { stage } = fixture(t);
  stage.canvas.remove();
  await assert.rejects(addXRButton(stage), { code: 'state', message: /parent option/ });
});
