// Real-GPU proof (run from the repository root after building packages):
//   node packages/scatter/test/clearing-map.browser.mjs        (and with --compat for the WebGL2 layer)
// `@margoengine/scatter/clearing-map` on one instance, read from the drawn card:
// - without a map, or under a map of zeros, or outside the map's rectangle, it draws the same bytes as a Scatter built
//   without `thinning`;
// - `shorten` cuts its height to 1 - shorten x weight; `thin` x weight of 1 or more drops it;
// - the map is also read `reach` metres from the root, no farther;
// - a new map texture, rectangle and look apply to the live scatter, and a GrassScatter takes the same source.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/clearing-map.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/** How many rows the drawing covers (any pixel that differs from the corner's background). */
const drawn = (image) => {
  const background = image.data.slice(0, 3),
    rows = [];
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const k = (y * image.width + x) * 4;
      if ([0, 1, 2].some((c) => Math.abs(image.data[k + c] - background[c]) > 3)) {
        rows.push(y);
        break;
      }
    }
  return rows.length ? rows.at(-1) + 1 - rows[0] : 0;
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? 'WebGL2 layer' : 'WebGPU');
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const draw = async (settings) => {
      const errors = await page.evaluate((s) => window.check.show(s), settings);
      assert.deepEqual(errors, [], JSON.stringify(settings));
      const png = await page.locator('canvas').screenshot();
      return { png, rows: drawn(await decodePNG(png)) };
    };
    // Texel 4 holds the root (x within half a millimetre of 0, from 0 up).
    const all = (v) => Array(8).fill(v),
      only = (column, v) => all(0).map((_, k) => (k === column ? v : 0));
    const plain = await draw({ thinned: false });
    assert.ok(plain.rows > 80, `the card spans the view (${plain.rows} rows)`);
    for (const [name, settings] of [
      ['no map', {}],
      ['a map of zeros', { columns: all(0) }],
      ['outside the rectangle', { columns: all(255), rect: [10, 10, 18, 18] }],
    ])
      assert.ok((await draw(settings)).png.equals(plain.png), `${name} changes nothing`);
    const half = await draw({ columns: all(128), look: { thin: 0, shorten: 0.8 } }),
      kept = half.rows / plain.rows,
      want = 1 - (0.8 * 128) / 255;
    assert.ok(Math.abs(kept - want) < 0.03, `height ${kept.toFixed(3)} of its own, ${want.toFixed(3)}`);
    assert.equal((await draw({ columns: all(255), look: { thin: 1 } })).rows, 0, 'thin x weight 1 drops it');
    assert.equal((await draw({ columns: all(128), look: { thin: 2.1 } })).rows, 0, 'a chance past 1 drops it');
    // Column 5 is x = 1 to 2 m: out of reach at 0.25 m, in reach at 1.2 m.
    const near = await draw({ columns: only(5, 255), look: { reach: 0.25 } });
    assert.ok(near.png.equals(plain.png), 'a foot farther than reach changes nothing');
    assert.equal((await draw({ columns: only(5, 255), look: { reach: 1.2 } })).rows, 0, 'a foot within reach clears');
    // The live scatter follows a new texture and a moved rectangle (its column 7 then holds the root).
    assert.ok((await draw({ columns: all(0) })).png.equals(plain.png), 'back to nothing');
    assert.equal((await draw({ columns: only(7, 255), rect: [-7.5, -4, 0.5, 4] })).rows, 0, 'a moved rectangle');
    const grass = await draw({ kind: 'grass' });
    assert.ok(grass.rows > 40, `the clump draws (${grass.rows} rows)`);
    assert.equal((await draw({ kind: 'grass', columns: all(255), look: { thin: 1 } })).rows, 0, 'grass is thinned');
    const low = await draw({ kind: 'grass', columns: all(255), look: { thin: 0, shorten: 0.5 } });
    assert.ok(Math.abs(low.rows / grass.rows - 0.5) < 0.06, `grass stands ${(low.rows / grass.rows).toFixed(3)}`);
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter clearing map', JSON.stringify({ plain: plain.rows, half: +kept.toFixed(3) }));
  },
  () => context.close(),
);
watchExit();
