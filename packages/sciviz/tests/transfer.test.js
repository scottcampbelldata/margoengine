import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { JSDOM } from 'jsdom';
import {
  TransferFunction,
  transferPreset,
  transferHistogram,
  preintegrateTransfer,
  bindTransfer,
  transferEditor,
} from '../dist/transfer.js';
import { VolumeLayer } from '../dist/index.js';

test('an initial render callback can abort its transfer binding without leaving classification or listeners', () => {
  const previous = { kind: 'gradient', size: [1, 1], rgba: new Uint8Array([10, 20, 30, 40]), gradientMax: 2 };
  let current = previous;
  let uploads = 0;
  const layer = {
    valid: true,
    range: [0, 1],
    getClassification: () => previous,
    setClassification(value) {
      uploads++;
      current = value;
    },
  };
  const controller = new AbortController();
  const tf = transferPreset('mri');
  const binding = bindTransfer(layer, tf, { signal: controller.signal, render: () => controller.abort() });
  assert.equal(current === previous, true, 'initial abort restores the owned previous classifier');
  assert.equal(uploads, 2);
  assert.equal(getEventListeners(tf, 'change').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  tf.update(tf.state);
  binding.dispose();
  assert.equal(uploads, 2);
});

test('a failed initial render restores classification and releases transfer listeners', () => {
  const failure = new Error('render failed');
  const controller = new AbortController();
  const tf = transferPreset('mri');
  let current;
  let uploads = 0;
  const layer = {
    valid: true,
    range: [0, 1],
    getClassification: () => undefined,
    setClassification(value) {
      uploads++;
      current = value;
    },
  };
  assert.throws(
    () =>
      bindTransfer(layer, tf, {
        signal: controller.signal,
        render: () => {
          throw failure;
        },
      }),
    (error) => error === failure,
  );
  assert.equal(current === undefined, true, 'failed initialization restores the absent classifier');
  assert.equal(uploads, 2);
  assert.equal(getEventListeners(tf, 'change').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  tf.update(tf.state);
  assert.equal(uploads, 2);
});

test('transfer setup preserves both callback and restoration errors while releasing listeners', () => {
  const failure = new Error('render failed'),
    rollback = new Error('restoration failed');
  const controller = new AbortController();
  const tf = transferPreset('mri');
  let uploads = 0;
  const layer = {
    valid: true,
    range: [0, 1],
    getClassification: () => undefined,
    setClassification() {
      if (++uploads === 2) throw rollback;
    },
  };
  assert.throws(
    () =>
      bindTransfer(layer, tf, {
        signal: controller.signal,
        render: () => {
          throw failure;
        },
      }),
    (error) => {
      assert.equal(error.code, 'failed');
      assert.deepEqual(error.errors, [failure, rollback]);
      return true;
    },
  );
  assert.equal(getEventListeners(tf, 'change').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('scalar texture retains out-of-range derivatives and disposed volumes cannot accept edits', () => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  const uploads = [],
    resources = [];
  const resource = () => {
    const r = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      createView() {
        return {};
      },
    };
    resources.push(r);
    return r;
  };
  const renderer = {
    device: {
      limits: { maxTextureDimension3D: 2048, maxTextureDimension2D: 4096 },
      createTexture: resource,
      createBuffer: resource,
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      createSampler: () => ({}),
      queue: {
        writeTexture(_target, data) {
          uploads.push(data.slice());
        },
        writeBuffer() {},
      },
    },
    remove() {},
    add() {},
  };
  const layer = new VolumeLayer(renderer, new Float32Array([-1, 0, 1, 2, -1, 0, 1, 2]), {
    dims: [2, 2, 2],
    range: [0, 1],
  });
  assert.equal(uploads[0][0], 0xbc00);
  assert.equal(uploads[0][3], 0x4000);
  const tf = transferPreset('mri');
  const table = tf.table(16);
  layer.setClassification(table);
  const original = table.rgba[3];
  table.rgba.fill(0);
  layer.restore();
  assert.equal(uploads.at(-1)[3], original);
  const binding = bindTransfer(layer, tf, { resolution: 16 });
  layer.dispose();
  assert.equal(layer.valid, false);
  binding.dispose();
  assert.throws(() => layer.setClassification(table));
});

const state = {
  range: [0, 1],
  gradientMax: 4,
  points: [
    { value: 0, rgba: [1, 0, 0, 0.2] },
    { value: 1, rgba: [0, 0, 1, 0.2] },
  ],
};
test('physical classification, atomic state snapshots and rectangle/triangle/Gaussian widgets', () => {
  const tf = new TransferFunction(state);
  state.points[0].rgba[0] = 0.7;
  assert.deepEqual(tf.evaluate(0.5), [0.5, 0, 0.5, 0.2]);
  const saved = tf.state;
  saved.points[0].rgba[0] = 0;
  assert.equal(tf.evaluate(0)[0], 1);
  let events = 0;
  tf.addEventListener('change', () => events++);
  assert.throws(() => tf.update({ ...tf.state, gradientMax: 0 }));
  assert.equal(events, 0);
  const rgba = [1, 0.5, 0, 0.6];
  tf.update({ ...tf.state, mode: '2d', widgets: [{ kind: 'rectangle', bounds: [0.2, 0.8, 1, 3], rgba }] });
  assert.deepEqual(tf.evaluate(0.5, 2), rgba);
  assert.deepEqual(tf.evaluate(0.5, 0), [0, 0, 0, 0]);
  tf.update({
    ...tf.state,
    widgets: [
      {
        kind: 'triangle',
        vertices: [
          [0, 0],
          [1, 0],
          [0.5, 3],
        ],
        rgba,
      },
    ],
  });
  assert.ok(Math.abs(tf.evaluate(0.5, 1)[3] - 0.6) < 1e-14);
  assert.equal(tf.evaluate(0.1, 2)[3], 0);
  assert.equal(tf.evaluate(0, 0)[3], 0);
  tf.update({ ...tf.state, widgets: [{ kind: 'gaussian', center: [0.5, 2], sigma: [0.1, 0.5], rgba }] });
  assert.ok(Math.abs(tf.evaluate(0.6, 2)[3] - 0.6 * Math.exp(-0.5)) < 1e-14);
  assert.equal(tf.table(32).rgba.length, 32 * 32 * 4);
  assert.throws(() =>
    tf.update({
      ...tf.state,
      widgets: [
        {
          kind: 'triangle',
          vertices: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          rgba,
        },
      ],
    }),
  );
});
test('histogram uses anisotropic physical derivatives, boundaries, descending axes, missing data and exact abort', async () => {
  const dims = [4, 3, 2],
    data = [];
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) data.push(2 * x * 2 + 3 * y * 4 + 6 * z * 3);
  const h = await transferHistogram(data, { dims, bounds: [0, 6, 0, 8, 0, 3], range: [0, 54], resolution: 8 });
  assert.equal(h.valid, 24);
  assert.equal(h.gradientMax, 7);
  assert.equal(
    h.counts.reduce((a, b) => a + b),
    24,
  );
  assert.equal(
    h.counts.slice(0, 56).reduce((a, b) => a + b),
    0,
  );
  const reverse = await transferHistogram(data, { dims, bounds: [6, 0, 8, 0, 3, 0], range: [0, 54], resolution: 8 });
  assert.deepEqual(reverse.counts, h.counts);
  data[5] = NaN;
  const missing = await transferHistogram(data, { dims, range: [0, 54] });
  assert.ok(missing.missing > 1);
  assert.equal(missing.valid + missing.missing, 24);
  const reason = new Error('caller cancellation');
  await assert.rejects(
    transferHistogram(data, { dims, range: [0, 54], signal: AbortSignal.abort(reason) }),
    (e) => e === reason,
  );
  const controller = new AbortController();
  const promise = transferHistogram(new Float32Array(100 ** 3), {
    dims: [100, 100, 100],
    range: [0, 1],
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(promise, (e) => e === reason);
});
test('preintegration matches constant optical depth and ordered independent high-resolution quadrature', async () => {
  const tf = new TransferFunction({
    ...state,
    points: [
      { value: 0, rgba: [1, 0, 0, 0.2] },
      { value: 1, rgba: [0, 0, 1, 0.2] },
    ],
  });
  const table = await preintegrateTransfer(tf, { resolution: 8, samples: 256, step: 2, density: 0.7 });
  const alpha = 1 - Math.pow(0.8, 1.4);
  assert.ok(Math.abs(table.rgba[3] / 255 - alpha) <= 1 / 510);
  // Analytic integral for linear colour and constant extinction along v(t)=t.
  const k = -Math.log(0.8) * 1.4,
    blue = (1 - (1 + k) * Math.exp(-k)) / k,
    red = alpha - blue;
  const i = 7 * 8 * 4;
  assert.ok(Math.abs(table.rgba[i] / 255 - red / alpha) < 0.0021);
  assert.ok(Math.abs(table.rgba[i + 2] / 255 - blue / alpha) < 0.0021);
  assert.notEqual(table.rgba[i], table.rgba[7 * 4]);
  const reason = 'cancel';
  await assert.rejects(preintegrateTransfer(tf, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  tf.update({ ...tf.state, mode: '2d' });
  await assert.rejects(preintegrateTransfer(tf));
});
test('binding updates any existing volume and lifetime removes listener, editor changes real model', () => {
  let last,
    uploads = 0;
  const layer = {
      range: [0, 1],
      valid: true,
      getClassification() {
        return undefined;
      },
      setClassification(v) {
        last = v;
        uploads++;
      },
    },
    tf = transferPreset('mri');
  const binding = bindTransfer(layer, tf, { resolution: 16 });
  assert.equal(uploads, 1);
  tf.update({ ...tf.state, mode: '2d' });
  assert.equal(uploads, 2);
  binding.dispose();
  assert.equal(last, undefined);
  binding.dispose();
  tf.update(tf.state);
  assert.equal(uploads, 3);
  const dom = new JSDOM('<main></main>');
  // jsdom has no raster backend. Test DOM editing separately from the real browser pixel test.
  dom.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
  const editor = transferEditor(dom.window.document.querySelector('main'), tf);
  const mode = editor.element.querySelector('select');
  mode.value = '1d';
  mode.dispatchEvent(new dom.window.Event('change'));
  const opacity = editor.element.querySelector('[aria-label="opacity"]');
  opacity.value = '0.4';
  opacity.dispatchEvent(new dom.window.Event('change'));
  assert.equal(tf.state.points[0].rgba[3], 0.4);
  editor.dispose();
  editor.dispose();
  assert.equal(dom.window.document.querySelector('main').children.length, 0);
  dom.window.close();
});

test('binding disposal and abort restore owned gradient and preintegrated classification snapshots', () => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  const resource = () => ({
    destroy() {},
    createView() {
      return {};
    },
  });
  const renderer = {
    device: {
      limits: { maxTextureDimension3D: 2048, maxTextureDimension2D: 4096 },
      createTexture: resource,
      createBuffer: resource,
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      createSampler: () => ({}),
      queue: { writeTexture() {}, writeBuffer() {} },
    },
    remove() {},
    add() {},
  };
  for (const kind of ['gradient', 'preintegrated']) {
    for (const abort of [false, true]) {
      const layer = new VolumeLayer(renderer, new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]), {
        dims: [2, 2, 2],
        range: [0, 1],
      });
      assert.equal(layer.getClassification(), undefined);
      const original = {
        kind,
        size: [2, 2],
        rgba: Uint8Array.from({ length: 16 }, (_, i) => i * 10),
        gradientMax: 3,
        step: 2,
        density: 0.75,
      };
      layer.setClassification(original);
      const expected = structuredClone(original),
        snapshot = layer.getClassification();
      assert.deepEqual(snapshot, expected);
      original.rgba.fill(0);
      original.size[0] = 8;
      snapshot.rgba.fill(255);
      snapshot.size[1] = 8;
      snapshot.density = 5;
      assert.deepEqual(layer.getClassification(), expected);
      const metadata = [...layer.classificationUniforms()],
        data = layer.classificationData();
      const controller = new AbortController(),
        tf = transferPreset('mri');
      const binding = bindTransfer(layer, tf, { resolution: 16, signal: controller.signal });
      tf.update({ ...tf.state, mode: '2d' });
      if (abort) controller.abort();
      else binding[Symbol.dispose]();
      binding.dispose();
      tf.update(tf.state);
      assert.deepEqual(layer.getClassification(), expected);
      assert.deepEqual(layer.classificationUniforms(), metadata);
      assert.deepEqual(layer.classificationData(), data);
      layer.restore();
      assert.deepEqual(layer.getClassification(), expected);
      layer.dispose();
    }
  }
});
