import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function distance(a, b) {
  return Math.hypot(...a.map((value, i) => value - b[i]));
}

function project(point, matrix, image) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const u = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  const v = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  return [(0.5 + 0.5 * u) * image.width, (0.5 - 0.5 * v) * image.height];
}

function changed(a, b, points) {
  const radius = 10;
  const targets = points?.map(([x, y]) => [Math.floor(x), Math.floor(y)]);
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const pixel = i / 4;
    const x = pixel % a.width;
    const y = Math.floor(pixel / a.width);
    if (targets && !targets.some(([atX, atY]) => Math.abs(x - atX) <= radius && Math.abs(y - atY) <= radius)) continue;
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      18
    )
      count++;
  }
  return count;
}

try {
  const { cue, first, second, end, origin, leg, friction } = await page.evaluate(async () => {
    const { mountLeggedFilm } = await import('/packages/physics/tests/legged-film.fixture.js');
    const film = await mountLeggedFilm();
    window.leggedFilm = film;
    const { sample, dispose, ...settings } = film;
    return settings;
  });

  let maxPlantedError = 0;
  let maxFrictionRatio = 0;
  async function get(editFrame, action, hideHorse = false) {
    const { states, ...camera } = await page.evaluate((input) => window.leggedFilm.sample(input), {
      editFrame,
      action,
      hideHorse,
    });
    const shots = await Promise.all(
      states.map(async ({ image, ...state }) => {
        assert.deepEqual(state.cells, [origin, origin, origin]);
        const { grade } = state;
        assert.equal(state.motion.fallen, false);
        for (const [i, foot] of state.hoofData.entries()) {
          const { position, force, couple, stance } = foot;
          if (!stance) assert.deepEqual([...force, ...couple].map(Math.abs), [0, 0, 0, 0, 0, 0]);
          if (!stance) continue;
          // Sample the analytic plane on the authored 0.5 m grid and round its independent vertex heights to the
          // published f32 terrain ABI. Two vertex rows give the exact local slope because the plane is constant in X.
          const index = (position[2] + 12) / 0.5;
          const row = Math.floor(index);
          const y0 = Math.fround(grade * (row * 0.5 - 7));
          const y1 = Math.fround(grade * ((row + 1) * 0.5 - 7));
          const elevation = y0 + (index - row) * (y1 - y0);
          const slope = (y1 - y0) / 0.5;
          const scale = Math.hypot(1, slope);
          const normal = [0, 1 / scale, -slope / scale];
          assert(
            Math.abs(position[1] - elevation) <= 32 * Number.EPSILON * Math.max(1, Math.abs(elevation)),
            JSON.stringify({ position, elevation }),
          );
          const normalReaction = force[1] * normal[1] + force[2] * normal[2];
          const shear = distance(
            force,
            normal.map((value) => value * normalReaction),
          );
          // A patch of representative radius L/2 can share the Coulomb budget between force and couple.
          const demand = shear + Math.hypot(...couple) / (0.5 * leg);
          const capacity = friction * normalReaction;
          assert(
            normalReaction >= 0 && demand <= capacity + 64 * Number.EPSILON * Math.max(1, capacity),
            JSON.stringify({ grade, demand, capacity, force, couple }),
          );
          if (!(normalReaction > 0)) continue;
          maxFrictionRatio = Math.max(maxFrictionRatio, demand / capacity);
          const error = distance(position, state.hooves[i]);
          maxPlantedError = Math.max(maxPlantedError, error);
          assert(
            error <= 512 * Number.EPSILON * Math.max(1, Math.hypot(...position)),
            JSON.stringify({ position, hoof: state.hooves[i], error }),
          );
        }
        const png = Buffer.from(image, 'base64');
        return { state, png, pixels: await decodePNG(png) };
      }),
    );
    return { ...camera, shots };
  }

  function expectExact(actual, previous) {
    assert.equal(actual.frame, previous.frame);
    assert.deepEqual(actual.matrix, previous.matrix);
    for (const [i, shot] of actual.shots.entries()) {
      assert.deepEqual(shot.state, previous.shots[i].state);
      assert.deepEqual(shot.pixels.data, previous.shots[i].pixels.data);
    }
  }

  const before = await get(0);
  expectExact(await get(cue), before);
  const plant = await get(cue + first, 'save');
  const [level, slope] = plant.shots;
  assert.equal(level.state.motion.gait, 'trot');
  assert.equal(slope.state.motion.gait, 'walk');
  assert(slope.state.motion.velocity[2] < level.state.motion.velocity[2]);
  assert(slope.state.pitch < level.state.pitch);
  // Hildebrand 1965, doi:10.1126/science.150.3697.701: a trot is paired alternate diagonal beats.
  const trot = (shot) => shot.state.hoofData.map((foot) => foot.stance);
  const [a, b, c, d] = trot(level);
  assert.equal(a, d);
  assert.equal(b, c);
  assert.notEqual(a, b);
  const reflection = await get(cue + first, undefined, true);
  const visibility = plant.shots.map((shot, i) => {
    const hidden = reflection.shots[i];
    assert.deepEqual(hidden.state, shot.state);
    const within = [shot.state.head, ...shot.state.hooves].map((point) => project(point, plant.matrix, shot.pixels));
    return { body: changed(shot.pixels, hidden.pixels), projected: changed(shot.pixels, hidden.pixels, within) };
  });
  assert(
    visibility.every(({ body, projected }) => body > 600 && projected > 70),
    JSON.stringify(visibility),
  );

  const nextTick = await get(cue + first + 1);
  const plantTravels = nextTick.shots.map(({ state }, i) => {
    const previous = plant.shots[i].state;
    const held = state.hoofData.filter((foot, j) => {
      const initial = previous.hoofData[j];
      if (!foot.stance || !initial.stance || foot.force[1] <= 0 || initial.force[1] <= 0) return false;
      assert.deepEqual(foot.position, initial.position);
      return true;
    });
    assert(held.length > 0);
    const moved = state.motion.position[2] - previous.motion.position[2];
    assert(moved > 0);
    return moved;
  });
  const passage = await get(cue + second, 'save');
  const later = passage.shots[0];
  const [ea, eb, ec, ed] = trot(later);
  assert.equal(ea, ed);
  assert.equal(eb, ec);
  assert.notEqual(ea, a);
  const after = await get(cue + end);
  const travel = after.shots.map(({ state }, i) => state.motion.position[2] - before.shots[i].state.motion.position[2]);
  assert(travel[0] > travel[1] && travel[1] > 0);
  const movement = after.shots.map((shot, i) => changed(shot.pixels, before.shots[i].pixels));
  assert(
    movement.every((count) => count > 1000),
    JSON.stringify(movement),
  );

  for (const frame of [before, plant, passage, after]) {
    for (const { state, pixels } of frame.shots) {
      for (const point of [state.head, ...state.hooves]) {
        const [x, y] = project(point, frame.matrix, pixels);
        assert(
          x >= 12 && y >= 12 && x <= pixels.width - 12 && y <= pixels.height - 12,
          JSON.stringify({ point, x, y }),
        );
      }
    }
  }
  expectExact(await get(cue + end + 21), after);
  expectExact(await get(cue + second, 'restore'), passage);
  expectExact(await get(cue + end), after);
  expectExact(await get(cue + first, 'restore'), plant);
  expectExact(await get(cue + second), passage);
  expectExact(await get(cue + end), after);
  expectExact(await get(0), before);
  expectExact(await get(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.leggedFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_LEGGED_FILM_FRAMES === '1') {
    const folder = 'packages/physics/test-results/legged-film';
    await mkdir(folder, { recursive: true });
    for (const [name, frame] of Object.entries({ before, plant, passage, after })) {
      await writeFile(`${folder}/${backend}-${name}-level.png`, frame.shots[0].png);
      await writeFile(`${folder}/${backend}-${name}-incline.png`, frame.shots[1].png);
    }
  }
  console.log(
    `${backend} legged: level trot vs 13% uphill walk after the same command, ` +
      `${travel.map((value) => value.toFixed(3)).join('/')} m travel, loaded hoof fit ≤ ${maxPlantedError.toExponential(2)} m, ` +
      `anchors fixed during ${plantTravels.map((value) => (value * 100).toFixed(2)).join('/')} cm COM advance, ` +
      `max Coulomb use ${maxFrictionRatio.toFixed(6)}, live silhouettes ${visibility.map(({ body }) => body).join('/')} pixels, ` +
      `exact replay ${after.shots.map(({ state }) => state.hash).join('/')}.`,
  );
} finally {
  await close();
}
