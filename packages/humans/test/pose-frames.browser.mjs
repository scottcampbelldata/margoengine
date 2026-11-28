// Renders pose-frames.html: a skinned person walking, reaching with IK and sitting, from the front, the three-quarter
// and the side, on its fitted body and with limits off, and checks the fitted body's elbows and knees never bend past
// straight. With no model the person is the code-built body of rigged-body.js through addBody; `--model=<file.glb>`
// draws a loaded person instead (textures are stripped, and `--bare` leaves out the meshes whose material matches
// `--strip`, default garments and boots, so the joints show). Writes test-results/humans/pose-frames-<name>-<backend>.png.
//   node scripts/run-with-timeout.mjs --max=8 -- node packages/humans/test/pose-frames.browser.mjs [--model=x.glb --bare]
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { STRIP, prepare } from './glb-prepare.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const modelFile = arg('model'),
  bare = process.argv.includes('--bare'),
  strip = arg('strip') ? new RegExp(arg('strip'), 'i') : STRIP;

mkdirSync('test-results/humans', { recursive: true });
let url = null,
  name = 'addbody';
if (modelFile) {
  name = basename(modelFile, '.glb') + (bare ? '-bare' : '');
  writeFileSync('test-results/humans/pose-frames-model.glb', prepare(new Uint8Array(readFileSync(modelFile)), { bare, strip }));
  url = '/test-results/humans/pose-frames-model.glb';
}
const { page, close, hardware } = await openBrowser({
  startPath: '/packages/humans/test/pose-frames.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const backend = hardware.compat ? 'webgl2' : 'webgpu',
    result = await page.evaluate((model) => window.renderFrames({ model }), url),
    file = `test-results/humans/pose-frames-${name}-${backend}.png`,
    png = Buffer.from(result.png, 'base64');
  writeFileSync(file, png);
  console.log(`${backend}: ${file}, ${png.length} bytes`);
  for (const row of result.report)
    console.log(
      ' ',
      row.variant,
      '|',
      row.pose,
      '|',
      JSON.stringify(row.hinges),
      '| outside',
      row.outside,
      'structural',
      row.structural,
      row.stops.join('; '),
    );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  // The fitted body holds every pose inside the stops no body passes, and its reach never bends an elbow past
  // straight; free, the pole behind turns the arm past a stop (the fault this guards against).
  const fitted = result.report.filter((row) => row.variant === 'fitted body'),
    reach = (variant) => result.report.find((row) => row.variant === variant && /reach/.test(row.pose)).hinges;
  for (const row of fitted) assert.equal(row.structural, 0, `${row.pose}: ${row.structural} motions past a stop`);
  assert.ok(
    Math.min(reach('fitted body').l_elbow, reach('fitted body').r_elbow) > -1,
    JSON.stringify(reach('fitted body')),
  );
  assert.ok(
    result.report.find((row) => row.variant === 'limits: false' && /reach/.test(row.pose)).structural > 0,
    'the free reach no longer shows the fault',
  );
} finally {
  await close();
}
