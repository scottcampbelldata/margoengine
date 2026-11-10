import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { ContactLights, MAX_CONTACT_LIGHTS } from '../dist/contact.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const HEADER = 40 + MAX_CONTACT_LIGHTS;
const transform = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const length = (a) => Math.hypot(...a);

// Line-for-line mirror of the WGSL clusterContact, reading the floats ContactLights keeps in its buffer.
function mirror(f, index, light, position, n, pixel) {
  const view = f.subarray(0, 16),
    inverse = f.subarray(16, 32),
    size = f.subarray(32, 36),
    march = f.subarray(36, 40);
  if (size[2] < 0.5 || index >= MAX_CONTACT_LIGHTS) return 1;
  const strength = f[40 + index];
  if (strength <= 0) return 1;
  const delta = sub(light.position, position),
    l = delta.map((v) => v / length(delta)),
    reach = Math.min(march[0], length(delta)),
    stride = reach / march[2],
    fract = (x) => x - Math.floor(x),
    shift = fract(52.9829189 * fract(pixel[0] * 0.06711056 + pixel[1] * 0.00583715)),
    start = position.map((v, i) => v + (n[i] / Math.max(length(n), 0.000001)) * march[3]);
  for (let i = 0; i < march[2]; i++) {
    const q = start.map((v, k) => v + l[k] * stride * (i + shift)),
      clip = transform(view, [...q, 1]);
    if (clip[3] <= 0) break;
    const ndc = clip.slice(0, 3).map((v) => v / clip[3]),
      uv = [ndc[0] * 0.5 + 0.5, ndc[1] * -0.5 + 0.5];
    if (uv.some((v) => v < 0 || v >= 1)) break;
    const texel = uv.map((v, k) => Math.min(Math.floor(v * size[k]), size[k] - 1)),
      found = f[HEADER + texel[1] * size[0] + texel[0]];
    if (found > ndc[2]) {
      const back = transform(inverse, [ndc[0], ndc[1], found, 1]),
        world = back.slice(0, 3).map((v) => v / back[3]);
      if (length(sub(world, q)) < march[1]) return 1 - strength;
    }
  }
  return 1;
}

// A camera looking straight down (orthographic): x and z from -2 to 2 across the screen, height -1..1 as reversed depth
// 0..1 (higher is nearer). Column-major, as WGSL reads a mat4x4f.
const topDown = new Float32Array([0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0, 0, 0.5, 1]);
const SIZE = 64;
// The scene: a floor at height 0 with a 0.05-high strip from x 0.1 to 0.3 lying on it.
const height = (x) => (x >= 0.1 && x <= 0.3 ? 0.05 : 0);

function frameWith(contact, h, depth) {
  h.context.shader = wgsl;
  h.context.bindings.length = 0;
  h.engine.frameGraph.execute(h.context);
  if (depth) {
    // The GPU copy pass's work, done here: texel centres' depths after the header.
    const f = new Float32Array(contact.bindings()[0].resource.buffer.data);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) f[HEADER + y * SIZE + x] = (height(((x + 0.5) / SIZE - 0.5) * 4) + 1) / 2;
  }
  return { shader: h.context.shader, bindings: h.context.bindings.map((b) => b.binding) };
}

test('ContactLights validates options and strengths before changing anything', () => {
  const lights = new Clustered({ grid: [2, 2, 2] });
  assert.throws(() => new ContactLights({}), TypeError);
  assert.throws(() => new ContactLights({ lights, distance: 0 }), RangeError);
  assert.throws(() => new ContactLights({ lights, thickness: Infinity }), RangeError);
  assert.throws(() => new ContactLights({ lights, strength: 1.5 }), RangeError);
  assert.throws(() => new ContactLights({ lights, steps: 65 }), RangeError);
  assert.throws(() => new ContactLights({ lights, steps: 2.5 }), RangeError);
  assert.throws(() => new ContactLights({ lights, bias: -1 }), RangeError);
  assert.throws(() => new ContactLights({ lights, depth: 3 }), TypeError);
  const contact = new ContactLights({ lights, depth: () => undefined });
  contact.setStrengths([0.5, null]);
  assert.throws(() => contact.setStrengths([2]), RangeError);
  assert.throws(() => contact.setStrengths(new Array(MAX_CONTACT_LIGHTS + 1).fill(0)), RangeError);
  assert.deepEqual(contact.list, [0.5, null]);
  assert.ok(Object.isFrozen(contact.list));
});

