import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointCloud, PointsMaterial, PointsPlugin, SpriteBatch, SpriteMaterial } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
};
const image = (width, height) => new ImageData(new Uint8ClampedArray(width * height * 4), width, height);

function rig() {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device }));
  const run = passes(plugin),
    frame = () =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      );
  return { plugin, frame, gpu };
}
const owned = (plugin, material) => plugin['owned'].get(material).texture;

test('points default to mips, sprites do not, and the flag is checked', () => {
  assert.equal(new PointsMaterial().mipmaps, true);
  assert.equal(new SpriteMaterial().mipmaps, false);
  assert.equal(new SpriteMaterial({ mipmaps: true }).mipmaps, true);
  assert.equal(new PointsMaterial({ mipmaps: false }).mipmaps, false);
  assert.throws(() => new PointsMaterial({ mipmaps: 1 }), TypeError);
});

test('an uploaded map gets a full chain, an odd size included; off, one level', () => {
  const { plugin, frame } = rig(),
    a = plugin.add(new PointCloud({ positions: [0, 0, 0], material: { map: image(32, 16) } })),
    b = plugin.add(new PointCloud({ positions: [0, 1, 0], material: { map: image(100, 3) } })),
    c = plugin.add(new PointCloud({ positions: [1, 0, 0], material: { map: image(32, 32), mipmaps: false } })),
    d = plugin.add(new SpriteBatch({ material: { map: image(32, 32) }, sprites: [{ position: [0, 0, 0] }] }));
  frame();
  const levels = (item) => owned(plugin, item.material).mipLevelCount ?? 1;
  assert.equal(levels(a), 6);
  assert.equal(levels(b), 7);
  assert.equal(levels(c), 1);
  assert.equal(levels(d), 1);
});

test('turning mips on uploads the map again; a repeat frame does not', () => {
  const { plugin, frame } = rig(),
    cloud = plugin.add(new PointCloud({ positions: [0, 0, 0], material: { map: image(8, 8), mipmaps: false } }));
  frame();
  const first = owned(plugin, cloud.material);
  frame();
  assert.equal(owned(plugin, cloud.material), first);
  cloud.material.mipmaps = true;
  frame();
  assert.notEqual(owned(plugin, cloud.material), first);
  assert.equal(owned(plugin, cloud.material).mipLevelCount, 4);
});

test('the shaders pick a level, and the linear sampler can reach it', () => {
  const { plugin, gpu } = rig();
  const log = gpu.record(() => plugin.onDeviceRestored({ backend: 'webgpu', gpu: gpu.device })),
    code = log.filter((e) => e[0] === 'module').map((e) => e[2].code);
  assert.match(code[0], /max\(log2\(max\(dims\.x,dims\.y\)\/\(2\.0\*r\)\),0\.0\)/);
  assert.match(code[1], /dpdx\(i\.uv\)\*dims/);
});

// Bug sweep L3a (Firefox d): Firefox 157's copyExternalImageToTexture takes no video or VideoFrame (a TypeError), so a
// points map from a video threw. The frame now goes through a canvas, chosen once per queue.
test('a video map a browser refuses as the copy source (Firefox) uploads through a canvas', () => {
  const { plugin, frame, gpu } = rig(),
    drawn = [],
    copied = [],
    Original = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height, canvas: true });
    }
    getContext() {
      return { drawImage: (source) => drawn.push(source) };
    }
  };
  try {
    let refused = 0;
    gpu.device.queue.copyExternalImageToTexture = (info, destination, size) => {
      if ('videoWidth' in info.source) {
        refused++;
        throw new TypeError("'source' member of GPUCopyExternalImageSourceInfo could not be converted");
      }
      copied.push([info.source, size]);
    };
    const video = { videoWidth: 16, videoHeight: 8 },
      cloud = plugin.add(new PointCloud({ positions: [0, 0, 0], material: { map: video } }));
    frame();
    assert.equal(refused, 1);
    assert.equal(copied.length, 1);
    assert.equal(copied[0][0].canvas, true);
    assert.deepEqual([copied[0][0].width, copied[0][0].height, copied[0][1]], [16, 8, [16, 8]]);
    assert.deepEqual(drawn, [video]);
    assert.ok(owned(plugin, cloud.material), 'the map has its texture');
  } finally {
    globalThis.OffscreenCanvas = Original;
  }
});
