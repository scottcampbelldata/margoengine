import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointsPlugin, PointCloud, SpriteBatch, PointsMaterial, SpriteMaterial } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const CLOUD_BYTES = 224,
  SPRITE_BYTES = 192;
const bytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex')).buffer;
const writes = (log, size) =>
  log.filter((e) => e[0] === 'writeBuffer' && e[3].length === size * 2).map((e) => bytes(e[3]));
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

function rig(cloudMaterial = {}, spriteMaterial = {}) {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    camera = new Camera({ position: [0, 1, 8], target: [0, 1, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  const setup = gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device }));
  const cloud = plugin.add(new PointCloud({ positions: [0, 0, 0, 1, 1, 0], material: { size: 4, ...cloudMaterial } })),
    batch = plugin.add(new SpriteBatch({ material: spriteMaterial, sprites: [{ position: [0, 1, 0] }] })),
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

test('point and sprite materials validate, normalise and copy clippingPlanes', () => {
  for (const Material of [PointsMaterial, SpriteMaterial]) {
    const m = new Material();
    assert.deepEqual(m.clippingPlanes, []);
    m.clippingPlanes = [[0, 0, 4, -8]];
    assert.deepEqual(m.clippingPlanes, [[0, 0, 1, -2]]);
    m.clippingPlanes[0][3] = 5;
    assert.equal(m.clippingPlanes[0][3], -2, 'the getter hands out copies');
    assert.deepEqual(new Material({ clippingPlanes: [[3, 4, 0, 5]] }).clippingPlanes, [[0.6, 0.8, 0, 1]]);
    assert.throws(() => (m.clippingPlanes = Array(7).fill([0, 1, 0, 0])), /holds at most 6 planes; pass fewer/);
    assert.throws(() => (m.clippingPlanes = Array(7).fill([0, 1, 0, 0])), RangeError);
    assert.throws(() => (m.clippingPlanes = null), TypeError);
    assert.throws(() => (m.clippingPlanes = [[0, 1, 0]]), /four finite numbers/);
    assert.throws(() => (m.clippingPlanes = [[0, 1, Infinity, 0]]), TypeError);
    assert.throws(() => (m.clippingPlanes = [[0, 0, 0, 2]]), /non-zero normal/);
    assert.deepEqual(m.clippingPlanes, [[0, 0, 1, -2]], 'a rejected list keeps the previous planes');
  }
  const cloud = new PointCloud({ positions: [0, 0, 0], material: { clippingPlanes: [[1, 0, 0, 0]] } });
  assert.deepEqual(cloud.material.clippingPlanes, [[1, 0, 0, 0]]);
});

test('point and sprite shaders carry world points and the discard loops', () => {
  const r = rig(),
    [point, sprite] = modules(r.setup);
  assert.match(point, /planes:array<vec4f,6>\}/);
  assert.match(point, /@location\(3\) @interpolate\(flat\) center:vec3f,/);
  assert.match(point, /out\.center=world\.xyz;/);
  assert.match(
    point,
    /let wp=i\.center\+\(frame\.right\.xyz\*i\.quad\.x\+frame\.up\.xyz\*i\.quad\.y\)\*\(i\.info\.z\/r\)/,
  );
  assert.match(
    point,
    /for\(var p=0u;p<cloud\.flags\.y;p\+\+\)\{if\(dot\(cloud\.planes\[p\]\.xyz,wp\)\+cloud\.planes\[p\]\.w<0\.0\)\{discard;\}\}/,
  );
  assert.ok(point.indexOf('cloud.planes[p]') < point.indexOf('s.color=encode(color);'), 'before the colour is final');
  assert.match(sprite, /struct Batch\{model:mat4x4f,color:vec4f,params:vec4f,planes:array<vec4f,6>\}/);
  assert.match(sprite, /@location\(2\) world:vec3f\}/);
  assert.match(sprite, /out\.clip=clip;out\.world=wp;/);
  assert.match(
    sprite,
    /for\(var p=0u;p<u32\(batch\.params\.w\);p\+\+\)\{if\(dot\(batch\.planes\[p\]\.xyz,i\.world\)\+batch\.planes\[p\]\.w<0\.0\)\{discard;\}\}/,
  );
  const sizes = r.setup.filter((e) => e[0] === 'layout').map((e) => e[2].entries?.[0]?.buffer?.minBindingSize);
  assert.ok(sizes.includes(CLOUD_BYTES) && sizes.includes(SPRITE_BYTES), 'bind group layouts sized for the planes');
  r.frame();
  r.cloud.material.clippingPlanes = [[1, 0, 0, 0]];
  r.batch.material.clippingPlanes = [[1, 0, 0, 0]];
  assert.deepEqual(modules(r.frame()), [], 'adding planes compiles nothing');
});

