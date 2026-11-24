// Real-adapter check (run from the repository root after building packages): node packages/shader/test/deform-check.mjs
// Skinning and morph nodes against the same mesh deformed on the CPU: position, chained deformation, an effect on top,
// normals, a new pose, the shadow, and positionLocal on vertices a compute deformer already moved. Then Fox.glb, a real
// glTF character: skinningFromModel against Animation's compute deformer, at two frames of its clip.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/deform-check.html', port: 5229 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const grab = async (name) => {
  const { errors } = await page.evaluate((n) => window.check.run(n), name);
  assert.deepEqual(errors, [], name);
  const image = await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(() => window.check.clear());
  return image;
};
// Fraction of pixels that differ, and of pixels that are not the background, so an empty picture cannot pass.
const compare = (a, b) => {
  let different = 0,
    drawn = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] + a.data[i + 1] + a.data[i + 2] > 30) drawn++;
    if ([0, 1, 2].some((k) => Math.abs(a.data[i + k] - b.data[i + k]) > 8)) different++;
  }
  return { different: different / (a.data.length / 4), drawn: drawn / (a.data.length / 4) };
};
const same = async (name, reference) => {
  const { different, drawn } = compare(await grab(reference), await grab(name));
  assert.ok(drawn > 0.05, `${reference} draws something: ${drawn}`);
  assert.ok(different < 0.004, `${name} matches ${reference}: ${different} of the pixels differ`);
  console.log('ok', name, different.toFixed(5));
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  const { different } = compare(await grab('cpuSkin'), await grab('cpuBind'));
  assert.ok(different > 0.05, `the pose moves the mesh: ${different}`);
  await same('skin', 'cpuSkin');
  await same('morph', 'cpuMorph');
  await same('chain', 'cpuChain');
  await same('effect', 'cpuEffect');
  for (const [stale, right] of [['cpuStaleNormal', 'cpuNormal'], ['cpuMorphStaleNormal', 'cpuMorphNormal']]) {
    const { different: moved } = compare(await grab(right), await grab(stale));
    assert.ok(moved > 0.05, `the normals move the picture in ${right}: ${moved}`);
  }
  await same('normal', 'cpuNormal');
  await same('morphNormal', 'cpuMorphNormal');
  await same('scaledNormal', 'cpuScaledNormal');
  await same('rigidNeighbours', 'cpuRigid');
  await same('newPose', 'cpuNewPose');
  await same('shadow', 'cpuShadow');
  await same('deformed', 'cpuDeformed');
  const { different: posed } = compare(await grab('foxCompute'), await grab('foxBind'));
  assert.ok(posed > 0.005, `the clip moves the Fox: ${posed}`);
  await same('foxNodes', 'foxCompute');
  const { different: later } = compare(await grab('foxNodes'), await grab('foxLaterNodes'));
  assert.ok(later > 0.005, `a later frame moves the node skin: ${later}`);
  await same('foxLaterNodes', 'foxLaterCompute');
  assert.deepEqual(pageErrors, []);
  console.log('deform check passed');
} finally {
  await context.close();
}
