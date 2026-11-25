// KB-SKY-SUNUNITS1 on a real GPU (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/sky/test/sky-light-units-check.mjs
// The sky's light on level ground against the sun's, both day models: a grey plate seen from above, lit by the sun
// alone and by the sun and the sky's light map. The display curve (Khronos PBR Neutral, then sRGB) is undone in JS, and
// the sky's share of the light on the plate is the clear-sky diffuse fraction with the sun 60 degrees up. Preetham's
// (calibrated hazy air, turbidity 2): 0.1 to 0.2 (Erbs, Klein and Duffie 1982, Solar Energy 28(4) 293-302, https://doi.org/10.1016/0038-092X(82)90302-4: about 0.165
// at a clearness index of 0.75). Bruneton's at turbidity 2 is nearly aerosol-free air (Mie optical depth about 0.003),
// whose diffuse share is lower: about 0.05 for Rayleigh air alone at that height of sun (Bird and Hulstrom 1981, "A
// simplified clear sky model for direct and diffuse insolation on horizontal surfaces", SERI/TR-642-761, https://www.osti.gov/biblio/6510849), so 0.04 to
// 0.1. The share holds when lighting.intensity changes, since the sky's light is the sun's light scattered: until
// 2026-11-17 the map stayed in the sky's own units (shares 0.61 and 0.56 at intensity 1, 0.34 and 0.30 at 3), so the
// sky lit level ground 1.3 to 1.5 times as much as the sun and a brighter sun only diluted it (KB-SKY-SUNUNITS1).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const port = 5234,
  context = await openBrowser({ startPath: '/packages/sky/test/sky-light-units-check.html', port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
// sRGB decode, then PBR Neutral undone below its shoulder (peak under 0.76): the offset follows the darkest channel.
const linear = (rgb) => {
  const v = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }),
    low = Math.min(...v);
  assert.ok(Math.max(...v) < 0.75, `plate below the display curve's shoulder (${v})`);
  const x = low < 0.04 ? Math.sqrt(low / 6.25) : low + 0.04,
    offset = low < 0.04 ? x - 6.25 * x * x : 0.04;
  return v.map((c) => c + offset);
};
const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const run = async (query) => {
  await page.goto(`http://127.0.0.1:${port}/packages/sky/test/sky-light-units-check.html?${query}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check.run(3));
  assert.deepEqual(r.errors, [], `${query}: GPU errors`);
  return r.frames[2];
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  const albedo = 0.6;
  for (const model of ['preetham', 'bruneton']) {
    const shares = [];
    for (const intensity of [1, 3]) {
      const a = albedo / intensity,
        sun = await run(`model=${model}&elevation=60&intensity=${intensity}&light=sun&albedo=${a}`),
        both = await run(`model=${model}&elevation=60&intensity=${intensity}&light=both&albedo=${a}`),
        s = luminance(linear(sun)),
        b = luminance(linear(both)),
        share = (b - s) / b;
      console.log(
        model,
        'intensity',
        intensity,
        'sun',
        sun.map((v) => v.toFixed(1)),
        'both',
        both.map((v) => v.toFixed(1)),
        'sky share',
        share.toFixed(4),
      );
      shares.push(share);
    }
    const [low, high] = model === 'preetham' ? [0.1, 0.2] : [0.04, 0.1];
    process.env.MEASURE ||
      assert.ok(
        shares[0] >= low && shares[0] <= high,
        `${model}: the clear sky's share of the light on level ground, ${shares[0]}`,
      );
    process.env.MEASURE ||
      assert.ok(
        Math.abs(shares[1] - shares[0]) <= 0.02,
        `${model}: the share holds at 3x intensity (${shares[0]} then ${shares[1]})`,
      );
  }
  assert.deepEqual(pageErrors, []);
  console.log('sky light units check passed');
} finally {
  await context.close();
}
