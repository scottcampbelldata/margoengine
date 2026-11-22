// KB-ENV-AMBIENT-DUP1 on a real GPU (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/sky/test/sky-environment-check.mjs
// A sky that lights the scene (lighting.ambient) beside an EnvironmentLighting from an HDR: the environment owns the
// ambient term of core's shader, so the frame compiles and draws with no GPU error (two `let margoAmbient=` lost the
// GPU before); the sky alone lights a glTF box (sky.add) as it lights a core box of the same grey, so library models
// are not darker than the ground under the sky; a glTF box with no sky.add joins its scene's sky by itself and draws
// the same frames (KB-GLTF-SCENESKY1), unless model.sceneSky is false. SHOT=<file.png> saves the env frame.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
const port = 5233,
  context = await openBrowser({ startPath: '/packages/sky/test/sky-environment-check.html', port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const run = async (mode) => {
  await page.goto(`http://127.0.0.1:${port}/packages/sky/test/sky-environment-check.html?mode=${mode}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const result = await page.evaluate(() => window.check.run(4));
  if (process.env.SHOT) writeFileSync(`${process.env.SHOT}-${mode}.png`, await page.locator('canvas').screenshot());
  return result;
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  const sky = await run('sky'),
    env = await run('env'),
    auto = await run('auto'),
    off = await run('off');
  for (const r of [sky, env, auto, off]) {
    console.log(
      r.mode,
      r.frames
        .map((f) => `${f.digest} core ${f.core.map((v) => v.toFixed(1))} gltf ${f.gltf.map((v) => v.toFixed(1))}`)
        .join(' | '),
    );
    assert.deepEqual(r.errors, [], `${r.mode}: GPU errors`);
    // Frames at one instant are the same frame.
    assert.deepEqual(
      r.frames.map((f) => f.digest),
      r.frames.map(() => r.frames[3].digest),
      `${r.mode}: stable frames`,
    );
  }
  const s = sky.frames[3],
    e = env.frames[3];
  // The sky lights the glTF box's top as it lights the core box's: within 4 of 255 per channel, and both well lit.
  for (let i = 0; i < 3; i++) {
    assert.ok(s.core[i] > 60, `sky: the core box's top is lit (${s.core[i]})`);
    assert.ok(Math.abs(s.core[i] - s.gltf[i]) <= 4, `sky: glTF ${s.gltf[i]} against core ${s.core[i]} in channel ${i}`);
  }
  // KB-GLTF-SCENESKY1: without sky.add the glTF box is lit by its scene's sky all the same, from the first frame; with
  // sceneSky false it keeps the built-in ambient (what every model had before).
  assert.deepEqual(
    auto.frames.map((f) => f.digest),
    sky.frames.map((f) => f.digest),
    "a glTF model joins its scene's sky by itself",
  );
  assert.deepEqual(off.frames[3].core, s.core, 'the core box is lit the same with the model left out');
  assert.notDeepEqual(off.frames[3].gltf, s.gltf, 'sceneSky false leaves the glTF box out of the sky');
  // The environment takes the ambient: both boxes change from the sky-only frame, and both stay lit.
  assert.notDeepEqual(e.core, s.core, 'the IBL lights the core box');
  assert.notDeepEqual(e.gltf, s.gltf, 'the IBL lights the glTF box');
  for (const v of [...e.core, ...e.gltf]) assert.ok(v > 20, `env: lit (${v})`);
  assert.deepEqual(pageErrors, []);
  console.log('sky environment check passed');
} finally {
  await context.close();
}