test('fogged shaders keep the clipping loops and the varyings stay distinct', () => {
  const r = rig({ clippingPlanes: [[0, 1, 0, 0]] });
  r.plugin.setFog({ color: [0.2, 0.4, 0.6], density: 0.05 });
  const [point, sprite] = modules(r.frame());
  assert.match(point, /@location\(3\) @interpolate\(flat\) center:vec3f,/);
  assert.match(point, /@location\(4\) @interpolate\(flat\) fog:f32,/);
  assert.match(point, /cloud\.planes\[p\]/);
  assert.match(sprite, /return encode\(fogged\(color,fogAmount\(i\.world\)\)\);/);
  assert.equal(sprite.split('world:vec3f').length, 2, 'one sprite world varying');
  assert.match(sprite, /batch\.planes\[p\]/);
});

test('cloud planes reach byte 128 with the count in flags.y; batch planes byte 96 with the count in params.w; live', () => {
  const r = rig();
  const first = r.frame(),
    [cloud] = writes(first, CLOUD_BYTES),
    [batch] = writes(first, SPRITE_BYTES);
  assert.equal(new Uint32Array(cloud)[25], 0, 'unclipped clouds write count 0');
  assert.deepEqual([...new Float32Array(cloud, 128)], Array(24).fill(0));
  assert.equal(new Float32Array(batch)[23], 0, 'unclipped batches write count 0');
  assert.deepEqual([...new Float32Array(batch, 96)], Array(24).fill(0));
  assert.equal(new Float32Array(cloud)[20], 4, 'the rest of the uniform is unchanged (size)');
  const idle = r.frame();
  assert.deepEqual([writes(idle, CLOUD_BYTES).length, writes(idle, SPRITE_BYTES).length], [0, 0], 'no rewrite');

  r.cloud.material.clippingPlanes = [
    [0, 2, 0, -1],
    [1, 0, 0, 3],
  ];
  r.batch.material.clippingPlanes = [[0, 0, -3, 6]];
  const second = r.frame(),
    [c2] = writes(second, CLOUD_BYTES),
    [b2] = writes(second, SPRITE_BYTES);
  assert.equal(new Uint32Array(c2)[25], 2);
  assert.deepEqual([...new Float32Array(c2, 128)], [0, 1, 0, -0.5, 1, 0, 0, 3, ...Array(16).fill(0)]);
  assert.equal(new Float32Array(b2)[23], 1);
  assert.deepEqual([...new Float32Array(b2, 96)], [0, 0, -1, 2, ...Array(20).fill(0)]);

  r.cloud.material.clippingPlanes = [[0, 0, 1, 0]];
  r.batch.material.clippingPlanes = [];
  const third = r.frame(),
    [c3] = writes(third, CLOUD_BYTES),
    [b3] = writes(third, SPRITE_BYTES);
  assert.equal(new Uint32Array(c3)[25], 1);
  assert.deepEqual(
    [...new Float32Array(c3, 128)],
    [0, 0, 1, 0, ...Array(20).fill(0)],
    'a shorter list clears the rest',
  );
  assert.equal(new Float32Array(b3)[23], 0);
  assert.deepEqual([...new Float32Array(b3, 96)], Array(24).fill(0));
});
