// The procedural studio (`@margoengine/environment/studio`) on the CPU: validation, the image layout, the room
// gradient, each softbox's radiance and edge, and that the same options give the same bytes. On a real GPU (an
// Environment made from it, its SH and lighting): tests/studio-browser.js (npm run test:studio:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { studio, STUDIO_LIGHTS } from '../dist/studio.js';

// The image's texel nearest direction d (equirect: centre -Z, row 0 +Y), and the direction of a texel's centre.
const texel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
function at(image, d) {
  const phi = Math.atan2(d[0], -d[2]),
    theta = Math.acos(Math.max(-1, Math.min(1, d[1])));
  return texel(
    image,
    Math.min(image.width - 1, Math.floor((phi / (2 * Math.PI) + 0.5) * image.width)),
    Math.min(image.height - 1, Math.floor((theta / Math.PI) * image.height)),
  );
}
const close = (a, b, eps = 1e-5) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const empty = { lights: [] };

test('validation: width, colours, horizon and lights', () => {
  for (const bad of [
    { width: 100 },
    { width: 8 },
    { width: 8192 },
    { floor: [1, 1] },
    { walls: [-1, 0, 0] },
    { ceiling: [0, Number.NaN, 0] },
    { horizon: -0.1 },
    { lights: [{ direction: [0, 0, 0], width: 1, height: 1, intensity: 1 }] },
    { lights: [{ direction: [0, 1, 0], width: 0, height: 1, intensity: 1 }] },
    { lights: [{ direction: [0, 1, 0], width: 1, height: Math.PI, intensity: 1 }] },
    { lights: [{ direction: [0, 1, 0], width: 1, height: 1, intensity: -1 }] },
    { lights: [{ direction: [0, 1, 0], width: 1, height: 1, intensity: 1, color: [2, 0, 0] }] },
    { lights: [{ direction: [0, 1, 0], width: 1, height: 1, intensity: 1, softness: 1.5 }] },
    { lights: [null] },
  ])
    assert.throws(() => studio(bad), RangeError, JSON.stringify(bad));
});

test('an RGBA equirect, width x width / 2, alpha 1, deterministic', () => {
  const image = studio({ width: 64 });
  assert.equal(image.width, 64);
  assert.equal(image.height, 32);
  assert.equal(image.data.length, 64 * 32 * 4);
  for (let i = 3; i < image.data.length; i += 4) assert.equal(image.data[i], 1);
  assert.ok(image.data.every((v) => Number.isFinite(v) && v >= 0));
  const hash = (img) => createHash('sha256').update(new Uint8Array(img.data.buffer)).digest('hex');
  assert.equal(hash(studio({ width: 64 })), hash(image));
});

test('the room: floor below the horizon band, walls at it, ceiling straight up', () => {
  const image = studio({
    ...empty,
    width: 256,
    floor: [0.1, 0.2, 0.3],
    walls: [0.4, 0.4, 0.4],
    ceiling: [1, 0.8, 0.6],
  });
  assert.ok(close(at(image, [0, -1, 0]).slice(0, 3), [0.1, 0.2, 0.3]));
  assert.ok(close(at(image, [1, -0.2, 0]).slice(0, 3), [0.1, 0.2, 0.3]), 'below the band: floor');
  // Straight up the ceiling: the top row's centre is 0.35 degrees below the zenith, sin of its elevation 1 - 2e-5.
  assert.ok(close(at(image, [0, 1, 0]).slice(0, 3), [1, 0.8, 0.6], 1e-4));
  // At the horizon (the band's middle) half floor, half walls.
  const row = image.height / 2,
    horizon = texel(image, 10, row),
    elevation = Math.PI / 2 - (Math.PI * (row + 0.5)) / image.height,
    t = (elevation + 0.04) / 0.08,
    s = t * t * (3 - 2 * t);
  for (let k = 0; k < 3; k++)
    assert.ok(Math.abs(horizon[k] - ([0.1, 0.2, 0.3][k] + ([0.4, 0.4, 0.4][k] - [0.1, 0.2, 0.3][k]) * s)) < 0.02);
  // Without lights it is the same in every azimuth.
  for (let y = 0; y < image.height; y++) assert.ok(close(texel(image, 0, y), texel(image, 97, y)));
});

test('a softbox adds intensity x colour inside, fades over its softness and nothing outside', () => {
  const light = { direction: [0, 0, -1], width: 0.6, height: 0.4, intensity: 5, color: [1, 0.5, 0.25], softness: 0.2 };
  const image = studio({ width: 1024, lights: [light] }),
    base = studio({ width: 1024, ...empty });
  const add = (d) =>
    at(image, d)
      .map((v, k) => v - at(base, d)[k])
      .slice(0, 3);
  assert.ok(close(add([0, 0, -1]), [5, 2.5, 1.25], 1e-4), 'centre');
  // Inside the flat part (angles under 0.8 of the half size) the full intensity; just outside, nothing.
  const dir = (u, v) => {
    const d = [Math.tan(u), Math.tan(v), -1],
      l = Math.hypot(...d);
    return d.map((x) => x / l);
  };
  assert.ok(close(add(dir(0.2, 0.1)), [5, 2.5, 1.25], 1e-4), 'flat inside');
  assert.ok(close(add(dir(0.32, 0)), [0, 0, 0]), 'past the width');
  assert.ok(close(add(dir(0, 0.22)), [0, 0, 0]), 'past the height');
  const edge = add(dir(0.285, 0))[0];
  assert.ok(edge > 0 && edge < 5, `inside the soft edge: ${edge}`);
  assert.ok(close(add([0, 0, 1]), [0, 0, 0]), 'behind');
  const hard = studio({ width: 1024, lights: [{ ...light, softness: 0 }] });
  assert.ok(
    close(
      at(hard, dir(0.285, 0)).slice(0, 3),
      at(base, dir(0.285, 0))
        .slice(0, 3)
        .map((v, k) => v + [5, 2.5, 1.25][k]),
      1e-4,
    ),
  );
});

test('the default lights: overhead, key front left, fill front right, rim behind, each brighter than the room', () => {
  assert.equal(STUDIO_LIGHTS.length, 4);
  const image = studio(),
    base = studio(empty);
  for (const light of STUDIO_LIGHTS) {
    const l = Math.hypot(...light.direction),
      d = light.direction.map((x) => x / l),
      gain = at(image, d)[0] - at(base, d)[0];
    assert.ok(Math.abs(gain - light.intensity) < 1e-3, `${light.direction}: ${gain}`);
  }
  assert.ok(STUDIO_LIGHTS[1].intensity > STUDIO_LIGHTS[2].intensity, 'key over fill');
  assert.ok(STUDIO_LIGHTS[1].direction[0] < 0 && STUDIO_LIGHTS[1].direction[2] > 0, 'key to the front left');
});

test('extreme finite and subnormal softbox directions preserve every image texel', () => {
  const options = { width: 16, floor: [0, 0, 0], walls: [0, 0, 0], ceiling: [0, 0, 0] };
  const image = (direction) => studio({ ...options, lights: [{ direction, width: 1, height: 1, intensity: 1 }] }).data;
  const expected = image([1, 1, 0]);
  for (const scale of [Number.MAX_VALUE, Number.MIN_VALUE]) assert.deepEqual(image([scale, scale, 0]), expected);
});
