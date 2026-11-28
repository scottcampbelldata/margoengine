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

function changed(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const distance =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (distance > 18) count++;
  }
  return count;
}

try {
  const { cue, checkpoint, end, length, mass, gravity, radius, links } = await page.evaluate(async () => {
    const { mountSlitherFilm } = await import('/packages/environment/tests/fixtures/slither-film.js');
    window.slitherFilm = await mountSlitherFilm();
    const { cue, checkpoint, end, length, mass, gravity, radius, links } = window.slitherFilm;
    return { cue, checkpoint, end, length, mass, gravity, radius, links };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.slitherFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    assert.equal(state.contacts.length, links);
    const shapeRoundoff = 128 * Number.EPSILON * length;
    const halfLink = length / (2 * links);
    const left = (contact, axis) => contact.position[axis] - halfLink * contact.axis[axis];
    const right = (contact, axis) => contact.position[axis] + halfLink * contact.axis[axis];
    for (const [i, contact] of state.contacts.entries()) {
      assert.deepEqual(state.anchors[i], contact.position);
      assert(contact.stance && contact.force[1] > 0);
      const gap = contact.position[1] - contact.ground;
      assert(gap > 0 && gap < radius, JSON.stringify({ i, gap, contact }));
      assert(Math.abs(Math.hypot(...contact.axis) - 1) < 8 * Number.EPSILON);
      for (let j = 0; j < 3; j++) {
        if (i > 0) assert(Math.abs(left(contact, j) - right(state.contacts[i - 1], j)) <= shapeRoundoff);
        else assert(Math.abs(left(contact, j) - state.tail[j]) <= shapeRoundoff);
        if (i + 1 === links) assert(Math.abs(right(contact, j) - state.head[j]) <= shapeRoundoff);
      }
    }
    return { state, png, image: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const start = await sample(0);
  exact(await sample(cue - 1), start);
  const uniformStart = await sample(0, { directional: false });
  assert.deepEqual(start.state.anchors, uniformStart.state.anchors);
  assert.deepEqual(start.image.data, uniformStart.image.data);
  const moving = await sample(cue + checkpoint, { action: 'save' });
  const uniform = await sample(cue + end, { directional: false });
  const advanced = await sample(cue + end);
  const distance = advanced.state.pose.position[2] - start.state.pose.position[2];
  const control = uniform.state.pose.position[2] - uniformStart.state.pose.position[2];
  const holdLoad = advanced.state.contacts.reduce((sum, c) => sum + c.force[1], 0);
  assert(distance > 0.07 && Math.abs(control) < 0.03 && distance - control > 0.09);
  assert.equal(advanced.state.pose.phase, uniform.state.pose.phase);
  assert(
    Math.abs(advanced.state.pose.phase - start.state.pose.phase) < 1e-12,
    'compare the same phase after four cycles',
  );
  assert(
    Math.abs(holdLoad - mass * gravity) < 0.005 * mass * gravity,
    `Accepted total normal support is ${holdLoad} N.`,
  );
  const movePixels = changed(advanced.image, uniform.image);
  assert(movePixels > 1000 && changed(moving.image, start.image) > 800, `Traction moved only ${movePixels} pixels.`);

  exact(await sample(cue + end + 16), advanced);
  exact(await sample(cue + checkpoint, { action: 'restore' }), moving);
  exact(await sample(cue + end), advanced);
  exact(await sample(0), start);
  exact(await sample(cue + end), advanced);
  assert.deepEqual(await page.evaluate(() => window.slitherFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SLITHER_FRAMES === '1') {
    const path = 'packages/environment/test-results/slither-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ start, moving, advanced, uniform }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} slither: ${(100 * distance).toFixed(3)}/${(100 * control).toFixed(3)} cm signed travel with directional/equal friction, ` +
      `${holdLoad.toFixed(6)} N support across ${links} accepted links, ${movePixels} changed pixels, replay ${advanced.state.hash}.`,
  );
} finally {
  await close();
}
