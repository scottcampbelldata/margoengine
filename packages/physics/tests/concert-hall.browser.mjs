import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const uncaught = [];
page.on('pageerror', (error) => uncaught.push(error.message));
const output =
  process.env.MARGO_KEEP_CONCERT_HALL_FRAMES === '1' ? 'packages/physics/test-results/concert-hall' : undefined;
if (output) await mkdir(output, { recursive: true });
const at = (frame, restore = false) => page.evaluate(([f, action]) => window.hall.at(f, action), [frame, restore]);
const shot = async (frame, name, restore = false) => {
  const state = await at(frame, restore);
  const image = await decodePNG(
    await page
      .locator('canvas')
      .screenshot(output && name ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );
  return { ...state, image };
};

function near(actual, expected, bound = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= bound, `Expected ${actual} within ${bound} of ${expected}`);
}

function colorCount(image, [x, y], gold) {
  const radius = 6;
  const cx = Math.round(x);
  const cy = Math.round(y);
  let count = 0;
  for (let j = cy - radius; j <= cy + radius; j++) {
    for (let i = cx - radius; i <= cx + radius; i++) {
      const p = 4 * (j * image.width + i);
      const [r, g, b] = image.data.subarray(p, p + 3);
      if (gold ? r > 207 && g > 110 && b < 142 : g > 145 && b > 150 && g > 1.45 * r) count++;
    }
  }
  return count;
}

try {
  const setup = await page.evaluate(async () => {
    const { mountHall } = await import('/packages/physics/tests/fixtures/concert-hall.js');
    window.hall = await mountHall();
    return window.hall.setup;
  });
  const {
    cue,
    end,
    slowdown,
    source,
    receiver,
    speed,
    sampleRate,
    emissionSample,
    echo,
    direct,
    pcm,
    crossing,
    target,
  } = setup;
  assert(setup.count > 2, 'The audio response includes floor and wall reflections beside the two paths shown.');

  // Unfold both true planar specular reflections into one image-source segment. Allen & Berkley (1979),
  // JASA 65, 943–950; Borish (1984), JASA 75, 1827–1836. Equal-angles is independent of screen projection.
  const reflectedSource = [-source[0], source[1], -source[2]];
  const unfolded = receiver.map((v, i) => v - reflectedSource[i]);
  const atX = source[0] / unfolded[0];
  const atZ = source[2] / unfolded[2];
  const hypot = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const firstCrossing = [0, source[1] + atX * unfolded[1], source[2] - atX * unfolded[2]];
  const secondCrossing = [atZ * unfolded[0] - source[0], source[1] + atZ * unfolded[1], 0];
  const checks = [
    { path: direct, length: hypot(source, receiver), strength: 1 },
    { path: echo, length: Math.hypot(...unfolded), strength: 0.65 * 0.64 },
  ];
  for (const { path, length, strength } of checks) {
    near(path.distance, length);
    near(path.delay, length / speed);
    const sample = emissionSample + (length / speed) * sampleRate;
    const first = Math.floor(sample);
    const gain = strength / length;
    const [a, b] = pcm.slice(first, first + 2);
    near(a, gain * (1 - (sample - first)), 2e-7);
    near(b, gain * (sample - first), 2e-7);
    near((a * first + b * (first + 1)) / (a + b), sample, 1e-5);
  }
  assert(
    Math.max(...pcm.slice(0, emissionSample + Math.floor((checks[0].length / speed) * sampleRate)).map(Math.abs)) <
      1e-7,
  );
  for (const [i, point] of [firstCrossing, secondCrossing].entries())
    for (const [axis, component] of point.entries()) near(echo.points[i + 1][axis], component);
  for (const { path } of checks) {
    const last = path.reflections.length === 0 ? source : secondCrossing;
    const tail = hypot(last, receiver);
    for (const [axis, coordinate] of last.entries()) near(path.direction[axis], (coordinate - receiver[axis]) / tail);
  }

  const wall1Frame = cue + Math.ceil((hypot(source, firstCrossing) / speed) * slowdown * 60);
  const wall2Frame =
    cue + Math.ceil(((hypot(source, firstCrossing) + hypot(firstCrossing, secondCrossing)) / speed) * slowdown * 60);
  const directFrame = cue + Math.ceil((checks[0].length / speed) * slowdown * 60);
  const reflectedFrame = cue + Math.ceil((checks[1].length / speed) * slowdown * 60);
  const beforeCue = await shot(0, 'before-cue');
  assert.deepEqual(await shot(cue - 1), beforeCue);
  assert.equal(beforeCue.first.reached + beforeCue.reflected.reached, 0);

  const approach = await shot(wall1Frame - 8, 'approaching-first-wall');
  const firstWall = await shot(wall1Frame + 1, 'first-reflection');
  const afterWalls = await shot(wall2Frame + 2, 'second-reflection');
  const justDirect = await shot(directFrame + 2, 'direct-at-listener');
  const complete = await shot(reflectedFrame + 3, 'two-reflections-at-listener');

  assert.equal(approach.reflected.reached, 0);
  assert.equal(firstWall.reflected.reached, 1);
  assert.equal(afterWalls.reflected.reached, 2);
  assert(justDirect.first.arrived && !justDirect.reflected.arrived);
  assert(complete.first.arrived && complete.reflected.arrived);
  for (const [frame, predicate] of [
    [wall1Frame, (state) => state.reflected.reached >= 1],
    [wall2Frame, (state) => state.reflected.reached >= 2],
    [directFrame, (state) => state.first.arrived],
    [reflectedFrame, (state) => state.reflected.arrived],
  ]) {
    assert.equal(predicate(await at(frame - 1)), false, `Early event at film frame ${frame - 1}`);
    assert.equal(predicate(await at(frame)), true, `Missing event at film frame ${frame}`);
  }
  for (const stage of [approach, firstWall, afterWalls, justDirect]) {
    const path = stage.reflected.positions;
    let travelled = 0;
    for (let i = 3; i < path.length; i += 3) travelled += hypot(path.slice(i - 3, i), path.slice(i, i + 3));
    near(travelled, stage.elapsed * speed);
  }
  assert(colorCount(firstWall.image, crossing[0], true) > colorCount(approach.image, crossing[0], true) + 5);
  assert(colorCount(afterWalls.image, crossing[1], true) > colorCount(firstWall.image, crossing[1], true) + 5);
  assert(colorCount(justDirect.image, target, false) > colorCount(afterWalls.image, target, false) + 3);

  const settled = await shot(cue + end, 'held-end');
  assert.deepEqual(await shot(cue + end + 16), settled);
  assert.deepEqual(await shot(wall1Frame + 1, 'restored-first-reflection', true), firstWall);
  assert.deepEqual(await shot(wall2Frame + 2), afterWalls);
  assert.deepEqual(await shot(reflectedFrame + 3, 'replayed-listener'), complete);
  assert.deepEqual(await page.evaluate(() => window.hall.dispose()), { validation: null, errors: [] });
  assert.deepEqual(uncaught, []);
  console.log(
    `  ${backend} concert hall: direct ${(1000 * direct.delay).toFixed(3)} ms/two reflections ${(1000 * echo.delay).toFixed(3)} ms with ${setup.count} audio paths, first and second wall on authored frames ${wall1Frame}/${wall2Frame}; exact replay of pulse response and full frames`,
  );
} finally {
  await close();
}
