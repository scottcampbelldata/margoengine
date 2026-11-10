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
