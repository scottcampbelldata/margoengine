import test from 'node:test';
import assert from 'node:assert/strict';
import { Bloom, SSAO, bloomWeights } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('Bloom captures HDR, preserves scene depth for later overlays, resizes and restores without leaks', async () => {
  const h = optionalGPU(),
    effect = new Bloom();
  h.engine.use(effect);
  h.frame();
  assert.equal(effect.depthTexture.width, 128);
  assert.equal(h.context.color, h.originalColor);
  assert.equal(h.context.depth, h.originalDepth);
  const scene = effect.sceneTexture;
  assert.equal(scene.format, 'rgba16float');
  assert.ok(scene.usage & GPUTextureUsage.COPY_SRC);
  const groups = h.counts.groups,
    textures = h.counts.textures,
    descriptors = [];
  const render = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    descriptors.push(descriptor);
    return render(descriptor);
  };
  h.frame();
  assert.equal(h.counts.groups, groups);
  assert.equal(h.counts.textures, textures);
  const descriptor = descriptors.at(-1),
    attachment = descriptor.colorAttachments[0];
  h.frame();
  assert.equal(effect.sceneTexture, scene);
  assert.equal(descriptors.at(-1), descriptor);
  assert.equal(descriptor.colorAttachments[0], attachment);
  assert.equal(attachment.view, h.originalColor);
  assert.equal(h.counts.compute, 3);
  assert.equal(h.counts.render, 12);
  h.context.width = 1;
  h.context.height = 1;
  h.frame();
  assert.equal(effect.depthTexture.width, 1);
  assert.equal(effect.sceneTexture.width, 1);
  assert.equal(scene.destroyed, true);
  assert.throws(() => h.engine.use(new SSAO()), /output target/);
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.dispose();
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('Bloom rejects invalid grade settings before allocation and rechecks mutable options', () => {
  for (const options of [{ strength: -1 }, { threshold: NaN }, { exposure: 11 }])
    assert.throws(() => new Bloom(options), /Invalid/);
  const h = optionalGPU(),
    options = { strength: 1 },
    effect = new Bloom(options);
  h.engine.use(effect);
  h.frame();
  options.strength = Infinity;
  assert.throws(() => h.frame(), /Invalid/);
  effect.dispose();
});

test('bloomWeights: radius 0.5 is the unweighted chain, the total stays the level count, 0 and 1 favour the ends', () => {
  assert.deepEqual(bloomWeights(0.5, 6), [1, 1, 1, 1, 1, 1]);
  for (const radius of [0, 0.2, 0.7, 1]) {
    const w = bloomWeights(radius, 6),
      k = 4 ** (2 * radius - 1);
    assert.ok(Math.abs(w.reduce((a, b) => a + b) - 6) < 1e-12);
    for (let j = 1; j < 6; j++) assert.ok(Math.abs(w[j] / w[j - 1] - k) < 1e-12);
  }
  // 1 / (1 + 1/4 + ... + 1/4^5) = 1024 / 1365 of the glow in the tightest level at 0, the widest at 1.
  assert.ok(Math.abs(bloomWeights(0, 6)[0] / 6 - 1024 / 1365) < 1e-12);
  assert.ok(Math.abs(bloomWeights(1, 6)[5] / 6 - 1024 / 1365) < 1e-12);
  assert.deepEqual(bloomWeights(0, 1), [1]);
});

test('Bloom radius: validated, weights each up step, and switches back to the unweighted chain at 0.5', () => {
  for (const radius of [-0.1, 1.1, NaN, '0.5']) assert.throws(() => new Bloom({ radius }), RangeError);
  const h = optionalGPU(),
    options = { radius: 0 },
    effect = new Bloom(options);
  h.engine.use(effect);
  h.frame();
  const weights = h.resources.find((r) => r.size === 1280);
  assert.ok(weights && weights.usage & GPUBufferUsage.UNIFORM);
  // 128 x 96 viewport: six levels, five up steps; step i reads w[i] and, on the first (i = 4), w[5] for the level below.
  const slices = new Float32Array(weights.data),
    w = bloomWeights(0, 6);
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(slices[i * 64] - w[i]) < 1e-6);
    assert.ok(Math.abs(slices[i * 64 + 1] - (i === 4 ? w[5] : 1)) < 1e-6);
  }
  const up = h.groups.filter((g) => g.entries.some((e) => e.binding === 4 && e.resource.buffer === weights));
  assert.deepEqual(
    up.map((g) => g.entries.find((e) => e.binding === 4).resource.offset),
    [1024, 768, 512, 256, 0],
  );
  const groups = h.counts.groups;
  h.frame();
  assert.equal(h.counts.groups, groups, 'a steady weighted frame creates no bind groups');
  options.radius = 0.5;
  h.frame();
  const unweighted = h.groups.slice(groups);
  assert.equal(unweighted.length, 12, 'the chain (6 down + 5 up) and the presentation are rebuilt once');
  assert.ok(unweighted.every((g) => !g.entries.some((e) => e.resource.buffer === weights)));
  options.radius = 2;
  assert.throws(() => h.frame(), RangeError);
  effect.dispose();
  assert.equal(weights.destroyed, true);
});

// 13654e6bd: Night Citadel's glints gained and lost their glow from frame to frame: the first blur read every other row,
// the glow came back through textureLoad (nearest) and one bright pixel lit a whole level.
test('Bloom filters its chain, reads the glow back filtered and dithers the result', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/bloom.ts', import.meta.url), 'utf8');
  assert.match(source, /var c=textureSampleLevel\(source,bilinear,uv\+o\[i\]\*t,0\.0\)/, '13 filtered taps, every row');
  assert.match(source, /s\[3\]\+s\[4\]\+s\[8\]\+s\[9\]/, 'overlapping boxes, the firefly-safe downsample');
  assert.match(source, /tent\(bloom,bilinear,p\.xy\/vec2f\(textureDimensions\(scene\)\)\)/, 'glow through the sampler');
  assert.doesNotMatch(source, /textureLoad\(bloom,/);
  assert.match(source, /o\+dither\(p\.xy\)/, 'dithered');
});
