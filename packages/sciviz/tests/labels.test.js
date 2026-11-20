import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { FusionLayer, labelLegend, fusionVolume } from '../dist/labels.js';

function fixture() {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  const uploads = [],
    resources = [],
    members = new Set();
  const resource = (descriptor) => {
    const r = {
      descriptor,
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
        writeTexture(target, data) {
          uploads.push({ format: target.texture.descriptor.format, bytes: data.slice() });
        },
        writeBuffer() {},
      },
    },
    add: (x) => members.add(x),
    remove: (x) => members.delete(x),
  };
  return { renderer, uploads, resources, members };
}
const labels = [
  { id: 16777217, name: '<b>Exact ID</b>', rgba: [1, 0, 0, 0.2], outline: { rgba: [0, 1, 0, 1], width: 2 } },
  { id: 0xffffffff, rgba: [0, 0, 1, 1] },
];
const input = () => ({
  kind: 'labels',
  data: new Uint32Array([16777217, 16777218, 0xffffffff, 0, 16777217, 16777218, 0xffffffff, 0]),
  labels,
  dims: [2, 2, 2],
});

test('category packing preserves exact uint32 distinctions, unknown boundaries and restoration snapshots', () => {
  const { renderer, uploads, resources } = fixture(),
    s = input(),
    layer = new FusionLayer(renderer, [s]);
  const packed = uploads[0].bytes;
  assert.notEqual(packed[0], packed[1]);
  assert.equal(packed[0], 1);
  assert.equal(packed[2], 2);
  s.data.fill(0);
  s.dims[0] = 10;
  layer.restore();
  assert.deepEqual(uploads.at(-2).bytes, packed);
  assert.ok(resources.slice(0, 3).every((r) => r.destroyed));
  const old = uploads.at(-2).bytes.slice();
  assert.throws(() => layer.setLabels(0, [{ id: 1, rgba: [0, 0, 0, 2] }]), /RGBA/);
  layer.restore();
  assert.deepEqual(uploads.at(-2).bytes, old);
  layer.setLabels(0, [{ id: 16777218, rgba: [0, 1, 0, 1] }]);
  assert.equal(uploads.at(-2).bytes[1], 1);
  assert.notEqual(uploads.at(-2).bytes[0], 1);
  assert.deepEqual(
    layer.labels().map((l) => l.id),
    [16777218],
  );
  layer.dispose();
  layer.dispose();
  assert.ok(resources.every((r) => r.destroyed));
  assert.throws(() => layer.setLabels(0, labels), /disposed/);
});
test('registered union uses every transformed corner and legend treats names as text', () => {
  const { renderer } = fixture(),
    transform = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 7, 8, 9, 1];
  const layer = new FusionLayer(renderer, [{ ...input(), transform }]);
  assert.deepEqual(layer.bounds, [4, 7, 8, 10, 9, 13]);
  const dom = new JSDOM('<div><p>Keep me</p></div>'),
    host = dom.window.document.querySelector('div'),
    legend = labelLegend(host, layer);
  assert.equal(host.querySelector('b'), null);
  assert.match(host.textContent, /<b>Exact ID<\/b>/);
  layer.setLabels(0, [{ id: 1, name: 'Edited', rgba: [1, 1, 0, 0] }]);
  legend.update();
  assert.match(host.textContent, /Edited/);
  assert.doesNotMatch(host.textContent, /Exact ID/);
  legend[Symbol.dispose]();
  assert.equal(host.children.length, 1);
  layer.dispose();
  dom.window.close();
});
test('invalid arrays, transforms, functions and dimensions reject before publishing GPU resources', () => {
  const { renderer, members, resources } = fixture();
  for (const s of [
    { ...input(), data: [0.5, ...Array(7).fill(0)] },
    { ...input(), data: [0x100000000, ...Array(7).fill(0)] },
    { ...input(), labels: [labels[0], labels[0]] },
    { ...input(), dims: [2, 2, 1] },
    { ...input(), transform: Array(16).fill(0) },
    { ...input(), bounds: [1, 0, 0, 1, 0, 1] },
    { kind: 'rgb', dims: [2, 2, 2], data: Array(24).fill(2) },
    {
      kind: 'components',
      dims: [2, 2, 2],
      data: Array(8).fill(0),
      components: [{ range: [0, 1], transfer: () => [0, 0, 0, NaN] }],
    },
  ])
    assert.throws(() => new FusionLayer(renderer, [s]));
  assert.equal(resources.length, 0);
  assert.throws(() => new FusionLayer(renderer, []));
  assert.throws(
    () =>
      fusionVolume(
        {
          renderer,
          addLayer() {
            throw new Error('2D');
          },
        },
        [input()],
      ),
    /2D/,
  );
  assert.equal(members.size, 0);
  assert.ok(resources.every((r) => r.destroyed));
});

