import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const world = {},
  players = [],
  overlays = [],
  pickers = new WeakMap();
const stages = [];
mock.module(new URL('../dist/index.js', import.meta.url).href, {
  namedExports: {
    createStage: async (host) => {
      const canvas = host.ownerDocument.createElement('canvas'),
        abort = new AbortController();
      host.append(canvas);
      const stage = {
        canvas,
        signal: abort.signal,
        disposed: 0,
        engine: {
          render() {},
          onError(error) {
            throw error;
          },
        },
        dispose() {
          this.disposed++;
          abort.abort();
          canvas.remove();
        },
      };
      stages.push(stage);
      return stage;
    },
  },
});
mock.module(new URL('../dist/viewer.js', import.meta.url).href, {
  namedExports: {
    addViewer: async (_stage, _url, options) => {
      if (world.gate) await world.gate;
      options.signal.throwIfAborted();
      const callbacks = new Set(),
        node = {},
        model = {
          root: {},
          nodes: [node],
          primitives: [],
          variants: ['red', 'blue'],
          asset: { doc: { animations: world.static ? [] : [{}] } },
          onDispose(callback) {
            callbacks.add(callback);
            return () => callbacks.delete(callback);
          },
          selectVariant(value) {
            if (value !== undefined && !this.variants.includes(value) && !this.variants[value])
              throw new Error('Unknown variant');
            this.selectedVariant = typeof value === 'string' ? this.variants.indexOf(value) : value;
          },
          dispose() {
            for (const callback of [...callbacks]) callback();
          },
        };
      let turns = true;
      const viewer = {
        model,
        disposed: 0,
        get turntable() {
          return turns;
        },
        set turntable(value) {
          turns = value;
        },
        dispose() {
          this.disposed++;
          model.dispose();
        },
      };
      // The real viewer's disposal closes over its state; avoid depending on a method receiver in the mock.
      viewer.dispose = () => {
        viewer.disposed++;
        model.dispose();
      };
      world.last = viewer;
      world.beforeReturn?.();
      return viewer;
    },
  },
});
mock.module('@margoengine/animation', {
  namedExports: {
    Animation: {
      attach() {
        const player = {
          clips: [{ name: 'idle' }, { name: 'walk' }],
          clip: 0,
          playing: true,
          time: 0,
          disposed: 0,
          play(clip) {
            const i = typeof clip === 'string' ? this.clips.findIndex((c) => c.name === clip) : clip;
            if (!this.clips[i]) throw new Error('Unknown animation');
            this.clip = i;
            this.time = 0;
            this.playing = true;
          },
          seek(time) {
            this.time = time;
          },
          dispose() {
            this.disposed++;
          },
        };
        players.push(player);
        return player;
      },
    },
  },
});
mock.module('@margoengine/labels', {
  namedExports: {
    LabelRenderer: {
      attach(_engine, { parent }) {
        const root = parent.ownerDocument.createElement('div');
        parent.append(root);
        const renderer = {
          disposed: 0,
          add(element) {
            root.append(element);
            element.style.transform = 'translate(1px)';
            return {
              remove() {
                element.remove();
              },
            };
          },
          dispose() {
            this.disposed++;
            root.remove();
          },
        };
        overlays.push(renderer);
        return renderer;
      },
    },
  },
});
mock.module('@margoengine/selection', {
  namedExports: {
    Picking: {
      forEngine(engine) {
        return pickers.get(engine);
      },
      attach(engine) {
        const picker = {
          disposed: 0,
          async pick() {
            return world.hit ?? null;
          },
          dispose() {
            this.disposed++;
            pickers.delete(engine);
          },
        };
        pickers.set(engine, picker);
        return picker;
      },
    },
  },
});
const { addViewerExtras, registerViewerElement } = await import('@margoengine/stage/viewer-extras');
function fixture() {
  world.static = false;
  world.gate = null;
  world.hit = null;
  world.beforeReturn = null;
  const dom = new JSDOM('<main><canvas></canvas><button id="label" style="color:red">Point</button><i></i></main>'),
    host = dom.window.document.querySelector('main'),
    canvas = host.querySelector('canvas'),
    abort = new AbortController();
  const stage = {
    canvas,
    signal: abort.signal,
    engine: {
      renders: 0,
      render() {
        this.renders++;
      },
      onError(error) {
        throw error;
      },
    },
  };
  return { dom, host, stage, abort, label: host.querySelector('#label') };
}
test('entry import is SSR safe; registration requires an explicit browser call', () => {
  assert.equal(globalThis.customElements, undefined);
  assert.throws(() => registerViewerElement(), /browser/);
});
test('animation selection, resume, variants and live turntable survive composition; disposal is idempotent', async () => {
  const f = fixture(),
    viewer = await addViewerExtras(f.stage, 'model.glb', { animationName: 'walk', variant: 'blue' });
  assert.equal(viewer.animation.playing, false);
  assert.equal(viewer.animation.clip, 1);
  assert.equal(viewer.model.selectedVariant, 1);
  viewer.seek(1.5);
  viewer.play();
  assert.equal(viewer.animation.time, 1.5);
  viewer.pause();
  assert.equal(viewer.animation.playing, false);
  viewer.play('idle');
  assert.equal(viewer.animation.clip, 0);
  viewer.selectVariant();
  assert.equal(viewer.model.selectedVariant, undefined);
  viewer.turntable = false;
  assert.equal(viewer.turntable, false);
  viewer.dispose();
  viewer.dispose();
  assert.equal(viewer.disposed, 1);
  assert.equal(viewer.animation.disposed, 1);
  assert.equal(viewer.picking.disposed, 1);
  f.dom.window.close();
});
test('hotspots restore caller DOM order and styles; poster supports manual reveal', async () => {
  const f = fixture(),
    next = f.label.nextSibling,
    style = f.label.getAttribute('style'),
    viewer = await addViewerExtras(f.stage, 'model.glb', {
      poster: 'poster.png',
      reveal: 'manual',
      hotspots: [{ element: f.label, position: [0, 0, 0] }],
    });
  assert.equal(viewer.poster.hidden, false);
  assert.equal(viewer.poster.disabled, false);
  assert.equal(f.stage.canvas.getAttribute('aria-hidden'), 'true');
  viewer.poster.click();
  assert.equal(viewer.poster.hidden, true);
  assert.equal(f.stage.canvas.getAttribute('aria-hidden'), null);
  assert.notEqual(f.label.parentNode, f.host);
  await assert.rejects(viewer.addHotspot({ element: f.label }), /already exists/);
  viewer.removeHotspot(f.label);
  assert.equal(f.label.parentNode, f.host);
  assert.equal(f.label.nextSibling, next);
  assert.equal(f.label.getAttribute('style'), style);
  await viewer.addHotspot({ element: f.label });
  f.abort.abort();
  assert.equal(f.label.parentNode, f.host);
  assert.equal(f.label.nextSibling, next);
  assert.equal(f.host.querySelector('img'), null);
  assert.equal(viewer.disposed, 1);
  f.dom.window.close();
});
test('shared pickers retain other viewers and external pickers, and filter other model hits', async () => {
  const f = fixture(),
    a = await addViewerExtras(f.stage, 'a'),
    b = await addViewerExtras(f.stage, 'b');
  assert.equal(a.picking, b.picking);
  world.hit = { model: b.model, mesh: b.model.nodes[0] };
  assert.equal(await a.pick(0, 0), null);
  assert.equal((await b.pick(0, 0)).model, b.model);
  a.dispose();
  assert.equal(b.picking.disposed, 0);
  b.dispose();
  assert.equal(b.picking.disposed, 1);
  const external = {
    dispose() {
      throw new Error('Caller owns this');
    },
  };
  pickers.set(f.stage.engine, external);
  const c = await addViewerExtras(f.stage, 'c');
  c.dispose();
  assert.equal(pickers.get(f.stage.engine), external);
  f.dom.window.close();
});
test('invalid clips and aborts roll back every resource and restore poster state', async () => {
  const f = fixture();
  await assert.rejects(
    addViewerExtras(f.stage, 'a', { animationName: 'missing', poster: 'poster.png' }),
    /Unknown animation/,
  );
  assert.equal(world.last.disposed, 1);
  assert.equal(players.at(-1).disposed, 1);
  assert.equal(f.host.querySelector('img'), null);
  let release;
  world.gate = new Promise((resolve) => {
    release = resolve;
  });
  const loading = addViewerExtras(f.stage, 'a', { poster: 'poster.png' });
  assert.equal(f.host.querySelector('button[aria-busy]').disabled, true);
  f.abort.abort();
  release();
  await assert.rejects(loading, { name: 'AbortError' });
  assert.equal(f.host.querySelector('img'), null);
  assert.equal(f.stage.canvas.getAttribute('aria-hidden'), null);
  f.dom.window.close();
});
test('model disposal also restores annotations and disabled features stay absent', async () => {
  const f = fixture();
  world.static = true;
  const viewer = await addViewerExtras(f.stage, 'a', { picking: false, hotspots: [{ element: f.label }] });
  assert.equal(viewer.animation, null);
  assert.equal(viewer.picking, null);
  await assert.rejects(viewer.pick(0, 0), /disabled/);
  viewer.model.dispose();
  assert.equal(f.label.parentNode, f.host);
  assert.equal(viewer.disposed, 1);
  f.dom.window.close();
});
test('abort at the producer resolution boundary retires the returned viewer', async () => {
  const f = fixture();
  world.beforeReturn = () => f.abort.abort();
  await assert.rejects(addViewerExtras(f.stage, 'a'), /disposed|abort/i);
  assert.equal(world.last.disposed, 1);
  f.dom.window.close();
});
test('cancelled hotspot reservations cannot delete a replacement addition', async () => {
  const f = fixture(),
    viewer = await addViewerExtras(f.stage, 'a');
  const cancelled = viewer.addHotspot({ element: f.label });
  viewer.removeHotspot(f.label);
  const replacement = viewer.addHotspot({ element: f.label });
  await assert.rejects(cancelled, { name: 'AbortError' });
  await replacement;
  await assert.rejects(viewer.addHotspot({ element: f.label }), /already exists/);
  viewer.dispose();
  assert.equal(f.label.parentNode, f.host);
  f.dom.window.close();
});
test('declarative src replacement, controls, abort, reconnect and annotation restoration', async () => {
  const f = fixture(),
    keys = ['HTMLElement', 'customElements', 'CustomEvent', 'AbortController', 'AbortSignal'],
    saved = keys.map((key) => globalThis[key]);
  for (const key of keys) globalThis[key] = f.dom.window[key];
  try {
    registerViewerElement('margo-test', { viewer: { picking: false } });
    const element = f.dom.window.document.createElement('margo-test');
    element.setAttribute('src', 'https://example.test/a.glb');
    element.setAttribute('animation-name', 'walk');
    element.setAttribute('variant-name', 'blue');
    f.label.slot = 'hotspot-a';
    f.label.dataset.position = '0 1 0';
    element.append(f.label);
    const loaded = new Promise((resolve, reject) => {
      element.addEventListener('load', resolve, { once: true });
      element.addEventListener('error', (e) => reject(e.detail.error), { once: true });
    });
    f.host.append(element);
    await loaded;
    await element.ready;
    assert.deepEqual(element.availableAnimations, ['idle', 'walk']);
    assert.deepEqual(element.availableVariants, ['red', 'blue']);
    assert.equal(element.paused, true);
    element.play();
    element.currentTime = 0.5;
    assert.equal(element.currentTime, 0.5);
    const old = element.stage;
    element.setAttribute('variant-name', 'red');
    assert.equal(element.viewer.model.selectedVariant, 0);
    element.setAttribute('auto-rotate', '');
    assert.equal(element.viewer.turntable, true);
    assert.equal(element.stage, old, 'live controls keep the existing stage');
    element.remove();
    assert.equal(old.disposed, 1);
    assert.equal(f.label.parentNode, element);
    const reloaded = new Promise((resolve) => element.addEventListener('load', resolve, { once: true }));
    f.host.append(element);
    await reloaded;
    assert.notEqual(element.stage, old);
    let release;
    world.gate = new Promise((resolve) => {
      release = resolve;
    });
    element.src = 'https://example.test/b.glb';
    await Promise.resolve();
    await Promise.resolve();
    const pending = element.ready;
    element.remove();
    release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(element.viewer, null);
    assert.equal(element.stage, null);
    assert.equal(stages.at(-1).disposed, 1);
    assert.equal(f.label.parentNode, element);
    world.gate = null;
    const failed = new Promise((resolve) => element.addEventListener('error', resolve, { once: true }));
    element.src = 'http://[';
    f.host.append(element);
    const event = await failed;
    assert.ok(event.detail.error instanceof TypeError);
    await assert.rejects(element.ready, TypeError);
    assert.equal(element.hasAttribute('aria-busy'), false);
    element.remove();
  } finally {
    for (let i = 0; i < keys.length; i++) {
      if (saved[i] === undefined) delete globalThis[keys[i]];
      else globalThis[keys[i]] = saved[i];
    }
    f.dom.window.close();
  }
});
