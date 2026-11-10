import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { AnimationPanel } from '../dist/animation.js';

async function fixture(t) {
  const dom = new JSDOM('<body><canvas width="400" height="300"></canvas></body>'),
    engine = new Engine(
      dom.window.document.querySelector('canvas'),
      await TransformStore.create(16),
      { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
      undefined,
      null,
    ),
    root = engine.createMesh(),
    child = engine.createMesh().setParent(root).setPosition([0, 1, 0]);
  let disposed = false;
  const callbacks = new Set(),
    weights = new Float32Array([0]),
    model = {
      name: 'Rig',
      root,
      nodes: [root, child],
      primitives: [{ weights }],
      asset: { doc: { skins: [{ joints: [0, 1] }], nodes: [{ children: [1] }, {}] } },
      get disposed() {
        return disposed;
      },
      onDispose(fn) {
        callbacks.add(fn);
        return () => callbacks.delete(fn);
      },
    },
    animation = {
      name: 'animation:Rig',
      model,
      clips: [
        { name: 'Walk', duration: 2 },
        { name: 'Run', duration: 2 },
      ],
      clip: 0,
      time: 0,
      playing: true,
      options: { loop: true, speed: 1 },
      captureState() {
        return { version: 1, clip: this.clip, time: this.time, playing: this.playing, ...this.options };
      },
      restoreState(state) {
        Object.assign(this, { clip: state.clip, playing: state.playing });
        Object.assign(this.options, { loop: state.loop, speed: state.speed });
        return this.seek(state.time);
      },
      seek(time) {
        this.time = time;
        child.setPosition([time * (this.clip ? 6 : 2), 1, 0]);
        weights[0] = time * (this.clip ? 0.5 : 0.25);
        return this;
      },
    },
    panel = AnimationPanel.attach(engine, [animation], { parent: dom.window.document.body });
  t.after(() => {
    panel.dispose();
    engine.dispose();
    dom.window.close();
  });
  return {
    dom,
    engine,
    animation,
    panel,
    child,
    weights,
    disposeModel() {
      disposed = true;
      callbacks.forEach((fn) => fn());
    },
  };
}
test('per-model play, pause, independent scrubs, normalized weights and morphs', async (t) => {
  const { panel, animation, child, weights } = await fixture(t);
  panel.set(animation, 0, { time: 1, playing: false });
  assert.equal(child.position.x, 2);
  panel.set(animation, 1, { time: 1, weight: 0.25, playing: false });
  panel.set(animation, 0, { weight: 0.75 });
  assert.equal(child.position.x, 3);
  assert.equal(weights[0], 0.3125);
  panel.set(animation, 0, { weight: 0 });
  panel.set(animation, 1, { weight: 0 });
  assert.equal(child.position.x, 0);
  assert.equal(weights[0], 0);
  panel.set(animation, 0, { weight: 1, time: 1.5, speed: 2, playing: true, loop: true });
  panel.onPreUpdate(0.5);
  assert.equal(panel.state(animation, 0).time, 0.5);
  panel.set(animation, 0, { time: 1.5, loop: false });
  panel.onPreUpdate(0.5);
  assert.equal(child.position.x, 4);
  assert.equal(panel.state(animation, 0).playing, false);
  assert.equal(animation.playing, false);
  assert.throws(() => panel.set(animation, 0, { weight: NaN }), /finite/);
  assert.throws(() => panel.set(animation, 4, { time: 0 }), /clip index/);
});
test('skeleton follows current joints, UI scrub pauses, disposal restores player and removes helpers', async (t) => {
  const { dom, engine, panel, animation } = await fixture(t);
  panel.element.querySelector('input[type=checkbox]').click();
  engine.render();
  panel.drawSkeletons();
  assert.match(panel.overlay.querySelector('path').getAttribute('d'), /^M.+L/);
  const input = panel.element.querySelector('[aria-label="Walk Time"]');
  input.value = '1';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.equal(panel.state(animation, 0).playing, false);
  panel.dispose();
  panel.dispose();
  assert.equal(animation.playing, true);
  assert.equal(animation.options.loop, true);
  assert.equal(animation.time, 0);
  assert.equal(panel.overlay.isConnected, false);
  assert.equal(panel.element.isConnected, false);
});
test('model disposal removes only that model; abort releases panel', async (t) => {
  const { engine, animation, panel, disposeModel } = await fixture(t);
  disposeModel();
  assert.throws(() => panel.state(animation, 0), /player added/);
  const controller = new AbortController(),
    other = AnimationPanel.attach(engine, [], { signal: controller.signal });
  controller.abort();
  assert.equal(other.element.isConnected, false);
});
