// The `moving` evidence of the shot tool (tools/shot/motion.mjs): the depth mask turned back into distances, the motion
// of a still world seen by a moving camera written beside the probe, and the shot header rules for `moving`. Plain data:
// no browser and no GPU (tools/shot/test/moving-check.mjs renders a real shot).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePNG } from '@margoengine/headless';
import { SKY_DISTANCE, distanceFromNearness, velocityInPixels, writeMoving } from '../tools/shot/motion.mjs';
import { resampleVector } from '../tools/shot/pixels.js';
import { validateShot } from '../tools/shot/shot-file.mjs';

const grey = (width, height, value) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([typeof value === 'function' ? value(i) : value, 0, 0, 255], i * 4);
  return { width, height, data };
};
const perspective = (fov, aspect, near, far) => {
  const f = 1 / Math.tan(fov / 2),
    m = new Array(16).fill(0);
  Object.assign(m, { 0: f / aspect, 5: f, 10: far / (near - far), 11: -1, 14: (near * far) / (near - far) });
  return m;
};
// The matrix of a camera moved `x` metres to its right: the world moves -x in its view.
const moved = (m, x) => {
  const out = [...m];
  for (let r = 0; r < 4; r++) out[12 + r] = m[12 + r] - m[r] * x;
  return out;
};

test('distanceFromNearness turns exp(-distance / scale) back into metres, 0 where nothing is drawn', () => {
  const near = Math.round(255 * Math.exp(-20 / 200)),
    distance = distanceFromNearness(
      grey(2, 1, (i) => (i === 0 ? near : 0)),
      200,
    );
  assert.ok(Math.abs(distance[0] - 20) < 1, `distance ${distance[0]}`);
  assert.equal(distance[1], 0);
});

