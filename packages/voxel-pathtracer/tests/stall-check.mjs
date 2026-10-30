// A GPU wait that never resolves fails the path tracer's browser check fast, naming its case and step (`npm run
// test:gpu:stall` in this package; run from the repository root after building packages). On an Intel Arc 140V the
// denoise case went silent at 172 s until the test runner killed the suite at 900 s, and nothing said which step or
// which await it was on. Here browser-check.mjs runs one denoise scene with `--stall-in-render=1` (once its first
// render starts no onSubmittedWorkDone or mapAsync settles, as on a device that stopped answering without being lost) and
// a 10 s stall limit: it must exit with an error naming the case, its step and its render well inside this script's
// own 3-minute limit. Without tests/progress.mjs the same run waits on the page's 15-minute evaluate timeout instead.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { killTree } from '../../../scripts/gpu-lock.mjs';

const LIMIT_MS = 180_000;
const t0 = performance.now();
const child = spawn(
  process.execPath,
  ['packages/voxel-pathtracer/tests/browser-check.mjs', 'denoise-diffuse', '--stall-in-render=1'],
  { env: { ...process.env, MARGO_GPU_STALL_S: '10' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  killTree(child.pid);
}, LIMIT_MS);
const code = await new Promise((resolve) => child.once('close', resolve));
clearTimeout(timer);
const seconds = (performance.now() - t0) / 1000;
assert.equal(timedOut, false, `a hung GPU wait was not detected within ${LIMIT_MS / 1000} s:\n${output}`);
assert.notEqual(code, 0, `the stalled run passed:\n${output}`);
assert.match(
  output,
  /progress denoise diffuse: reference, 480x300 at 16384 spp/,
  `the case prints its step before each render:\n${output}`,
);
assert.match(
  output,
  /denoise-diffuse: GPU stall, no GPU work finished for 1\d s \(limit 10 s, \d+ s into the case\) at step "progress denoise diffuse: reference, 480x300 at 16384 spp": renderImage 480x300 16384 spp \(#1\)/,
  `the failure names the stalled case, its step and its render:\n${output}`,
);
console.log(
  `ok - a GPU wait that never resolves fails in ${seconds.toFixed(1)} s naming its case: ${/denoise-diffuse: GPU stall[^\n]*/.exec(output)[0]}`,
);
