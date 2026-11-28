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

function pixelDistance(a, b, i) {
  return (
    Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
  );
}

function colourChanges(a, b) {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) if (pixelDistance(a, b, i) > 18) changed++;
  return changed;
}

function project(point, m, pixels) {
  const [x, y, z] = point;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const u = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const v = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  return [(0.5 + 0.5 * u) * pixels.width, (0.5 - 0.5 * v) * pixels.height];
}

function localChanges(a, b, points) {
  const visited = new Set();
  for (const [x, y] of points) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const radius = 6;
    for (let ny = j - radius; ny <= j + radius; ny++)
      for (let nx = i - radius; nx <= i + radius; nx++)
        if (nx >= 0 && ny >= 0 && nx < a.width && ny < a.height) {
          const at = 4 * (nx + ny * a.width);
          if (pixelDistance(a, b, at) > 18) visited.add(at);
        }
  }
  return visited.size;
}

try {
  const { settings, calibration } = await page.evaluate(async () => {
    const { mountStrandFilm, checkCrossflow } = await import('/packages/physics/tests/strand-film.fixture.js');
    const calibration = await checkCrossflow();
    const take = await mountStrandFilm();
    window.strandFilm = take;
    const { sample, dispose, ...settings } = take;
    return { settings, calibration };
  });
  const { cue, preGust, inGust, stop, end, seed } = settings;
  const {
    dt,
    length,
    radius,
    dragWidth,
    drag,
    density,
    air,
    speed,
    anchor,
    tip,
    row,
    exact,
    publishedCell,
    solverCell,
  } = calibration;
  assert.deepEqual(publishedCell, solverCell);
  assert.deepEqual(anchor, [0, 0, 0]);
  assert.deepEqual(row.slice(0, 3), tip);
  assert.equal(exact, true);
  // At the free node, projected side area is Lw/2 and mass is ρπr²L/2. Integrate du/dt = a(U-u)² from rest,
  // project the resulting free position radially onto the original rigid-length guide and compare in SI metres.
  const a = (air * drag * dragWidth) / (2 * density * Math.PI * radius ** 2);
  const free = dt * speed * ((a * speed * dt) / (1 + a * speed * dt));
  const projection = length / Math.hypot(length, free);
  const reference = [free * projection, 0, length * projection];
  assert(
    Math.hypot(...tip.map((v, i) => v - reference[i])) < 128 * Number.EPSILON * length,
    JSON.stringify({ tip, reference }),
  );
  assert(Math.abs(Math.hypot(...tip) - length) < 32 * Number.EPSILON * length);

  async function sample(editFrame, options = {}) {
    const { states, ...state } = await page.evaluate((input) => window.strandFilm.sample(input), {
      editFrame,
      ...options,
    });
    const takes = await Promise.all(
      states.map(async ({ image, ...fields }) => {
        const png = Buffer.from(image, 'base64');
        for (const chain of fields.guides) {
          for (const { point, skin } of chain) {
            const extent = Math.max(1, Math.hypot(...point));
            const roundoff = 9 * chain.length * 2 ** -24 * extent;
            assert(
              point.every((v, i) => Math.abs(v - skin[i]) <= roundoff),
              JSON.stringify({ point, skin, roundoff }),
            );
          }
        }
        assert.deepEqual(fields.portCell, [0, 0, 0]);
        assert.equal(fields.guides.flat().length, 58);
        return { fields, png, pixels: await decodePNG(png) };
      }),
    );
    assert.deepEqual(takes[0].fields.position, takes[1].fields.position);
    assert.equal(takes[0].fields.speed, takes[1].fields.speed);
    assert.equal(takes[0].fields.gait, takes[1].fields.gait);
    assert.deepEqual(takes[1].fields.rootFlow, [0, 0, 0]);
    return { state, takes };
  }

  function exactFrame(a, b) {
    assert.deepEqual(a.state, b.state);
    for (const [i, take] of a.takes.entries()) {
      assert.deepEqual(take.fields, b.takes[i].fields);
      assert.deepEqual(take.pixels.data, b.takes[i].pixels.data);
    }
  }

  const initial = await sample(0);
  exactFrame(await sample(cue), initial);
  const before = await sample(cue + preGust, { action: 'save' });
  assert.deepEqual(before.takes[0].fields.guides, before.takes[1].fields.guides);
  assert.deepEqual(before.takes[0].pixels.data, before.takes[1].pixels.data);
  const gust = await sample(cue + inGust, { action: 'save' });
  assert.equal(gust.takes[0].fields.gait, 'trot');
  assert(gust.takes[0].fields.rootFlow[0] < 0);
  const [moved, calm] = gust.takes;
  const guides = [0, 4, 9];
  const displacements = guides.map((guide) => {
    const p = moved.fields.guides[guide].at(-1).point;
    const q = calm.fields.guides[guide].at(-1).point;
    return Math.hypot(...p.map((v, i) => v - q[i]));
  });
  let farthest = 0;
  const witness = guides.flatMap((guide) => {
    const p = project(moved.fields.guides[guide].at(-1).skin, gust.state.matrix, moved.pixels);
    const q = project(calm.fields.guides[guide].at(-1).skin, gust.state.matrix, calm.pixels);
    farthest = Math.max(farthest, Math.hypot(p[0] - q[0], p[1] - q[1]));
    return [p, q];
  });
  const local = localChanges(moved.pixels, calm.pixels, witness);
  const changed = colourChanges(moved.pixels, calm.pixels);
  // The changed guide must move far enough to span at least two pixels at this camera and actually
  // change the raster near the projected skin points. The calibrated SI drag test is separate.
  assert(farthest >= 2 && local >= 4 && changed >= local, JSON.stringify({ farthest, local, changed, displacements }));
  const stepping = await sample(cue + stop);
  const after = await sample(cue + end);
  assert(after.takes[0].fields.position[2] > gust.takes[0].fields.position[2]);
  assert.equal(after.takes[0].fields.speed, 0);
  assert.deepEqual(after.takes[0].fields.rootFlow, [0, 0, 0]);
  exactFrame(await sample(cue + end + 36), after);
  exactFrame(await sample(cue + inGust, { action: 'restore' }), gust);
  exactFrame(await sample(cue + stop), stepping);
  exactFrame(await sample(cue + end), after);
  exactFrame(await sample(cue + preGust, { action: 'restore' }), before);
  exactFrame(await sample(cue + inGust), gust);
  exactFrame(await sample(cue + end), after);
  exactFrame(await sample(0), initial);
  exactFrame(await sample(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.strandFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_STRAND_FILM_FRAMES === '1') {
    const folder = 'packages/physics/test-results/strand-film';
    await mkdir(folder, { recursive: true });
    for (const [name, shot] of Object.entries({ initial, gust, stepping, after })) {
      await writeFile(`${folder}/${backend}-${name}-gust.png`, shot.takes[0].png);
      if (name === 'gust') await writeFile(`${folder}/${backend}-${name}-control.png`, shot.takes[1].png);
    }
  }
  console.log(
    `${backend} strands: ${(1000 * tip[0]).toFixed(3)} mm analytic cross-flow witness, ` +
      `${displacements.map((v) => v.toFixed(3)).join('/')} m tail/mane/forelock difference, ` +
      `${changed} changed pixels (${local} at guide tips, ${farthest.toFixed(2)} px max projection), ` +
      `seed ${seed}, replay ${after.takes.map((v) => v.fields.hash).join('/')}.`,
  );
} finally {
  await close();
}