// Optical and over mixing in float32 at the edge alphas, as the fusion shader computes them (a JS mirror rounding every
// operation to float32; the shader text below is checked to be the same formulas). WGSL 15.7.5 lets log err by 2^-21
// absolute on [0.5, 2], and lets subnormals flush to zero.
test('fusion mixing stays finite and convex for alphas near 0 and 1 under WGSL log error', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const dist = new URL('../dist/', import.meta.url),
    sources = await Promise.all(
      (await readdir(dist)).filter((f) => f.endsWith('.js')).map((f) => readFile(new URL(f, dist), 'utf8')),
    ),
    shader = sources.find((s) => s.includes('fn mixSample('));
  assert.ok(shader, 'the fusion shader is in the built entry');
  for (const piece of [
    'if (a < 0.0625) { return a * (1.0 + a * (0.5 + a * (0.33333334 + a * (0.25 + a * (0.2 + a * (0.16666667 + a * 0.14285715)))))); }',
    'return -log(1.0 - a);',
    'if (a.a < 1.17549435e-38) { return b; } if (b.a < 1.17549435e-38) { return a; }',
    'let alpha = a.a + b.a * (1.0 - a.a);',
    'return vec4f((a.rgb * a.a + b.rgb * (b.a * (1.0 - a.a))) / alpha, alpha);',
    'select(select(0.0, 1.0, a.a >= 1.0), 0.5, a.a >= 1.0 && b.a >= 1.0)',
    'return vec4f((a.rgb * ta + b.rgb * tb) / (ta + tb), alpha);',
  ])
    assert.ok(shader.includes(piece), `fusion shader has ${piece}`);
  const f = Math.fround,
    add = (x, y) => f(x + y),
    mul = (x, y) => f(x * y),
    sub = (x, y) => f(x - y),
    div = (x, y) => f(x / y),
    // log of x with an absolute error e, as WGSL allows on [0.5, 2].
    log = (x, e) => f(Math.log(x) + (x >= 0.5 && x <= 2 ? e : 0));
  const depth = (a, e) => {
    if (a < 0.0625) {
      let s = f(0.14285715);
      for (const c of [0.16666667, 0.2, 0.25, 0.33333334, 0.5, 1]) s = add(f(c), mul(a, s));
      return mul(a, s);
    }
    return f(-log(sub(1, a), e));
  };
  // Optical mix of two samples with colours 1 and 0 in one channel: the returned channel is the weight of `a`.
  const optical = (a, b, e) => {
    if (a < 2 ** -126) return [0, b];
    if (b < 2 ** -126) return [1, a];
    const alpha = add(a, mul(b, sub(1, a)));
    if (a >= 1 || b >= 1) return [a >= 1 && b >= 1 ? 0.5 : a >= 1 ? 1 : 0, 1];
    const ta = depth(a, e),
      tb = depth(b, e);
    return [div(ta, add(ta, tb)), alpha];
  };
  const over = (a, b) => {
    const alpha = add(a, mul(b, sub(1, a)));
    return [div(mul(1, a), alpha), alpha];
  };
  // The old forms: 1 - (1 - a)(1 - b) and -log(max(1e-7, 1 - a)) give 0 / 0 and a / 0 for two alphas of 2^-26 even
  // with an exact log.
  const oldAlpha = (a, b) => sub(1, mul(sub(1, a), sub(1, b))),
    oldDepth = (a, e) => f(-log(Math.max(f(1e-7), sub(1, a)), e));
  const tiny = f(2 ** -26);
  assert.ok(Number.isNaN(div(oldDepth(tiny, 0), add(oldDepth(tiny, 0), oldDepth(tiny, 0)))), 'old optical weight');
  assert.equal(div(mul(1, tiny), oldAlpha(tiny, tiny)), Infinity, 'old over colour');
  // With log 2^-21 high for one sample and low for the other, the old weights leave [0, 1].
  const skew = div(oldDepth(f(3e-7), 2 ** -21), add(oldDepth(f(3e-7), 2 ** -21), oldDepth(f(3e-7), -(2 ** -21))));
  assert.ok(!(skew >= 0 && skew <= 1), `old weight ${skew}`);
  const edges = [
    2 ** -149,
    2 ** -127,
    2 ** -126,
    2 ** -60,
    2 ** -26,
    2 ** -25,
    6e-8,
    1e-7,
    5e-7,
    1e-6,
    1e-3,
    0.0625 - 2 ** -28,
    0.0625,
    0.25,
    0.5,
    0.999,
    1 - 2 ** -24,
    1,
  ].map(f);
  for (const a of edges)
    for (const b of edges)
      for (const e of [-(2 ** -21), 0, 2 ** -21]) {
        const [w, alpha] = optical(a, b, e),
          [v, overAlpha] = a < 2 ** -126 || b < 2 ** -126 ? [1, 1] : over(a, b);
        const where = `a ${a}, b ${b}, log error ${e}`;
        assert.ok(w >= 0 && w <= 1, `optical weight ${w} at ${where}`);
        // A subnormal alpha counts as 0.
        const normal = (x) => (x < 2 ** -126 ? 0 : x);
        assert.ok(alpha >= Math.max(normal(a), normal(b)) * (1 - 2 ** -23) && alpha <= 1, `optical alpha ${alpha} at ${where}`);
        assert.ok(v >= 0 && v <= 1 && overAlpha <= 1, `over colour ${v} at ${where}`);
        // Normal alphas below 1/16 take the series: their weight is the exact optical depth ratio to float32 accuracy.
        if (a >= 2 ** -126 && b >= 2 ** -126 && a < 0.0625 && b < 0.0625) {
          const exact = Math.log1p(-a) / (Math.log1p(-a) + Math.log1p(-b));
          assert.ok(Math.abs(w - exact) <= 4e-7, `optical weight ${w} vs ${exact} at ${where}`);
        }
      }
  // Exact limits: an alpha that is zero under flushing leaves the other sample; opaque samples win, two split evenly.
  assert.deepEqual(optical(f(1e-40), 0.5, 0), [0, 0.5]);
  assert.deepEqual(optical(1, 0.5, 0), [1, 1]);
  assert.deepEqual(optical(0.5, 1, 0), [0, 1]);
  assert.deepEqual(optical(1, 1, 0), [0.5, 1]);
});