test('ContactLights add clusterContact and binding 145 to shadowed receivers only, and copy depth after the frame', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [1, 0.3, 0], range: 6 }]);
  h.engine.use(lights);
  let texture;
  const contact = new ContactLights({ lights, depth: () => texture, strength: 0.6, distance: 0.5 });
  try {
    const plain = frameWith(contact, h);
    h.engine.use(contact);
    assert.equal(lights.contact, contact);
    const lit = frameWith(contact, h);
    assert.match(lit.shader, /@binding\(145\) var<storage,read> clusterContactData/);
    assert.ok(lit.shader.includes('*clusterContact(index,light,l,position,n,pixel)'));
    assert.ok(lit.shader.includes('let index=clusterIndices[cell*1024u+j];'));
    assert.deepEqual(lit.bindings, [...plain.bindings, 145]);
    assert.ok(!lights.bindings(false).some((b) => b.binding === 145), 'receiveShadow false: no contact binding');
    assert.ok(!lights.pbr(2, false).declarations.includes('clusterContact'), 'receiveShadow false: no contact code');
    // No depth yet: the header says invalid, so the march returns 1.
    let f = new Float32Array(contact.bindings()[0].resource.buffer.data);
    assert.equal(f[34], 0);
    let computes = h.counts.compute;
    frameWith(contact, h);
    const perFrame = h.counts.compute - computes;
    computes = h.counts.compute;
    texture = h.engine.gpu.createTexture({ size: [SIZE, SIZE], format: 'depth32float', usage: 4 });
    texture.width = texture.height = SIZE;
    texture.sampleCount = 1;
    h.context.camera.matrix = topDown;
    frameWith(contact, h, true);
    assert.equal(h.counts.compute - computes, perFrame + 1, 'one copy dispatch');
    f = new Float32Array(contact.bindings()[0].resource.buffer.data);
    assert.deepEqual(
      [...f.subarray(32, 40)].map((v) => +v.toFixed(4)),
      [SIZE, SIZE, 1, 0, 0.5, 0.1, 12, 0.01],
    );
    assert.deepEqual([...f.subarray(0, 16)], [...topDown]);
    assert.equal(f[40], Math.fround(0.6));
    contact.setStrengths([0.25]);
    frameWith(contact, h, true);
    f = new Float32Array(contact.bindings()[0].resource.buffer.data);
    assert.equal(f[40], 0.25);
    assert.equal(f[41], Math.fround(0.6));
    texture.sampleCount = 4;
    assert.throws(() => frameWith(contact, h), RangeError);
    texture.sampleCount = 1;
    const buffer = contact.bindings()[0].resource.buffer;
    contact.dispose();
    assert.ok(buffer.destroyed);
    assert.equal(lights.contact, undefined);
    assert.deepEqual(frameWith(contact, h).bindings, plain.bindings);
  } finally {
    lights.dispose();
  }
});

// Regression: the empty buffer was 4,260 bytes and WebGPU refused binding 145 (minimum binding size 4,272, the struct
// rounded up to its 16-byte alignment), so a scene with ContactLights before its first depth copy failed on Metal.
test('ContactLights sizes its buffer to the struct alignment and keeps a replaced one until the next frame', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [1, 0.3, 0], range: 6 }]);
  h.engine.use(lights);
  let texture;
  const contact = new ContactLights({ lights, depth: () => texture });
  try {
    h.engine.use(contact);
    const first = contact.bindings()[0].resource.buffer,
      empty = first.size;
    assert.equal(empty % 16, 0);
    assert.ok(empty >= (HEADER + 1) * 4);
    texture = h.engine.gpu.createTexture({ size: [3, 3], format: 'depth32float', usage: 4 });
    frameWith(contact, h);
    const grown = contact.bindings()[0].resource.buffer;
    assert.equal(grown.size % 16, 0);
    assert.ok(grown.size >= (HEADER + 9) * 4);
    // Regression: the buffer this frame's lit passes bound was destroyed before submit ("used in submit while
    // destroyed" on Metal); it now lives until the next frame.
    assert.notEqual(grown, first);
    assert.ok(!first.destroyed);
    frameWith(contact, h);
    assert.ok(first.destroyed);
    assert.ok(!grown.destroyed);
  } finally {
    contact.dispose();
    lights.dispose();
  }
});

test('the contact march darkens a floor point beside a low strip toward the light, and nothing else', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  h.engine.use(lights);
  const texture = h.engine.gpu.createTexture({ size: [SIZE, SIZE], format: 'depth32float', usage: 4 });
  Object.assign(texture, { width: SIZE, height: SIZE, sampleCount: 1 });
  const contact = new ContactLights({ lights, depth: texture, strength: 0.75 });
  h.engine.use(contact);
  h.context.camera.matrix = topDown;
  try {
    frameWith(contact, h, true);
    frameWith(contact, h, true);
    const f = new Float32Array(contact.bindings()[0].resource.buffer.data),
      up = [0, 1, 0],
      right = { position: [1, 0.3, 0] },
      left = { position: [-1, 0.3, 0] },
      high = { position: [1, 3, 0] };
    for (const pixel of [
      [10, 20],
      [33, 31],
      [0, 0],
    ]) {
      // Beside the strip, the light low on its far side: the ray passes under the strip's top within the thickness.
      assert.equal(mirror(f, 0, right, [0.05, 0, 0], up, pixel), 0.25);
      // The light on the open side, a light high overhead, a bare floor: lit.
      assert.equal(mirror(f, 0, left, [0.05, 0, 0], up, pixel), 1);
      assert.equal(mirror(f, 0, high, [0.05, 0, 0], up, pixel), 1);
      assert.equal(mirror(f, 0, right, [-1, 0, 0], up, pixel), 1);
      // The strip's own top does not shadow itself.
      assert.equal(mirror(f, 0, right, [0.2, 0.05, 0], up, pixel), 1);
    }
    // Past the per-light strengths, and with strength 0: lit.
    assert.equal(mirror(f, MAX_CONTACT_LIGHTS, right, [0.05, 0, 0], up, [1, 1]), 1);
    contact.setStrengths([0]);
    frameWith(contact, h, true);
    assert.equal(
      mirror(new Float32Array(contact.bindings()[0].resource.buffer.data), 0, right, [0.05, 0, 0], up, [1, 1]),
      1,
    );
  } finally {
    contact.dispose();
    lights.dispose();
  }
});
