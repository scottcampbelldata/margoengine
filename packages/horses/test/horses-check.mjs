// Real-GPU check of @margoengine/horses (WebGPU, or the WebGL2 compatibility layer with MARGO_COMPAT=1): addHorse
// draws a skinned, hair-shaded cavalry horse that eases into a trot, whose film time seeks to exactly the pose chunked
// play reaches and whose saddle carries a rider seat; addHorseCrowd draws 60 horses of a formations army in one crowd.
// Run from the repository root after building packages, under a hard limit:
//   node scripts/run-with-timeout.mjs --max 10 -- node packages/horses/test/horses-check.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const port = 5323,
  context = await openBrowser({ startPath: '/packages/horses/test/horses-check.html', port }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
console.log('device', context.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
const coverage = async (bytes) => {
  const image = await decodePNG(new Uint8Array(bytes)),
    channels = image.data.length / (image.width * image.height);
  let n = 0;
  for (let i = 0; i < image.data.length; i += channels)
    if (Math.abs(image.data[i] - 0x30) + Math.abs(image.data[i + 1] - 0x33) + Math.abs(image.data[i + 2] - 0x3a) > 30)
      n++;
  return n / (image.width * image.height);
};
try {
  await page.goto(`http://127.0.0.1:${port}/packages/horses/test/horses-check.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
  const h = await page.evaluate(() => window.check.horse());
  // HORSES_PNG_DIR=<folder> keeps the frames for a look.
  const keep = (name, bytes) =>
    process.env.HORSES_PNG_DIR && writeFileSync(join(process.env.HORSES_PNG_DIR, name), new Uint8Array(bytes));
  keep('horse.png', h.bytes);
  assert.deepEqual(h.errors, []);
  const c = await coverage(h.bytes);
  console.log(
    'horse covers',
    (100 * c).toFixed(1),
    'percent; gait',
    h.played.gait,
    'speed',
    h.played.speed.toFixed(2),
    'saddle rise',
    h.rise.toFixed(3),
  );
  assert.ok(c > 0.05, 'the horse is drawn');
  assert.equal(h.played.gait, 'trot');
  assert.ok(Math.abs(h.played.speed - 4) < 1e-9);
  assert.equal(h.sought.pose, h.played.pose, 'a seek to 2.5 s gives the pose of playing to 2.5 s in 1/30 s chunks');
  assert.equal(h.sought.frame, h.played.frame);
  h.sought.hip.forEach((v, i) => assert.ok(Math.abs(v - h.played.hip[i]) < 1e-9, 'the rider hip replays too'));
  assert.ok(h.rise > 0.03 && h.rise < 0.15, 'the rider rides the trot: the hip rises and falls with the back');
  assert.deepEqual(h.clips, ['stand', 'walk', 'trot', 'canter', 'gallop']);
  assert.equal(h.after, false, 'disposed, the Animation is off the engine');
  const motion = await page.evaluate(() => window.check.motion());
  assert.deepEqual(motion.errors, []);
  assert.ok(motion.gaits.includes('gallop') && motion.gaits.includes('stand') && motion.gaits.includes('trot'));
  assert.equal(motion.stopSpeed, 0, 'the horse came to a full stop before restarting');
  assert.ok(
    motion.maxRestartStep < 0.05,
    `largest starting or restarting limb step: ${motion.maxRestartStep} m at 120 Hz (${JSON.stringify(motion.largestRestart)})`,
  );
  assert.ok(motion.maxGallopStep < 0.14, `largest galloping limb step: ${motion.maxGallopStep} m at 120 Hz`);
  assert.ok(motion.tailSweep > 0.18, `the tail moved laterally by ${motion.tailSweep} m`);
  for (const [name, bytes] of Object.entries(motion.shots)) keep(`${name}.png`, bytes);
  assert.equal(motion.replayGallop, motion.samples[2].pose, 'a gallop pose replays through interrupted transitions');
  assert.equal(motion.replayTail, motion.samples[0].pose, 'a tail flick replays at its original film time');
  console.log(
    'restart continuity',
    motion.maxRestartStep.toFixed(4),
    'm/step; tail sweep',
    motion.tailSweep.toFixed(3),
    'm',
  );
  const authored = await page.evaluate(() => window.check.authored());
  assert.deepEqual(authored.errors, []);
  assert.ok(authored.adopted, 'an imported, weighted horse is posed by the live gait controller');
  assert.ok(
    authored.fitted > 0.4 && authored.fitted < 0.95,
    `tight limb reach shortens the stride: ${authored.fitted}`,
  );
  assert.ok(authored.lowest > -0.01, `the fitted hooves remain above the ground during a start: ${authored.lowest}`);
  assert.ok(authored.callerOwns, 'the caller keeps its authored model after the controller is disposed');
  const herd = await page.evaluate(() => window.check.herd());
  keep('herd.png', herd.bytes);
  assert.deepEqual(herd.errors, []);
  const hc = await coverage(herd.bytes);
  console.log('herd covers', (100 * hc).toFixed(1), 'percent;', herd.count, 'horses,', herd.bones, 'bones');
  assert.equal(herd.count, 60);
  assert.ok(hc > 0.01, 'the herd is drawn');
  // The wedge canters (6 m/s), the line trots (3.5 m/s).
  assert.ok(herd.gaits.slice(0, 25).every((g) => herd.clips[g] === 'canter'));
  assert.ok(herd.gaits.slice(25).every((g) => herd.clips[g] === 'trot'));
  // Every rider seat sits on its horse's back, read back from the bone texture the GPU drew with.
  for (const [dx, y, dz] of herd.seats) {
    assert.ok(Math.hypot(dx, dz) < 0.6, 'the seat is over the horse');
    assert.ok(y > 0.85 * herd.withers && y < 1.1 * herd.withers, `seat height ${y.toFixed(2)} m`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('horses check passed');
} finally {
  await context.close();
}
