// Real-adapter check of @margoengine/inspector/mesh-debug (build packages first), from the repository root:
//   node packages/inspector/test/mesh-debug-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { watchConsole } from '../../../scripts/support/browser-advisories.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ port: 'free', startPath: '/packages/inspector/test/mesh-debug.html' }),
  { page, hardware } = context,
  watch = watchConsole(page, hardware);
const run = async (method, ...args) => {
  const errors = await page.evaluate(([m, a]) => window.check[m](...a), [method, args]);
  assert.deepEqual(errors, [], method);
  const image = await decodePNG(await page.locator('canvas').screenshot());
  assert.equal(image.width, 256);
  return image;
};
// The plane z 0 spans -1..1 across the 256-pixel canvas.
const offset = (x, y) => (Math.floor((1 - y) * 128) * 256 + Math.floor((x + 1) * 128)) * 4;
const at = (image, x, y) => [...image.data.subarray(offset(x, y), offset(x, y) + 3)];
const px = (image, x, y) => [...image.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)];
const near = (actual, expected, label, tolerance = 3) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: ${actual} != ${expected}`,
  );
const differs = (actual, expected, label) =>
  assert.ok(
    actual.some((v, i) => Math.abs(v - expected[i]) > 20),
    `${label}: ${actual} is ${expected}`,
  );
const encode = (c) => c.map((v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)));
const grey = [160, 160, 160],
  teal = [114, 232, 204],
  amber = [255, 179, 38],
  light = [240, 240, 240],
  blue = [58, 110, 165],
  flat = { specularColor: '#000000' };

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });

  // Core mesh: its own picture, then each wire and dot mode.
  await run('scene', 'core');
  const bare = await run('show', null),
    red = at(bare, 0.3, -0.3);
  const shaded = await run('show', { mode: 'shaded', ...flat });
  near(at(shaded, 0.3, -0.3), grey, 'shaded replaces the surface');
  assert.deepEqual(at(shaded, 0.9, 0), at(bare, 0.9, 0), 'nothing outside the mesh');
  const wire = await run('show', { mode: 'wireframe', multiply: null, wireWidth: 6 });
  near(at(wire, 0, 0), teal, 'the diagonal');
  assert.deepEqual(at(wire, 0.3, -0.3), red, 'multiply keeps the picture between edges');
  // Along one row: half widths at the two outer edges, the diagonal's width times root 2.
  const runs = [];
  for (let x = 0, n = 0; x < 256; x++) {
    const p = px(wire, x, 90);
    if (p.every((v, i) => Math.abs(v - teal[i]) < 60)) n++;
    else if (n) {
      runs.push(n);
      n = 0;
    }
  }
  assert.equal(runs.length, 3, `three edges in a row: ${runs}`);
  assert.ok(runs[0] >= 2 && runs[0] <= 4 && runs[2] >= 2 && runs[2] <= 4, `outer edges 3 px: ${runs}`);
  assert.ok(runs[1] >= 7 && runs[1] <= 10, `diagonal 6 px across, 8.5 along the row: ${runs}`);
  const dots = await run('show', { mode: 'vertices', vertexRadius: 8 });
  near(px(dots, 221, 35), amber, 'dot at the top-right corner');
  near(px(dots, 35, 221), amber, 'dot at the bottom-left corner');
  assert.deepEqual(px(dots, 208, 48), px(bare, 208, 48), 'beyond the radius');
  assert.deepEqual(at(dots, 0, 0), at(bare, 0, 0), 'no edges in the dot mode');
  const both = await run('show', { mode: 'wireframe-vertices', multiply: false, ...flat });
  near(px(both, 221, 35), amber, 'dot over the shading');
  near(at(both, 0, 0), teal, 'edge over the shading');
  near(at(both, 0.3, -0.3), grey, 'shading between edges');
  assert.deepEqual((await run('show', { enabled: false })).data, bare.data, 'disabled draws nothing');
  assert.deepEqual((await run('show', null)).data, bare.data, 'disposal restores the frame');
  await run('show', { mode: 'shaded', ...flat });
  assert.deepEqual((await run('hide', false)).data.length, bare.data.length);
  differs(at(await run('hide', false), 0.3, -0.3), grey, 'a hidden mesh is not drawn');
  near(at(await run('hide', true), 0.3, -0.3), grey, 'shown again');
  const swapped = await run('swap', 0.4);
  near(at(swapped, 0.1, -0.1), grey, 'new geometry');
  differs(at(swapped, 0.5, -0.5), grey, 'old geometry gone');

  // A curved surface of many triangles: the replacing pass covers every pixel the mesh covers (no depth ties lost).
  await run('scene', 'sphere');
  const ball = await run('show', null),
    cover = await run('show', { mode: 'shaded', specularColor: '#000000', diffuseColor: '#00ff00' });
  let covered = 0,
    lost = 0;
  for (let y = 1; y < 255; y++)
    for (let x = 1; x < 255; x++)
      if (Math.hypot(x + 0.5 - 128, y + 0.5 - 128) < 0.76 * 128) {
        covered++;
        const [r, g] = px(cover, x, y);
        if (!(r < 5 && g > 40)) lost++;
      }
  assert.ok(covered > 25000, `sphere pixels: ${covered}`);
  assert.equal(lost, 0, 'every sphere pixel shows the debug surface');
  differs(px(cover, 128, 128), px(ball, 128, 128), 'sphere drawn');
  assert.ok(at(cover, 0, 0)[1] > at(cover, 0.7, 0)[1] + 40, 'camera light falls off toward the silhouette');

  // A one-sided face turned away stays hidden.
  await run('scene', 'back');
  const away = await run('show', null);
  assert.deepEqual((await run('show', { mode: 'shaded' })).data, away.data, 'back face of a one-sided mesh');

  // Checkers: a core mesh with and without UVs.
  await run('scene', 'coreUv');
  const checker = await run('show', { mode: 'uv0', uvScale: 2, ...flat });
  near(at(checker, -0.4, -0.4), light, 'UV (0,0) square');
  near(at(checker, 0.4, -0.4), blue, 'next square along u');
  near(at(checker, -0.4, 0.4), blue, 'next square along v');
  near(at(checker, 0.4, 0.4), light, 'diagonal square');
  const plain = await run('show', null),
    times = await run('show', { mode: 'uv0', multiply: true, uvColors: ['#ffffff', '#000000'], uvScale: 2 });
  near(at(times, -0.4, -0.4), at(plain, -0.4, -0.4), 'white multiplies to the picture', 1);
  near(at(times, 0.4, -0.4), [0, 0, 0], 'black multiplies to black', 1);
  await run('scene', 'core');
  near(at(await run('show', { mode: 'uv0', uvScale: 2, ...flat }), 0.4, -0.4), light, 'no UVs: the first colour');
  near(at(await run('show', { mode: 'vertex-colors' }), 0.3, -0.3), [255, 255, 255], 'no vertex colours: white');

  // A materials mesh: both UV sets, vertex colours, deformation and geometry writes.
  await run('scene', 'painted');
  near(at(await run('show', { mode: 'uv0', uvScale: 2, ...flat }), -0.4, -0.4), light, 'UV set 0');
  near(at(await run('show', { mode: 'uv1' }), -0.4, -0.4), blue, 'UV set 1 runs the other way');
  const colours = encode([0, 0.5, 0]);
  near(at(await run('show', { mode: 'vertex-colors' }), 0.3, -0.3), colours, 'vertex colours, unlit', 1);
  const own = await run('show', null),
    tinted = await run('show', { mode: 'vertex-colors', multiply: true });
  near(
    at(tinted, 0.3, -0.3),
    at(own, 0.3, -0.3).map((v, i) => Math.round((v * colours[i]) / 255)),
    'vertex colours multiply the picture',
    2,
  );
  await run('show', { mode: 'shaded', multiply: false, ...flat });
  let moved = await run('deform', true);
  near(at(moved, 0.5, 0), grey, 'deformed vertices are read live');
  differs(at(moved, -0.4, 0), grey, 'the bind pose is not drawn');
  near(at(await run('deform', false), -0.4, 0), grey, 'bind pose back');
  moved = await run('regeometry', 0.5, false);
  near(at(moved, 0.2, -0.2), grey, 'rewritten geometry');
  differs(at(moved, 0.6, -0.6), grey, 'old size gone');
  near(at(await run('regeometry', 1, true), 0.6, -0.6), grey, 'grown geometry');

  // Material colours: ids in draw order, shared materials share one.
  await run('scene', 'materials');
  const ids = await run('show', { mode: 'material-ids', ...flat }),
    [first, second, again, core] = [-0.65, -0.15, 0.35, 0.8].map((x) => at(ids, x, -0.05));
  near(again, first, 'a shared material shares its colour', 1);
  differs(second, first, 'the second material');
  differs(core, first, 'the core material');
  differs(core, second, 'the core material');
  const custom = await run('show', { materialColors: ['#ff00ff'] });
  near(at(custom, -0.65, -0.05), [255, 0, 255], 'a chosen first colour');
  near(at(custom, -0.15, -0.05), second, 'generated after the list', 1);
  await run('show', { materialColors: [], only: 3 });
  const one = await run('reset');
  // The light falls off by under a level between the two places.
  near(at(one, 0.8, -0.05), first, 'ids start again after a reset', 2);
  differs(at(one, -0.65, -0.05), first, 'meshes limits the view');

  // Instances, one mirrored, of a one-sided material.
  await run('scene', 'instances');
  const copies = await run('show', { mode: 'shaded', ...flat });
  near(at(copies, -0.45, -0.05), grey, 'first instance');
  near(at(copies, 0.45, -0.05), grey, 'mirrored instance');
  differs(at(copies, 0, 0), grey, 'nothing between');

  // Two views into quarters of the canvas: dots follow each view's rectangle.
  await run('scene', 'core');
  await run('show', { mode: 'vertices', vertexRadius: 5 });
  const split = await run('views', true);
  near(px(split, 110, 18), amber, 'first view, top-right dot');
  near(px(split, 238, 146), amber, 'second view, top-right dot');
  near(px(split, 146, 238), amber, 'second view, bottom-left dot');
  await run('views', false);

  // A pick between frames keeps the uploaded copies.
  await run('show', { mode: 'shaded', ...flat });
  assert.equal(await page.evaluate(() => window.check.picks()), 0, 'no buffer is uploaded again');

  // A new device.
  await run('show', { mode: 'shaded', ...flat });
  near(at(await run('restore'), 0.3, -0.3), grey, 'drawn on the restored device');

  assert.deepEqual(watch.problems, []);
  console.log(`mesh-debug check passed (${hardware?.compat ? 'WebGL2 layer' : 'WebGPU'})`);
} finally {
  await context.close();
}
