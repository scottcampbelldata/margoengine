// `npm run test:shot` part 3 (WebGPU): the moving look evidence of a real shot (T4 shimmerMoving, T8 motionBlur). The
// Storm Light tour is rendered at 270 x 480 with the camera moving 40 m in one second, and shot.moving asks each probe
// for the frame after it and the camera's motion. The motion must be real: the world moves by tens of pixels, and the
// frame warped by it differs from the next frame far less than the frame left alone does (rain, sea and cloud change
// between frames and keep a residue). Needs `npm run build:packages` first.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePNG } from '@margoengine/headless/compare';
import { shimmerMoving } from '@margoengine/headless/look';
import { parseShot } from '../shot-file.mjs';
import { shoot } from '../render.mjs';
import { lookShot } from '../look.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.chdir(root);
const json = JSON.parse(readFileSync(join(root, 'tools/shot/shots/storm-light-tour.json'), 'utf8'));
json.duration = 7;
json.markers = [];
json.tracks[0].keys = [json.tracks[0].keys[0], { ...json.tracks[0].keys[1], time: 1, position: [10, 3.5, 50] }];
json.shot = {
  ...json.shot,
  id: 'storm-moving-small',
  size: [270, 480],
  supersample: 1,
  fps: 30,
  seconds: 1,
  probes: { open: 0.5 },
  probeLookBounds: {},
  moving: { depthScale: 200 },
};
const out = join(root, 'test-results', 'shots', 'storm-moving-check');
rmSync(out, { recursive: true, force: true });
const manifest = await shoot(parseShot(json), { out, runs: 1, log: () => {} });
const probe = manifest.probes.open;
assert.deepEqual(Object.keys(probe.moving ?? {}), ['next', 'motion'], 'the probe names the next frame and its motion');
const frame = await decodePNG(readFileSync(join(out, probe.file))),
  next = await decodePNG(readFileSync(join(out, probe.moving.next))),
  bytes = readFileSync(join(out, probe.moving.motion)),
  data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
assert.equal(data.length, frame.width * frame.height * 2, 'one x, y pair per pixel');
let sum = 0;
for (let i = 0; i < data.length; i += 2) sum += Math.hypot(data[i], data[i + 1]);
const mean = sum / (data.length / 2);
assert.ok(mean > 5, `the camera moves the world by ${mean.toFixed(2)} px on average`);
const motion = (values) => ({ width: frame.width, height: frame.height, data: values }),
  warped = shimmerMoving(frame, { next, motion: motion(data) }),
  still = shimmerMoving(frame, { next, motion: motion(new Float32Array(data.length)) });
assert.ok(
  warped.value < 0.6 * still.value,
  `warped ${warped.value.toFixed(1)} % against ${still.value.toFixed(1)} % unwarped`,
);
const report = await lookShot(out, manifest),
  rows = report.json.probes[0].results.map((row) => row.check);
for (const name of ['shimmerMoving', 'motionBlur'])
  assert.ok(rows.includes(name), `${name} runs on the written evidence`);
console.log(
  `ok moving: ${mean.toFixed(1)} px mean camera motion, shimmerMoving ${warped.value.toFixed(1)} % warped against ${still.value.toFixed(1)} % unwarped`,
);
