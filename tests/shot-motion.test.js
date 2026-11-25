// The `moving` evidence of the shot tool (tools/shot/motion.mjs): the depth mask turned back into distances, the motion
// of a still world seen by a moving camera written beside the probe, and the shot header rules for `moving`. Plain data:
// no browser and no GPU (tools/shot/test/moving-check.mjs renders a real shot).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePNG } from '@margoengine/headless';
import { SKY_DISTANCE, distanceFromNearness, writeMoving } from '../tools/shot/motion.mjs';
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
