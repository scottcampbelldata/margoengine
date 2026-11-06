// Real-GPU checks of @margoengine/rigging (from the repository root after building packages, one GPU job at a time):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/rigging/tests/rigging-browser.mjs
// rigging-browser.ts weights, poses and checks meshes with this package; @margoengine/animation skins them on the GPU
// and the engine draws them; this script checks the drawn pixels against the CPU pose. Every case has a time limit.
// Results go to test-results/rigging-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

// The dev server serves the repository root, whichever folder `npm run test:browser` starts in.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const CASE_TIMEOUT = 120_000;
const release = await acquire({ owner: 'rigging-browser' });
const context = await openBrowser({ startPath: '/packages/rigging/tests/rigging.html', port: 5247 });
const { page, hardware } = context,
  pageErrors = [],
  results = {},
  checks = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
page.setDefaultTimeout(CASE_TIMEOUT);
/** Runs one fixture case within CASE_TIMEOUT; fails on any WebGPU or engine error it reports. */
async function run(name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`rigging case ${name} took over ${CASE_TIMEOUT / 1000} s`)),
      CASE_TIMEOUT,
    );
  });
  try {
    const { result, errors } = await Promise.race([page.evaluate((n) => window.riggingFixture.run(n), name), timeout]);
    assert.deepEqual(errors, [], `${name}: WebGPU or engine errors`);
    results[name] = result;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
const check = (name, value, detail) => {
  assert.ok(value, `${name}: ${JSON.stringify(detail)}`);
  checks.push(name);
};
try {
  await page.waitForFunction(() => window.riggingFixture, null, { timeout: CASE_TIMEOUT });
  assert.equal(hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');

  const w = await run('weights');
  check('bone heat weights pass the export checks', w.report.ok, w.report.issues);
  check('the straight tube is drawn upright', w.straightTip && !w.straightSide, w);
  check('GPU skinning with the solved weights bends the upper half to the side', w.bentSide && !w.bentTip, w);
  check('the lower half stays put', w.base, w);
  check('the drawn bend matches the CPU pose (97% of centroids)', w.inside >= 0.97 * w.total && w.total > 100, w);

  const k = await run('ik');
  const gap = Math.hypot(k.tip[0] - 0.9, k.tip[1] + 0.4, k.tip[2]);
  check('solveSkeletonIK puts the tip on the target', k.reached && gap < 1e-3, k);
  check('the elbow bends toward the pole (-x side)', k.elbow[0] < 0, k);
  check('the GPU-skinned tip is drawn at the target, not upright', k.drawnNearTarget && !k.straightTipDrawn, k);
  check('the drawn IK pose matches the CPU pose (97% of centroids)', k.inside >= 0.97 * k.total && k.total > 100, k);

  const v = await run('vrm');
  check('the real VRM is drawn', v.drawn > 2000, v);
  check('its expressions reach the picture: morphs and the moved face texture', v.face > 20, v);
  check('back at neutral the picture returns', v.restored <= 2, v);
  check('its spring bones swing the drawn hair', v.swung > 10, v);

  assert.deepEqual(pageErrors, []);
  for (const name of checks) console.log(`ok - ${name}`);
  console.log(`${checks.length} rigging browser checks passed (bone heat ${results.weights.solveMs.toFixed(1)} ms)`);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/rigging-browser.json', JSON.stringify({ hardware, results, checks }, null, 2));
} finally {
  await context.close();
  release();
}
