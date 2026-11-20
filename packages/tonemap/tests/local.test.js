import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { LocalExposure } from '../dist/local.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const fragment = (h) =>
  h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;

test('LocalExposure adds its stops after the exposure step and binds its base at 16', () => {
  const local = new LocalExposure(),
    h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { extensions: [local] });
  h.frame();
  const code = fragment(h);
  assert.ok(code.includes('hdr=max(hdr,vec3f(0))*exp2(p.grade.x);hdr*=exp2(localStops(pos.xy,p.grade.x));'));
  assert.ok(code.includes('@group(0) @binding(16) var localBase:texture_2d<f32>;'));
  const entries = h.groups.at(-1).entries.map((e) => e.binding);
  assert.ok(entries.includes(5) && entries.includes(16), 'uniform and base bound');
  assert.deepEqual([...local.values()], [0.5, 3, 4, 0], 'strength and maxStops defaults, 4 by 4 blocks');
  // Three quarter-resolution passes a frame, no new GPU objects on a steady frame.
  const before = { ...h.counts };
  h.frame();
  const plain = gpuHarness(),
    plainEffect = Tonemap.attach(plain.engine, {});
  plain.frame();
  const plainBefore = plain.counts.render;
  plain.frame();
  plainEffect.dispose();
  assert.equal(h.counts.render - before.render - (plain.counts.render - plainBefore), 3, 'three base passes a frame');
  assert.equal(h.counts.textures, before.textures);
  assert.equal(h.counts.groups, before.groups);
  effect.dispose();
  local.dispose();
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'every texture and buffer is freed',
  );
});

test('LocalExposure blurs three sigma a side at any radius by building its base from larger blocks', () => {
  // Before, the taps a side stopped at 32 quarter-resolution texels, so a sigma above 10.7 texels was cut short (radius
  // 0.1 at 2160 rows: sigma 54 texels, cut at 0.59 sigma).
  const h = gpuHarness(),
    device = h.engine.gpu,
    writes = [],
    write = device.queue.writeBuffer;
  device.queue.writeBuffer = (buffer, offset, values, start = 0, count) => {
    if (buffer.size === 528) writes.push([offset, ...values.slice(start, start + (count ?? values.length))]);
    return write(buffer, offset, values, start, count);
  };
  for (const [height, radius, block] of [
    [240, 0.02, 4],
    [2160, 0.02, 8],
    [2160, 0.1, 32],
    [8192, 0.1, 128],
  ]) {
    const local = new LocalExposure({ radius }),
      textures = [];
    const create = device.createTexture;
    writes.length = 0;
    const source = device.createTexture({ size: [16, 16], format: 'rgba16float', usage: 6 });
    device.createTexture = (d) => (textures.push(d.size), create.call(device, d));
    local.encode({ device, encoder: h.context.encoder, source, width: 3840, height });
    device.createTexture = create;
    const sigma = (radius * height) / block,
      [h0, v0, d0] = [0, 256, 512].map((o) => writes.find((w) => w[0] === o));
    assert.equal(d0[1], block, `${height} rows, radius ${radius}: ${block} by ${block} blocks`);
    assert.deepEqual(textures.at(-1), [Math.ceil(3840 / block), Math.ceil(height / block)]);
    for (const w of [h0, v0]) {
      assert.equal(w[1], Math.fround(sigma));
      assert.equal(w[2], Math.ceil(3 * sigma), 'three sigma a side');
      assert.ok(w[2] <= 32);
    }
    assert.equal(local.values()[2], block, 'the base is sampled at the block size');
    local.dispose();
  }
});

test('LocalExposure follows the auto-exposure stops in the effects variant', () => {
  const local = new LocalExposure({ strength: 0.3 }),
    h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { autoExposure: true, extensions: [local] });
  h.frame();
  assert.ok(fragment(h).includes('hdr*=exp2(localStops(pos.xy,p.grade.x+ae[0]));'));
  effect.dispose();
  local.dispose();
});

test('LocalExposure checks its options now and every frame', () => {
  for (const bad of [{ strength: 2 }, { maxStops: -1 }, { radius: 0.5 }, { edges: 0 }, { strength: NaN }])
    assert.throws(() => new LocalExposure(bad), RangeError, JSON.stringify(bad));
  const local = new LocalExposure();
  local.options.maxStops = 9;
  assert.throws(() => local.values(), RangeError);
  assert.throws(() => local.patch('no exposure here', 5, 16), RangeError);
});
