import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close } = await openBrowser({
  startPath: '/packages/physics/tests/volumetric-solids.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.renderRung === 'function', null, { timeout: 20_000 });
  for (const solver of ['vertex-block', 'projective']) {
    const bare = await page.evaluate((solver) => window.renderRung({ loaded: false, solver }), solver);
    const before = await page.locator('canvas').screenshot();
    const loaded = await page.evaluate((solver) => window.renderRung({ loaded: true, solver }), solver);
    const after = await page.locator('canvas').screenshot();
    assert.ok(loaded.y < bare.y && loaded.support > 0);
    assert.ok(loaded.visible >= 5 && bare.visible === loaded.visible);
    assert.notDeepEqual(after, before, 'the lone change at equal framing is the rendered rung geometry');
    const replay = await page.evaluate((solver) => window.renderRung({ loaded: true, showBoot: true, solver }), solver);
    assert.equal(replay.hash, loaded.hash);
    console.log(
      `LH-4 ${solver} sag ${((bare.y - loaded.y) * 1000).toFixed(2)} mm, reaction ${loaded.support.toFixed(2)} N, ${loaded.hash}`,
    );
    const authored = { loaded: true, solver, fiber: { direction: [1, 0, 0], modulus: 1e7 } };
    const reinforced = await page.evaluate((settings) => window.renderRung(settings), authored);
    assert.ok(reinforced.support > 0);
    assert.notEqual(reinforced.y, loaded.y);
    assert.notDeepEqual(await page.locator('canvas').screenshot(), after);
    console.log(`LH-4 ${solver} with grain, y=${reinforced.y.toFixed(6)} m, ${reinforced.hash}`);
    if (solver === 'vertex-block') {
      const settings = {
        loaded: true,
        solver,
        orthotropy: {
          youngsModuli: [12e6, 816e3, 600e3],
          shearModuli: [768e3, 936e3, 84e3],
          poissonRatios: [0.292, 0.449, 0.39],
        },
      };
      const timber = await page.evaluate((settings) => window.renderRung(settings), settings);
      const image = await page.locator('canvas').screenshot();
      assert.ok(Number.isFinite(timber.y) && timber.support > 0);
      assert.notEqual(timber.y, loaded.y);
      assert.notDeepEqual(image, after);
      const timberReplay = await page.evaluate((settings) => window.renderRung(settings), settings);
      assert.equal(timberReplay.hash, timber.hash);
      assert.deepEqual(await page.locator('canvas').screenshot(), image);
      console.log(`LH-4 orthotropic timber y=${timber.y.toFixed(6)} m, ${timber.hash}`);
    }
  }
  const intact = await page.evaluate(() => window.renderRung({ loaded: true, showBoot: true, solver: 'vertex-block' }));
  const intactImage = await page.locator('canvas').screenshot();
  const cut = await page.evaluate(() => window.renderLadderCut());
  const cutImage = await page.locator('canvas').screenshot();
  assert.equal(cut.visible, intact.visible + 1);
  assert.ok(cut.boot[1] < intact.bootHeight);
  assert.notDeepEqual(cutImage, intactImage);
  const afterCut = await page.evaluate(() => window.renderLadderCut());
  assert.equal(afterCut.hash, cut.hash);
  assert.deepEqual(await page.locator('canvas').screenshot(), cutImage);
  console.log(`LH-4 oblique cut, boot y=${cut.boot[1].toFixed(6)} m, ${cut.hash}`);
  const uncut = await page.evaluate(() =>
    window.renderRung({ loaded: true, showBoot: true, solver: 'vertex-block', frame: 145 }),
  );
  const uncutImage = await page.locator('canvas').screenshot();
  const incision = await page.evaluate(() => window.renderLadderCut(true));
  const incisionImage = await page.locator('canvas').screenshot();
  assert.equal(incision.pieces, 1);
  assert.ok(incision.boot[1] < uncut.bootHeight);
  assert.notDeepEqual(incisionImage, uncutImage);
  const replayIncision = await page.evaluate(() => window.renderLadderCut(true));
  assert.equal(replayIncision.hash, incision.hash);
  assert.deepEqual(await page.locator('canvas').screenshot(), incisionImage);
  console.log(`LH-4 finite incision, boot y=${incision.boot[1].toFixed(6)} m, ${incision.hash}`);
  await page.evaluate(() => window.renderRung({ loaded: true, showBoot: true, solver: 'vertex-block', frame: 18 }));
  const intactRung = await page.locator('canvas').screenshot();
  const fractured = await page.evaluate(() => window.renderLoadedFracture());
  const fractureImage = await page.locator('canvas').screenshot();
  assert.ok(fractured.firstCrack.support > 0 && fractured.fractures > 1);
  assert.ok(fractured.cells > 240);
  assert.notDeepEqual(fractureImage, intactRung);
  assert.deepEqual(await page.evaluate(() => window.renderLoadedFracture()), fractured);
  assert.deepEqual(await page.locator('canvas').screenshot(), fractureImage);
  console.log(
    `LH-4 load-driven fracture, first step ${fractured.firstCrack.step}, ${fractured.fractures} advances, ${fractured.hash}`,
  );
  assert.deepEqual(errors, []);
} finally {
  await close();
}
