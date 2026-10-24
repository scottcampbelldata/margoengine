import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointsPlugin, PointCloud, SpriteBatch, PointsMaterial } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const floats = (hex) => new Float32Array(new Uint8Array(Buffer.from(hex, 'hex')).buffer);
const fogWrites = (log) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 96).map((e) => floats(e[3]));
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const groupTwo = (log) => log.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 2).length;

function rig() {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    camera = new Camera({ position: [0, 1, 8], target: [0, 1, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  const setup = gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device }));
  const cloud = plugin.add(new PointCloud({ positions: [0, 0, 0, 1, 1, 0], material: { size: 4 } })),
    batch = plugin.add(new SpriteBatch({ material: { blending: 'additive' }, sprites: [{ position: [0, 1, 0] }] })),
    run = passes(plugin),
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
  return { plugin, cloud, batch, frame, setup };
}

test('PointsPlugin.setFog fogs points at their centre and sprites per pixel; additive sprites fade to nothing', () => {
  const r = rig(),
    [plainPoint, plainSprite] = modules(r.setup);
  assert.doesNotMatch(plainPoint + plainSprite, /margoFog|fogAmount/);
  const unfogged = r.frame();
  assert.deepEqual(modules(unfogged), []);
  assert.deepEqual(fogWrites(unfogged), []);
  assert.equal(groupTwo(unfogged), 0);

  const fog = { color: [0.2, 0.4, 0.6], density: 0.05 };
  r.plugin.setFog(fog);
  const fogged = r.frame(),
    [point, sprite] = modules(fogged);
  assert.match(point, /out\.fog=fogAmount\(world\.xyz\);/, 'one fog value per point, from its centre');
  assert.match(point, /s\.color=encode\(fogged\(color,i\.fog\)\);/, 'mixed in linear before the encode');
  assert.match(
    point,
    /return vec4f\(mix\(c\.rgb,margoFog\.color\.rgb,a\),c\.a\);/,
    "'normal' fades toward the fog colour",
  );
  assert.match(sprite, /return encode\(fogged\(color,fogAmount\(i\.world\)\)\);/, 'sprites per pixel');
  assert.match(sprite, /return vec4f\(c\.rgb\*\(1\.0-a\),c\.a\);/, "'additive' fades toward adding nothing");
  assert.equal(groupTwo(fogged), 2, 'group 2 in the point and the sprite pass');
  assert.deepEqual([...fogWrites(fogged)[0]], [0.2, 0.4, 0.6, 0, 1, 1000, 0.05, 0, 0, 1, 8, 0].map(Math.fround));
  assert.deepEqual(modules(r.frame()), [], 'fogged shaders compile once');

  r.cloud.material.fog = false;
  r.batch.material.fog = false;
  const cleared = r.frame();
  assert.deepEqual(fogWrites(cleared), [], 'materials with fog false draw unfogged');
  assert.equal(groupTwo(cleared), 0);
  r.cloud.material.fog = true;
  r.plugin.setFog(null);
  assert.deepEqual(fogWrites(r.frame()), []);
  assert.equal(r.plugin.fog, null);
});

test('material fog flags and setFog validate their input', () => {
  assert.equal(new PointsMaterial().fog, true);
  assert.equal(new PointsMaterial({ fog: false }).fog, false);
  assert.throws(() => new PointsMaterial({ fog: 'no' }), TypeError);
  const plugin = new PointsPlugin();
  assert.throws(() => plugin.setFog(3), TypeError);
  assert.throws(() => plugin.setFog({ far: -1 }), /Fog far is -1/);
  assert.throws(() => plugin.setFog({ heightFalloff: -0.1 }), RangeError);
});

test('PointsPlugin.pick picks through the view under the point with that view camera and rectangle', () => {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    canvas = { width: 128, height: 64, clientWidth: 128, clientHeight: 64 },
    left = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    right = new Camera({ position: [3, 0, 8], target: [3, 0, 0] }),
    view = gpu.device.createTexture({ size: [128, 64], format: 'rgba8unorm' }).createView();
  for (const camera of [left, right]) camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device, canvas }));
  plugin.add(new PointCloud({ positions: [0, 0, 0, 3, 0, 0], material: { size: 4 } }));
  const run = passes(plugin),
    draw = (camera, viewport, index, id) =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          view: { id, camera, viewport, index, count: 2 },
          width: 128,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      );
  plugin.onPreUpdate(1 / 60);
  draw(left, [0, 0, 64, 64], 0, 'left');
  draw(right, [64, 0, 64, 64], 1, 'right');
  // Each camera looks straight at one point, which lands in the middle of its view.
  assert.equal(plugin.pick(32, 32)?.index, 0);
  assert.equal(plugin.pick(96, 32)?.index, 1);
  assert.equal(plugin.pick(96, 32, { view: 'left' }), null, 'outside the named view');
  assert.equal(plugin.pick(32, 32, { view: 'left' })?.index, 0);
  plugin.onPreUpdate(1 / 60);
  draw(left, [0, 0, 64, 64], 0, 'left');
  assert.equal(plugin.pick(96, 32)?.index, undefined, 'right was not drawn this frame');
  assert.equal(plugin.pick(96, 32, { view: 'right' })?.index, 1, 'but can still be named until pruned');
  plugin.onPreUpdate(1 / 60);
  assert.equal(plugin.pick(96, 32, { view: 'right' }), null, 'a view not drawn for a frame is dropped');
  assert.equal(plugin.pick(32, 32)?.index, undefined, 'and so is one not drawn since the last frame started');
});

test('PointsPlugin.pick uses each view its own level of detail and skips views drawn into a texture', () => {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    canvas = { width: 128, height: 64, clientWidth: 128, clientHeight: 64 },
    left = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    away = new Camera({ position: [0, 0, 8], target: [0, 0, 16] }),
    view = gpu.device.createTexture({ size: [128, 64], format: 'rgba8unorm' }).createView();
  for (const camera of [left, away]) camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device, canvas }));
  plugin.add(new PointCloud({ positions: [0, 0, 0], material: { size: 4 } }));
  const run = passes(plugin),
    draw = (camera, viewport, index, id, target) =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          view: { id, camera, viewport, index, count: 2, target },
          width: 128,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      );
  plugin.onPreUpdate(1 / 60);
  draw(left, [0, 0, 64, 64], 0, 'left');
  draw(away, [64, 0, 64, 64], 1, 'away');
  assert.equal(plugin.pick(32, 32)?.index, 0, 'the later view culling the cloud leaves the left view pickable');
  plugin.onPreUpdate(1 / 60);
  draw(left, [0, 0, 128, 64], 0, 'portal', { color: {} });
  assert.equal(plugin.pick(64, 32), null, 'a target view is not under the canvas pointer');
  assert.equal(plugin.pick(64, 32, { view: 'portal' })?.index, 0, 'but can be picked by id');
});
