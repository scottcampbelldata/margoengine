// SEA-12 component proof for FW-6 and CY-9. Run under both renderers with a fixed camera.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

const backend = hardware.compat ? 'webgl2' : 'webgpu';
const output = process.env.MARGO_KEEP_LOADS_QUAY_FRAMES === '1' ? 'test-results' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (key) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: `${output}/loads-quay-${backend}-${key}.png` } : {}),
  );

function changedPixels(a, b) {
  let changed = 0;
  for (let k = 0; k < a.data.length; k += 4) {
    if (
      Math.abs(a.data[k] - b.data[k]) +
        Math.abs(a.data[k + 1] - b.data[k + 1]) +
        Math.abs(a.data[k + 2] - b.data[k + 2]) >=
      12
    )
      changed++;
  }
  return changed;
}

function visibleObjects(image) {
  let hull = 0;
  let debris = 0;
  for (let k = 0; k < image.data.length; k += 4) {
    const r = image.data[k],
      g = image.data[k + 1],
      b = image.data[k + 2];
    if (r > g + 30 && r > b + 40) hull++;
    if (g > b + 40 && r > b + 60 && r > g) debris++;
  }
  return { hull, debris };
}

try {
  await page.evaluate(async () => {
    const { createLoadsQuayScene } = await import('/packages/water/test/loads-quay-scene.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:288px';
    document.body.replaceChildren(canvas);
    window.loadsQuay = await createLoadsQuayScene(canvas);
  });
  const before = await capture('berth');
  const receipt = await page.evaluate(() => window.loadsQuay.depart());
  const unperturbed = await capture('without-wake');
  await page.evaluate(() => window.loadsQuay.restoreWake());
  const after = await capture('departure');
  const movedPixels = changedPixels(before, after),
    waterPixels = changedPixels(unperturbed, after);
  const subjects = visibleObjects(after);
  console.log(JSON.stringify({ backend, ...receipt, movedPixels, waterPixels, subjects }));
  assert.equal(receipt.replay, receipt.hash);
  assert.ok(receipt.actual.boat[0] - -3.6 > 1, 'the vessel actually leaves the berth');
  assert.ok(
    receipt.expected.boatVelocity[0] - receipt.actual.boatVelocity[0] > 0.1,
    'wake pressure changes the advancing vessel speed',
  );
  assert.ok(receipt.actual.heave > 0.04 && receipt.actual.roll > 0.04, 'the loaded debris both rises and rolls');
  assert.ok(
    Math.hypot(...receipt.actual.raft.map((value, i) => value - receipt.expected.raft[i])) > 0.01,
    'removing only the real hull wake changes the SEA-12 debris trajectory',
  );
  assert.ok(receipt.actual.nearFace.wash > 0.02, 'the quay receives incident horizontal wash');
  assert.ok(
    Math.abs(receipt.actual.nearFace.crest - receipt.expected.nearFace.crest) > 0.01,
    'the wake also changes the quay-face crest',
  );
  assert.ok(
    receipt.peakAtQuay > 0.005 && receipt.worst <= 2e-6,
    `quay wake is physically present and drawn from the same field (${receipt.peakAtQuay} m, ${receipt.worst} m residual)`,
  );
  assert.ok(
    movedPixels > 500 && waterPixels > 100,
    'the departure and its wake are separately visible at fixed camera',
  );
  assert.ok(subjects.hull > 60 && subjects.debris > 60, 'both bodies remain visible on the departure frame');
  const error = await page.evaluate(() => window.loadsQuay.dispose());
  assert.equal(error, null);

  const wall = await page.evaluate(async () => {
    const { createQuayOvertoppingScene } = await import('/packages/water/test/quay-overtopping-scene.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:288px';
    document.body.replaceChildren(canvas);
    window.quayOvertopping = await createQuayOvertoppingScene(canvas);
    return window.quayOvertopping.receipt;
  });
  assert.equal(wall.hash, wall.replay);
  assert.equal(wall.incident.spawn, undefined);
  assert.ok(wall.incident.peak < 0.08 && wall.incident.maxNormal > 0.1);
  assert.ok(wall.reflected.peak > 0.13 && wall.reflected.maxNormal < 1e-12);
  assert.ok(wall.reflected.spawn.velocity[1] > 0.45);
  assert.deepEqual(wall.reflected.spawn.position, [0, 0.11, 0]);
  assert.ok(wall.nodes > 30 && wall.maxDifference > 0.04 && wall.maxError < 2e-6);
  const reflectionOnly = await capture('wall-reflection');
  await page.evaluate(() => window.quayOvertopping.drawReflection(true));
  const imagePixels = changedPixels(reflectionOnly, await capture('wall-image-domain'));
  assert.ok(imagePixels > 500, 'the solver image domain stays off the rendered quay');
  await page.evaluate(() => window.quayOvertopping.drawReflection(false));
  await page.evaluate(() => window.quayOvertopping.showSpray());
  const droplets = changedPixels(reflectionOnly, await capture('wall-overtopping'));
  assert.ok(droplets > 3, 'the physical rising crest adds a visible spray response');
  assert.equal(await page.evaluate(() => window.quayOvertopping.dispose()), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ backend, ...wall, imagePixels, droplets }));

  const finite = await page.evaluate(async () => {
    const { createFiniteWakeMaskScene } = await import('/packages/water/test/quay-overtopping-scene.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:288px';
    document.body.replaceChildren(canvas);
    window.finiteWake = await createFiniteWakeMaskScene(canvas);
    return window.finiteWake.receipt;
  });
  for (const phase of [finite.initial, finite.stepped]) {
    assert.equal(phase.vertices, 65 ** 2);
    assert.ok(phase.maxHeightError < 2e-6 && phase.maxNormalError < 3e-6, JSON.stringify(phase));
  }
  const { tie, closed, open, oneSidedX } = finite.initial.corner;
  assert.ok(Math.abs(tie - 0.2) < 2e-6 && Math.abs(closed - 0.2) < 2e-6);
  assert.ok(Math.abs(open - 0.28) < 2e-6, 'the diagonal is reachable when the open Z face is hit first');
  assert.ok(oneSidedX < -0.1, 'the wall uses a one-sided rising wake normal');
  assert.ok(Math.abs(finite.stepped.corner.open - open) > 1e-6, 'drawn heights update while the mask stays fixed');
  const masked = await capture('finite-mask');
  await page.evaluate(() => window.finiteWake.drawWithoutMask());
  const withoutMask = await capture('finite-unmasked');
  await page.evaluate(() => window.finiteWake.drawBackground());
  const clear = await capture('finite-clear');
  const differenceAt = (a, b, [x, z]) => {
    let difference = 0;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const at = ((z + dz) * a.width + x + dx) * 4;
        for (let n = 0; n < 3; n++) difference += Math.abs(a.data[at + n] - b.data[at + n]);
      }
    }
    return difference / 147;
  };
  const pixelProof = {
    dry: differenceAt(masked, clear, finite.probes.dry),
    originalDry: differenceAt(withoutMask, clear, finite.probes.dry),
    wet: differenceAt(masked, clear, finite.probes.wet),
    beyond: differenceAt(masked, clear, finite.probes.beyond),
  };
  assert.ok(pixelProof.dry < 1 && pixelProof.originalDry > 12, JSON.stringify(pixelProof));
  assert.ok(pixelProof.wet > 12 && pixelProof.beyond > 12, JSON.stringify(pixelProof));
  assert.equal(await page.evaluate(() => window.finiteWake.dispose()), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ backend, ...finite, pixelProof }));
} finally {
  await closeAll({ browser });
}
