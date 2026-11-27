// PointsPlugin.pixelScale: an owner that sizes points in CSS pixels (sciviz) scales the pixel sizes as the cloud's
// uniform is written, so the drawn target gets target pixels while the material keeps the caller's values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointCloud, PointsPlugin, SpriteBatch } from '../dist/index.js';
import { SurfelPlugin } from '../dist/surfels.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function uniformOf(plugin, cloud, scale) {
  const writes = [];
  plugin['device'] = { queue: { writeBuffer: (_buffer, _offset, data) => writes.push(Float32Array.from(data)) } };
  const floats = new Float32Array(64),
    r = { floats, uints: new Uint32Array(floats.buffer), written: new Float32Array(64).fill(NaN), uniform: {} };
  plugin['writeCloudUniform'](cloud, r, new Float32Array(16), false, scale);
  assert.equal(writes.length, 1);
  return writes[0];
}

test('pixel sizes and pixel clamps follow the pixel scale; the material keeps its values', () => {
  const plugin = new PointsPlugin(),
    cloud = new PointCloud({
      positions: new Float32Array(3),
      material: { size: 10, minPixelSize: 2, maxPixelSize: 64 },
    });
  assert.deepEqual([...uniformOf(plugin, cloud, 1).subarray(20, 23)], [10, 2, 64]);
  assert.deepEqual([...uniformOf(plugin, cloud, 2).subarray(20, 23)], [20, 4, 128]);
  assert.deepEqual([cloud.material.size, cloud.material.minPixelSize, cloud.material.maxPixelSize], [10, 2, 64]);
});

test('world sizes are not pixels: only their pixel clamps scale', () => {
  const plugin = new PointsPlugin(),
    cloud = new PointCloud({
      positions: new Float32Array(3),
      material: { size: 0.5, sizeUnits: 'world', minPixelSize: 1, maxPixelSize: 32 },
    });
  assert.deepEqual([...uniformOf(plugin, cloud, 2).subarray(20, 23)], [0.5, 2, 64]);
});

test('adaptiveSize: a thinned cloud grows its size and both clamps by the lost spacing, up to the material limit', () => {
  const plugin = new PointsPlugin(),
    cloud = new PointCloud({
      positions: new Float32Array(3),
      material: { size: 4, minPixelSize: 1, maxPixelSize: 64, adaptiveSize: 3 },
    });
  const grown = (grow) => {
    const writes = [];
    plugin['device'] = { queue: { writeBuffer: (_b, _o, data) => writes.push(Float32Array.from(data)) } };
    const floats = new Float32Array(64),
      r = { floats, uints: new Uint32Array(floats.buffer), written: new Float32Array(64).fill(NaN), uniform: {} };
    plugin['writeCloudUniform'](cloud, r, new Float32Array(16), false, 1, grow);
    return [...writes[0].subarray(20, 23)];
  };
  assert.deepEqual(grown(1), [4, 1, 64]);
  assert.deepEqual(grown(2), [8, 2, 128]);
  assert.throws(() => cloud.material.set({ adaptiveSize: -1 }), RangeError);
});

// One frame of `plugin` into a target `width` wide on a canvas `css` CSS pixels wide (KB-POINTS-CSSPX1); returns every
// buffer write, read as floats.
function frameUniforms(plugin, add, { width, css }) {
  const gpu = mockGPU(),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    canvas = css === undefined ? { width, height: width } : { width, height: width, clientWidth: css };
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device, canvas, sceneOf() {} }));
  add(plugin);
  const view = gpu.device.createTexture({ size: [width, width], format: 'rgba8unorm' }).createView(),
    run = passes(plugin),
    log = gpu.record(() =>
      run({
        backend: 'webgpu',
        device: gpu.device,
        encoder: gpu.encoder,
        camera,
        width,
        height: width,
        format: 'rgba8unorm',
        color: view,
        depth: view,
        descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
      }),
    );
  return log
    .filter((e) => e[0] === 'writeBuffer')
    .map((e) => new Float32Array(Uint8Array.from(Buffer.from(e[3], 'hex')).buffer));
}
const cloud = (material) => new PointCloud({ positions: new Float32Array(3), material });
const has = (writes, from, values) => writes.some((f) => values.every((v, i) => f[from + i] === v));

for (const [label, Plugin] of Object.entries({ PointsPlugin, SurfelPlugin }))
  test(`${label}: pixel sizes and clamps are CSS pixels of the canvas`, () => {
    const material = { size: 7, minPixelSize: 3, maxPixelSize: 33 };
    for (const [css, scale] of [
      [32, 2],
      [64, 1],
      [128, 0.5],
      [undefined, 1],
      [0, 1],
    ]) {
      const writes = frameUniforms(new Plugin(), (p) => p.add(cloud(material)), { width: 64, css });
      assert.ok(has(writes, 20, [7 * scale, 3 * scale, 33 * scale]), `canvas ${css} CSS pixels wide`);
    }
    const world = frameUniforms(new Plugin(), (p) => p.add(cloud({ ...material, size: 0.25, sizeUnits: 'world' })), {
      width: 64,
      css: 32,
    });
    assert.ok(has(world, 20, [0.25, 6, 66]), 'a world size keeps its units; its pixel clamps are CSS pixels');
  });

test('an owner pixelScale replaces the canvas ratio', () => {
  const plugin = new PointsPlugin();
  plugin.pixelScale = () => 3;
  const writes = frameUniforms(plugin, (p) => p.add(cloud({ size: 7, minPixelSize: 3, maxPixelSize: 33 })), {
    width: 64,
    css: 32,
  });
  assert.ok(has(writes, 20, [21, 9, 99]));
});

test('pixel sprites carry the target pixels per CSS pixel; world sprites carry 0', () => {
  for (const [sizeUnits, expected] of [
    ['pixels', 2],
    ['world', 0],
  ]) {
    const batch = new SpriteBatch({ material: { sizeUnits, rotation: 0.25, alphaTest: 0.5 }, sprites: [{}] });
    const writes = frameUniforms(new PointsPlugin(), (p) => p.add(batch), { width: 64, css: 32 });
    assert.ok(has(writes, 20, [0.25, 0.5, expected]), sizeUnits);
  }
});
