// Remote inspection between two sides of one process: the target is a real Engine (a recording renderer, no GPU)
// with real package objects, the viewer talks to it over a MessageChannel and, separately, over the real HTTP relay
// on 127.0.0.1 with Node's fetch, as a phone page and a desktop page would through a relay on the LAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Bloom } from '@margoengine/post';
import { RemoteInspector, RemoteTarget, channelTransport, relayTransport } from '../dist/remote.js';
import { createRemoteRelay } from '../dist/remote-relay.js';

async function scene() {
  const dom = new JSDOM('<body></body>');
  const store = await TransformStore.create(16),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    canvas = dom.window.document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 150;
  const engine = new Engine(canvas, store, renderer, undefined, null);
  const bloom = new Bloom({ strength: 1.2 });
  engine.plugins.set(bloom.name, bloom);
  return { dom, engine, bloom };
}
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('Remote inspection state timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pair = () => {
  const { port1, port2 } = new MessageChannel();
  return [channelTransport(port1), channelTransport(port2), () => (port1.close(), port2.close())];
};

test('a viewer lists, edits, undoes and refuses through a target, with its token and range checks', async (t) => {
  const { dom, engine, bloom } = await scene();
  const [phone, desk, close] = pair();
  t.after(close);
  const target = RemoteTarget.attach(engine, { transport: phone, token: 'secret-token-1', statsIntervalMs: 100 });
  const viewer = new RemoteInspector({ transport: desk, token: 'secret-token-1', parent: dom.window.document.body });
  t.after(() => (viewer.dispose(), target.dispose()));
  const hello = await viewer.connect();
  assert.deepEqual([hello.backend, hello.width, hello.height], ['webgl2', 300, 150]);
  const effect = viewer.objects.find((o) => o.id === 'effect:bloom');
  assert.ok(effect, 'the Bloom plugin is listed');
  const strength = effect.properties.find((p) => p.key === 'strength');
  assert.equal(strength.value, 1.2);
  assert.deepEqual([strength.min, strength.max], [0, 4]);
  const edited = await viewer.set('effect:bloom', 'strength', 2.5);
  assert.equal(bloom.options.strength, 2.5, 'the edit reached the object on the target');
  assert.equal(edited.properties.find((p) => p.key === 'strength').value, 2.5);
  await assert.rejects(viewer.set('effect:bloom', 'strength', 9), /strength/);
  assert.equal(bloom.options.strength, 2.5, 'an out-of-range edit changes nothing');
  await assert.rejects(viewer.set('effect:none', 'strength', 1), /No object effect:none/);
  await assert.rejects(viewer.request('evaluate'), /Unknown remote operation/);
  assert.equal(await viewer.undo(), true);
  assert.equal(bloom.options.strength, 1.2);
  assert.equal(await viewer.redo(), true);
  assert.equal(bloom.options.strength, 2.5);
  // Stats arrive unasked; the target counts its frames.
  target.onPreUpdate(1 / 50);
  target.onPreUpdate(1 / 50);
  await until(() => viewer.stats?.frames === 2);
  assert.equal(Math.round(viewer.stats.fps), 50);
  assert.equal(viewer.stats.frames, 2);
  // The panel lists the objects with inputs that edit the target.
  const root = viewer.element.shadowRoot,
    input = [...root.querySelectorAll('input')].find((i) => /^Bloom.* strength$/i.test(i.getAttribute('aria-label')));
  assert.ok(input);
  input.value = '3';
  input.dispatchEvent(new dom.window.Event('change'));
  await until(() => bloom.options.strength === 3);
  assert.equal(bloom.options.strength, 3);
  assert.match(root.querySelector('.status').textContent, /webgl2 300x150, 50 fps/);
});

