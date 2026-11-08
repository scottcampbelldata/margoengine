import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { HTML } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('HTML shares rendered depth, projects anchors, bounds capacity and removes DOM/resources', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  const overlay = new HTML({ capacity: 1 });
  h.engine.use(overlay);
  const label = overlay.add(dom.window.document.createElement('span'), { position: [0, 0, 0.5] });
  h.frame();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(label.onScreen, true);
  assert.equal(h.counts.compute, 1);
  assert.throws(() => overlay.add(dom.window.document.createElement('span')), /capacity/);
  overlay.remove(label);
  assert.equal(label.element.isConnected, false);
  overlay.onDeviceRestored();
  h.frame();
  await new Promise((resolve) => setImmediate(resolve));
  overlay.dispose();
  assert.equal(dom.window.document.querySelector('[data-margoengine-labels]'), null);
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
  dom.window.close();
});

test('HTML retains depth bindings, skips empty anchors and replaces bindings after resize/restoration', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  const depth = () =>
    h.engine.gpu.createTexture({
      size: [h.context.width, h.context.height],
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  let source = depth();
  const overlay = new HTML({ capacity: 2, depth: () => source });
  h.engine.use(overlay);
  const frame = async () => {
    h.frame();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const empty = { ...h.counts };
    await frame();
    assert.equal(h.counts.compute, empty.compute, 'Empty overlay dispatched occlusion');
    assert.equal(h.counts.groups, empty.groups);
    const label = overlay.add(dom.window.document.createElement('span'), { position: [0, 0, 0.5] });
    await frame();
    const warm = { ...h.counts };
    for (let i = 0; i < 4; i++) await frame();
    assert.equal(h.counts.groups, warm.groups, 'Stable depth recreated bind groups');
    assert.equal(h.counts.views, warm.views, 'Stable depth recreated texture views');
    assert.equal(h.counts.compute, warm.compute + 4);
    const previous = source;
    h.context.width = 64;
    source = depth();
    previous.destroy();
    await frame();
    assert.equal(h.counts.groups, warm.groups + 1);
    const beforeRestore = h.counts.groups;
    overlay.onDeviceRestored();
    await frame();
    assert.equal(h.counts.groups, beforeRestore + 1);
    overlay.remove(label);
    const removed = { ...h.counts };
    await frame();
    assert.equal(h.counts.compute, removed.compute);
    assert.equal(h.counts.groups, removed.groups);
    source.width = 1;
    assert.throws(() => h.frame(), /viewport-sized scene depth/, 'Empty anchors must retain external depth validation');
  } finally {
    overlay.dispose();
    source.destroy();
    dom.window.close();
  }
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('HTML depth uploads avoid temporary arrays over 120 frames and clear removed or hidden slots', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  const overlay = new HTML({ capacity: 16 });
  h.engine.use(overlay);
  const label = overlay.add(dom.window.document.createElement('span'), { position: [0, 0, 0.5] });
  const set = Float32Array.prototype.set;
  let temporary = 0;
  try {
    Float32Array.prototype.set = function (values, ...args) {
      if (this.length === 64 && Array.isArray(values) && values.length === 4) temporary++;
      return set.call(this, values, ...args);
    };
    for (let i = 0; i < 120; i++) {
      h.frame();
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    Float32Array.prototype.set = set;
  }
  try {
    assert.equal(temporary, 0, 'Depth point and sentinel writes must retain storage');
    assert.deepEqual([...overlay.values.slice(4, 8)], [-1, -1, 0, 0]);
    label.visible = false;
    h.frame();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...overlay.values.slice(0, 4)], [-1, -1, 0, 0]);
    overlay.remove(label);
    const next = overlay.add(dom.window.document.createElement('span'), { position: [0.25, 0, 0.5] });
    h.frame();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(next.onScreen, true);
    assert.deepEqual([...overlay.values.slice(0, 4)], [80, 48, 0.5, Math.fround(0.0001)]);
  } finally {
    overlay.dispose();
    dom.window.close();
  }
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('HTML clears stale occlusion while an anchor moves before depth readback', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  const overlay = new HTML({ capacity: 1 });
  h.engine.use(overlay);
  const label = overlay.add(dom.window.document.createElement('span'), { position: [0, 0, 0.5] });
  try {
    new Uint32Array(overlay.output.data)[0] = 1;
    h.frame();
    await new Promise((resolve) => setImmediate(resolve));
    h.frame();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(label.onScreen, false);
    let finish;
    overlay.read.mapAsync = () =>
      new Promise((resolve) => {
        finish = () => {
          overlay.read.mapState = 'mapped';
          resolve();
        };
      });
    h.frame();
    await Promise.resolve();
    label.position[0] = 0.5;
    h.frame();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    h.frame();
    assert.equal(label.onScreen, true, 'A moving anchor must not retain its previous hidden result');
    await Promise.resolve();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    overlay.dispose();
    dom.window.close();
  }
});

test('HTML fade follows the covered share of the depth grid, steps by duration and hides at 0', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  for (const fade of [{ samples: 1 }, { samples: 9 }, { samples: 2.5 }, { radius: -1 }, { duration: 11 }, 'x', null])
    assert.throws(() => new HTML({ fade }), /fade options/, JSON.stringify(fade));
  const overlay = new HTML({ capacity: 2, fade: { samples: 4, radius: 8, duration: 0.2 } });
  h.engine.use(overlay);
  const label = overlay.add(dom.window.document.createElement('span'), { position: [0, 0, 0.5] });
  const frame = async () => {
    h.frame();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const code = h.pipelines.at(-1).compute.module.code;
    assert.match(code, /j<4u/, 'The fade shader takes a 4 x 4 grid');
    const radius = h.resources.find((r) => r.size === 16 && r.usage & GPUBufferUsage.UNIFORM);
    const covered = new Uint32Array(overlay.output.data);
    covered[0] = 8;
    await frame();
    assert.deepEqual([...new Float32Array(radius.data)], [8, 8, 0, 0], 'Radius in drawing-buffer pixels');
    assert.equal(label.element.style.opacity, '', 'Opacity 1 before any result');
    await frame();
    assert.equal(label.element.style.opacity, '0.5', 'Half the grid covered: one 0.1 s frame of a 0.2 s fade');
    covered[0] = 16;
    await frame();
    assert.equal(label.element.style.opacity, '0.5', 'Results arrive a frame late');
    await frame();
    assert.equal(label.onScreen, false, 'Fully covered: hidden once the opacity reaches 0');
    assert.equal(label.element.style.display, 'none');
    covered[0] = 4;
    await frame();
    assert.equal(label.onScreen, false, 'Still hidden while the clearer result is read');
    await frame();
    assert.equal(label.onScreen, true);
    assert.equal(label.element.style.opacity, '0.5', 'Rising toward 0.75 by 0.5 a frame');
    await frame();
    assert.equal(label.element.style.opacity, '0.75');
    covered[0] = 0;
    await frame();
    await frame();
    assert.equal(label.element.style.opacity, '', 'Fully clear writes opacity back to the stylesheet');
  } finally {
    overlay.dispose();
    dom.window.close();
  }
  await null;
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'Fade radius buffer destroyed with the rest',
  );
});

test('HTML fade with duration 0 follows each result and a stale result shows the anchor', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  h.engine.canvas = dom.window.document.querySelector('canvas');
  const overlay = new HTML({ capacity: 1, fade: { samples: 2, radius: 4, duration: 0 } });
  h.engine.use(overlay);
  const label = overlay.add(dom.window.document.createElement('span'), { position: [0, 0, 0.5] });
  const frame = async () => {
    h.frame();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    new Uint32Array(overlay.output.data)[0] = 3;
    await frame();
    await frame();
    assert.equal(label.element.style.opacity, '0.25');
    let finish;
    overlay.read.mapAsync = () =>
      new Promise((resolve) => {
        finish = () => {
          overlay.read.mapState = 'mapped';
          resolve();
        };
      });
    h.frame();
    await Promise.resolve();
    label.position[0] = 0.5;
    h.frame();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    h.frame();
    assert.equal(label.element.style.opacity, '', 'A result taken before the anchor moved away is not applied');
    finish();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    overlay.dispose();
    dom.window.close();
  }
});