test('writeMoving writes the next frame and the camera motion of a still world beside the probe', async () => {
  const out = mkdtempSync(join(tmpdir(), 'margo-moving-')),
    width = 65,
    height = 33,
    near = Math.round(255 * Math.exp(-20 / 200));
  try {
    mkdirSync(join(out, 'probes'));
    mkdirSync(join(out, 'frames'));
    const depth = grey(width, height, (i) => (i < (width * height) / 2 ? near : 0));
    writeFileSync(join(out, 'probes', 'open.depth.png'), await encodePNG(depth));
    writeFileSync(join(out, 'probes', 'open.water.png'), await encodePNG(grey(width, height, 0)));
    writeFileSync(join(out, 'frames', 'frame_0016.png'), await encodePNG(grey(width, height, 90)));
    const projection = perspective(1, width / height, 0.1, 2000),
      shot = { moving: { depthScale: 200 }, horizon: { y: 0 }, aovs: ['geometry', 'depth', 'water'] },
      entry = await writeMoving({
        out,
        name: 'open',
        nextFile: 'frames/frame_0016.png',
        eye: [0, 0, 0],
        viewProjection: projection,
        nextViewProjection: moved(projection, 0.5),
        shot,
      });
    assert.deepEqual(entry, { next: 'probes/open.next.png', motion: 'probes/open.motion.f32' });
    assert.deepEqual(readFileSync(join(out, entry.next)), readFileSync(join(out, 'frames', 'frame_0016.png')));
    const bytes = readFileSync(join(out, entry.motion)),
      motion = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(motion.length, width * height * 2);
    // The pixel on the axis (row 16, column 32) is in the top half, 20 m away: a camera 0.5 m to its right sees it
    // 0.5 / 20 of a unit of x further left, which the projection takes to pixels.
    const centre = 16 * width + 32,
      expected = ((-0.5 * (1 / Math.tan(0.5))) / (width / height) / 20) * (width / 2);
    assert.ok(Math.abs(motion[centre * 2] - expected) < 0.1, `x ${motion[centre * 2]} against ${expected}`);
    // A pixel with no geometry and no sea is a sky SKY_DISTANCE away and barely moves.
    const sky = (height - 1) * width + 32;
    assert.ok(Math.abs(motion[sky * 2]) < Math.abs(motion[centre * 2]) / 10, `sky ${motion[sky * 2]}`);
    assert.ok(SKY_DISTANCE > 1000);
    // With the next frame's eye and depth the motion back is written too (KB-LOOK-TV-SHIMMER2): a still world moves
    // back by the opposite of its motion, so the forward-backward test finds nothing covered.
    writeFileSync(join(out, 'frames', 'depth_0016.png'), await encodePNG(depth));
    const both = await writeMoving({
        out,
        name: 'open',
        nextFile: 'frames/frame_0016.png',
        next: { eye: [0.5, 0, 0], depth: { file: 'frames/depth_0016.png' } },
        eye: [0, 0, 0],
        viewProjection: projection,
        nextViewProjection: moved(projection, 0.5),
        shot,
      }),
      backBytes = readFileSync(join(out, both.back)),
      back = new Float32Array(backBytes.buffer.slice(backBytes.byteOffset, backBytes.byteOffset + backBytes.byteLength));
    assert.equal(both.back, 'probes/open.back.f32');
    assert.ok(Math.abs(back[centre * 2] + motion[centre * 2]) < 0.1, `back ${back[centre * 2]} against ${motion[centre * 2]}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// KB-SHOT-DEPTH8BIT1: at a 2,000 m scale one 8-bit step of exp(-distance / scale) is 8 m near the eye.
const NEAR_AND_FAR = [3, 500],
  nearness = (metres) => Math.exp(-metres / 2000);

test('the depth floats give near and far ground its distance, which 8-bit nearness cannot', () => {
  const bytes = distanceFromNearness(
      grey(2, 1, (i) => Math.round(255 * nearness(NEAR_AND_FAR[i]))),
      2000,
    ),
    floats = distanceFromNearness({ width: 2, height: 1, value: Float32Array.from(NEAR_AND_FAR, nearness) }, 2000);
  assert.equal(bytes[0], 0, '3 m rounds to 255: no distance, so the motion took it for sky');
  assert.ok(Math.abs(bytes[1] - 500) > 1, `500 m reads as ${bytes[1]}`);
  for (const [i, metres] of NEAR_AND_FAR.entries())
    assert.ok(Math.abs(floats[i] - metres) < 1e-3 * metres, `${metres} m reads as ${floats[i]}`);
  const none = distanceFromNearness({ width: 2, height: 1, value: Float32Array.of(0, 1) }, 2000);
  assert.deepEqual([...none], [0, 0], 'nothing drawn and the eye itself have no distance');
});

test('writeMoving takes the distances from probes/<name>.depth.f32 and refuses one of another size', async () => {
  const out = mkdtempSync(join(tmpdir(), 'margo-moving-f32-')),
    width = 33,
    height = 17;
  try {
    mkdirSync(join(out, 'probes'));
    mkdirSync(join(out, 'frames'));
    // The PNG says nothing the motion can use (every pixel rounds to 255); the floats say 3 m.
    writeFileSync(join(out, 'probes', 'low.depth.png'), await encodePNG(grey(width, height, 255)));
    writeFileSync(join(out, 'frames', 'frame_0016.png'), await encodePNG(grey(width, height, 90)));
    const floats = new Float32Array(width * height).fill(nearness(3));
    writeFileSync(join(out, 'probes', 'low.depth.f32'), Buffer.from(floats.buffer));
    const projection = perspective(1, width / height, 0.1, 5000),
      options = {
        out,
        name: 'low',
        nextFile: 'frames/frame_0016.png',
        eye: [0, 0, 0],
        viewProjection: projection,
        nextViewProjection: moved(projection, 0.05),
        shot: { moving: { depthScale: 2000 }, horizon: null, aovs: ['depth'] },
      },
      entry = await writeMoving(options),
      bytes = readFileSync(join(out, entry.motion)),
      motion = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      centre = 8 * width + 16,
      expected = ((-0.05 * (1 / Math.tan(0.5))) / (width / height) / 3) * (width / 2);
    assert.ok(Math.abs(motion[centre * 2] - expected) < 0.01, `x ${motion[centre * 2]} against ${expected}`);
    writeFileSync(join(out, 'probes', 'low.depth.f32'), Buffer.from(floats.buffer, 0, 8));
    await assert.rejects(writeMoving(options), { name: 'RangeError' });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

const header = (extra = {}) => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 4,
  tracks: [],
  shot: {
    format: 'margo-shot',
    version: 1,
    id: 'moving-shot',
    seconds: 2,
    fps: 30,
    probes: { open: 0.5 },
    aovs: ['geometry', 'depth'],
    page: { path: 'examples/storm-light/index.html', engine: 'stormLight.engine', aovs: 'stormLight.aovs' },
    ...extra,
  },
});

test('shot.moving needs a depth scale, the depth mask, probes and a frame after each probe', () => {
  const paths = (input) => validateShot(input).map((issue) => issue.path);
  assert.deepEqual(validateShot(header({ moving: { depthScale: 200 } })), []);
  assert.deepEqual(validateShot(header({ moving: null })), []);
  assert.deepEqual(paths(header({ moving: { depthScale: 0 } })), ['shot.moving']);
  assert.deepEqual(paths(header({ moving: true })), ['shot.moving']);
  assert.deepEqual(paths(header({ moving: { depthScale: 200 }, aovs: ['geometry'] })), ['shot.aovs']);
  assert.deepEqual(paths(header({ moving: { depthScale: 200 }, probes: {} })), ['shot.moving']);
  assert.ok(paths(header({ moving: { depthScale: 200 }, probes: { open: 1.99 } })).includes('shot.probes.open'));
});

test('moving.velocity is true or false and needs an open shutter with sub-frames (KB-LOOK-TV-SHIMMER2)', () => {
  const paths = (input) => validateShot(input).map((issue) => issue.path);
  assert.deepEqual(validateShot(header({ moving: { depthScale: 200, velocity: true } })), []);
  assert.deepEqual(validateShot(header({ moving: { depthScale: 200, velocity: true }, subframes: 8, shutter: 180 })), []);
  assert.deepEqual(paths(header({ moving: { depthScale: 200, velocity: 1 } })), ['shot.moving.velocity']);
  assert.deepEqual(paths(header({ moving: { depthScale: 200, velocity: true }, subframes: 8, shutter: 0 })), [
    'shot.moving.velocity',
  ]);
});

test('TAA velocity becomes pixels over a frame: jitter out, the frame size, the sub-frame scale (KB-LOOK-TV-SHIMMER2)', () => {
  const out = mkdtempSync(join(tmpdir(), 'margo-velocity-')),
    width = 4,
    height = 2;
  try {
    const uv = new Float32Array(width * height * 2);
    for (let i = 0; i < width * height; i++) uv.set([0.01 + 0.002, -0.005 + 0.001], i * 2);
    writeFileSync(join(out, 'v.f32'), Buffer.from(uv.buffer));
    const { data } = velocityInPixels(out, { file: 'v.f32', jitter: [0.002, 0.001], scale: 16 }, width, height);
    assert.ok(Math.abs(data[0] - 0.01 * 4 * 16) < 1e-5, `x ${data[0]}`);
    assert.ok(Math.abs(data[1] + 0.005 * 2 * 16) < 1e-5, `y ${data[1]}`);
    assert.throws(() => velocityInPixels(out, { file: 'v.f32', jitter: [0, 0], scale: 1 }, 8, 2), RangeError);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('resampleVector takes each pixel the area mean of both channels, signs kept', () => {
  // 4 x 2 to 2 x 1: each output pixel the mean of a 2 x 2 block.
  const vector = Float32Array.from([1, -1, 3, -3, 5, 5, 7, 7, 1, -1, 3, -3, 5, 5, 7, 7]),
    out = resampleVector({ vector, width: 4, height: 2, outWidth: 2, outHeight: 1 });
  assert.deepEqual([...out], [2, -2, 6, 6]);
  assert.equal(resampleVector({ vector, width: 4, height: 2, outWidth: 4, outHeight: 2 }), vector);
});