test('a request without the token is refused; a target that does not answer times out', async (t) => {
  const { engine, bloom } = await scene();
  const [phone, desk, close] = pair();
  t.after(close);
  const target = RemoteTarget.attach(engine, { transport: phone, token: 'secret-token-1', statsIntervalMs: 0 });
  const stranger = new RemoteInspector({ transport: desk, parent: null, timeoutMs: 200 });
  t.after(() => (stranger.dispose(), target.dispose()));
  await assert.rejects(stranger.set('effect:bloom', 'strength', 0), /token/);
  assert.equal(bloom.options.strength, 1.2);
  target.dispose();
  await assert.rejects(stranger.request('hello'), /did not answer hello in 200 ms/);
  assert.throws(() => new RemoteTarget({ transport: phone, token: 'short' }), /8 or more characters/);
  assert.throws(() => new RemoteInspector({ transport: desk, parent: null, timeoutMs: 5 }), /100 to 120000/);
});

test('two viewers on one relay each get the answer to their own request (R5)', async (t) => {
  // The relay sends every target reply to every viewer, and each viewer numbers its requests from 1: viewer B's
  // 'scene' resolved with viewer A's 'hello' reply.
  const relay = await createRemoteRelay();
  t.after(() => relay.close());
  const { engine } = await scene();
  const phone = relayTransport({ url: relay.url, token: relay.token, role: 'target' }),
    deskA = relayTransport({ url: relay.url, token: relay.token, role: 'viewer' }),
    deskB = relayTransport({ url: relay.url, token: relay.token, role: 'viewer' });
  const target = RemoteTarget.attach(engine, { transport: phone, statsIntervalMs: 0 });
  const a = new RemoteInspector({ transport: deskA, parent: null }),
    b = new RemoteInspector({ transport: deskB, parent: null });
  t.after(() => (a.dispose(), b.dispose(), target.dispose(), phone.close(), deskA.close(), deskB.close()));
  await until(() => relay.streams('target') === 1 && relay.streams('viewer') === 2);
  const [hello, objects] = await Promise.all([a.request('hello'), b.request('scene')]);
  assert.equal(hello.backend, 'webgl2');
  assert.ok(Array.isArray(objects), `viewer B got ${JSON.stringify(objects)}`);
  assert.equal(objects.length, hello.objects);
});

test('through the HTTP relay: a target and a viewer edit by token, a wrong token is refused', async (t) => {
  const relay = await createRemoteRelay();
  t.after(() => relay.close());
  assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const { engine, bloom } = await scene();
  const errors = [];
  const phone = relayTransport({ url: relay.url, token: relay.token, role: 'target', onError: (e) => errors.push(e) }),
    desk = relayTransport({ url: relay.url, token: relay.token, role: 'viewer', onError: (e) => errors.push(e) });
  const target = RemoteTarget.attach(engine, { transport: phone, statsIntervalMs: 0 });
  const viewer = new RemoteInspector({ transport: desk, parent: null });
  t.after(() => (viewer.dispose(), target.dispose(), phone.close(), desk.close()));
  // Both streams open before the first message.
  for (let i = 0; i < 100 && (relay.streams('target') < 1 || relay.streams('viewer') < 1); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.streams('target'), 1);
  assert.equal(relay.streams('viewer'), 1);
  const hello = await viewer.connect();
  assert.equal(hello.backend, 'webgl2');
  await viewer.set('effect:bloom', 'strength', 0.5);
  assert.equal(bloom.options.strength, 0.5);
  // A message with a line break inside a string arrives whole.
  await assert.rejects(viewer.set('line\nbreak', 'strength', 1), /No object line\nbreak/);
  assert.deepEqual(errors, []);
  const refused = await fetch(`${relay.url}/send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong', 'X-Margo-Role': 'viewer' },
    body: '{}',
  });
  assert.equal(refused.status, 401);
  const preflight = await fetch(`${relay.url}/send`, { method: 'OPTIONS', headers: { Origin: 'http://phone.test' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://phone.test');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  const bad = relayTransport({
    url: relay.url,
    token: 'not-the-token',
    role: 'viewer',
    onError: (e) => errors.push(e),
  });
  bad.listen(() => {});
  for (let i = 0; i < 100 && !errors.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(errors[0]?.message ?? '', /Relay refused the stream \(401\)/);
  await assert.rejects(createRemoteRelay({ token: 'short' }), /16 or more characters/);
});
