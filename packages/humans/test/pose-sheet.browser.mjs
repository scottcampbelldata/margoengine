// Renders pose-sheet.html: a person in ten poses, each from the front, the three-quarter and the side, with the pose
// checker's verdict beside each row and a dot on each joint it names, then every clip checked frame by frame (as
// played and raw). With no model the person is the code-built body of rigged-body.js through addBody;
// `--model=<file.glb>` draws a loaded person (textures stripped; `--bare` leaves out its clothes so the joints show).
// Writes test-results/humans/pose-sheet-<name>-<backend>.png and a .txt report beside it; `--out=<dir>` writes there.
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/humans/test/pose-sheet.browser.mjs [--model=x.glb]
// Fails on a GPU or page error, on a row the fitted body draws past a stop (every played or held pose is kept inside
// the stops, so an error there is a fault of the solvers or of the checker).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { STRIP, prepare } from './glb-prepare.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const modelFile = arg('model'),
  bare = process.argv.includes('--bare'),
  strip = arg('strip') ? new RegExp(arg('strip'), 'i') : STRIP,
  outDir = arg('out') ?? 'test-results/humans';

mkdirSync('test-results/humans', { recursive: true });
mkdirSync(outDir, { recursive: true });
let url = null,
  name = 'addbody';
if (modelFile) {
  name = basename(modelFile, '.glb') + (bare ? '-bare' : '');
  writeFileSync(
    'test-results/humans/pose-sheet-model.glb',
    prepare(new Uint8Array(readFileSync(modelFile)), { bare, strip }),
  );
  url = '/test-results/humans/pose-sheet-model.glb';
}
const { page, close, hardware } = await openBrowser({
  startPath: '/packages/humans/test/pose-sheet.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const backend = hardware.compat ? 'webgl2' : 'webgpu',
    result = await page.evaluate((model) => window.renderSheet({ model }), url),
    file = join(outDir, `pose-sheet-${name}-${backend}.png`),
    png = Buffer.from(result.png, 'base64');
  writeFileSync(file, png);
  const text = [
    `Pose sheet: ${name} on ${backend}; stature ${result.stature.toFixed(3)}, rest pose ${result.restPose}, ground ${result.ground.toFixed(3)}`,
    `Proportions: ${result.proportions.length ? result.proportions.join('; ') : 'all inside their bands'}`,
    '',
    ...result.report.flatMap((row) => [
      `${row.row}: ${row.passed ? 'passes' : 'FAILS'} (${row.errors} errors, ${row.warnings} warnings)`,
      ...row.issues.map((line) => `  ${line}`),
      `  arms (flexion/abduction/rotation): ${row.arms.filter(Boolean).join('; ')}`,
    ]),
    '',
    ...result.clips.flatMap((clip) => [`Clip ${clip.clip}, ${clip.variant}:`, clip.text, '']),
  ].join('\n');
  writeFileSync(file.replace(/\.png$/, '.txt'), text);
  console.log(`${backend}: ${file}, ${png.length} bytes`);
  console.log(text);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  for (const row of result.report) {
    // An IK reach keeps the arm out of the body (KB-RIG-REACHTRUNK1).
    if (/\(IK/.test(row.row))
      assert.ok(!row.issues.some((line) => /^error self-penetration/.test(line)), `${row.row}: a limb passes through the body`);
    assert.ok(
      !row.issues.some((line) => /^error (out-of-range|hinge-|twist-)/.test(line)),
      `${row.row}: a pose the fitted body drew is past a stop`,
    );
  }
} finally {
  await close();
}
