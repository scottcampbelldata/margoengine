// KB-FILM-SKYADD1 on a real GPU (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/sky/test/sky-add-gltf-check.mjs
// A glTF model with transmission given the sky's ambient by sky.add before the first frame, under a sunlit bruneton
// sky with clouds, agx tone mapping and shadows: it is drawn from frame 0 on, frame 0 is drawn as every later frame
// of the same instant, and two fresh pages draw the same frames; then the same with a weather drive raining and the
// clock moving 1/30 s a frame. MODEL=<http URL> checks another model (Film Studio used the Khronos Car Concept).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const port = 5231,
  context = await openBrowser({ startPath: '/packages/sky/test/sky-add-gltf-check.html', port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const run = async (query) => {
  await page.goto(`http://127.0.0.1:${port}/packages/sky/test/sky-add-gltf-check.html?${query}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  return page.evaluate(() => window.check.run(6));
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  for (const [name, extra] of [
    ['still', ''],
    ['rain, moving clock', '&weather=rain&delta=0.0333333'],
  ]) {
    const q = extra + (process.env.MODEL ? `&model=${encodeURIComponent(process.env.MODEL)}` : ''),
      empty = await run(`mode=empty${q}`),
      none = await run(`mode=none${q}`),
      add = await run(`mode=add${q}`),
      again = await run(`mode=add${q}`),
      auto = await run(`mode=auto${q}`);
    for (const r of [empty, none, add, again, auto]) {
      assert.deepEqual(r.errors, [], `${name} ${r.mode}: GPU errors`);
      console.log(name, r.mode, r.frames.map((f) => `${f.digest}:${f.mid.toFixed(2)}`).join(' '));
    }
    for (const [i, f] of add.frames.entries()) {
      assert.notEqual(
        none.frames[i].mid,
        empty.frames[i].mid,
        `${name}: the model shows on frame ${i} left out of the sky`,
      );
      assert.notEqual(f.mid, empty.frames[i].mid, `${name}: the model shows on frame ${i} with sky.add`);
      assert.notEqual(f.digest, none.frames[i].digest, `${name}: sky.add changes the model's light on frame ${i}`);
    }
    assert.deepEqual(
      add.frames.map((f) => f.digest),
      again.frames.map((f) => f.digest),
      `${name}: two fresh pages draw the same frames`,
    );
    // KB-GLTF-SCENESKY1: with no sky.add the model joins its scene's sky by itself, from frame 0.
    assert.deepEqual(
      auto.frames.map((f) => f.digest),
      add.frames.map((f) => f.digest),
      `${name}: the model joins its scene's sky without sky.add`,
    );
    if (!extra)
      assert.deepEqual(
        add.frames.map((f) => f.digest),
        add.frames.map(() => add.frames[5].digest),
        'frame 0 is drawn as every later frame of the same instant',
      );
  }
  assert.deepEqual(pageErrors, []);
  console.log('sky add glTF check passed');
} finally {
  await context.close();
}
