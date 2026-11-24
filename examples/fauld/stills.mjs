// Stills of the Fauld tunnels shots: one PNG per row at its still probe (examples/fauld, @margoengine/scenes/fauld-tunnels).
//   node examples/fauld/stills.mjs [--library=<asset library folder, default MARGO_ASSET_LIBRARY or ../../Assets/blender-library>] --out=<folder> [--shots=fr003,fr009] [--w=1920 --h=1080]
// Serves the repository and the asset library (/asset-library/), renders each row's page and saves <out>/<row>.png,
// printing the mean and spread of its luma and its clipped and black shares. Run from the repository root after the
// scenes build; GPU work, so run it under scripts/run-with-timeout.mjs.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const library = arg('library', process.env.MARGO_ASSET_LIBRARY ?? '../../Assets/blender-library'),
  out = arg('out', 'test-results/fauld-stills'),
  w = Number(arg('w', 1920)),
  h = Number(arg('h', 1080)),
  shots =
    arg('shots')?.split(',') ??
    // the tunnel rows only: the countryside and crater rows share the fauld-frNNN names
    (
      await Promise.all(
        (
          await readdir('tools/shot/shots')
        )
          .filter((f) => /^fauld-fr\d+\.json$/.test(f))
          .map(async (f) => [f, JSON.parse(await readFile(join('tools/shot/shots', f), 'utf8')).shot.scene]),
      )
    )
      .filter(([, scene]) => scene === 'fauld-tunnels')
      .map(([f]) => f.slice(6, -5))
      .sort(),
  port = 5341,
  context = await openBrowser({ startPath: '/examples/fauld/index.html', port }),
  { page } = context;
await page.route(
  (url) => url.pathname.startsWith('/asset-library/'),
  async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/asset-library\//, ''));
    try {
      await route.fulfill({ body: await readFile(join(library, path)) });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  },
);
await page.setViewportSize({ width: Math.max(w, 1280), height: Math.max(h, 800) });
await mkdir(out, { recursive: true });
const report = [];
try {
  for (const shot of shots) {
    const pageErrors = [];
    const onError = (e) => pageErrors.push(e.message ?? String(e));
    page.on('pageerror', onError);
    const begun = Date.now();
    await page.goto(`http://127.0.0.1:${port}/examples/fauld/index.html?shot=${shot}&w=${w}&h=${h}`);
    await page.waitForFunction(
      () => document.querySelector('#viewport')?.dataset.ready || document.querySelector('#viewport')?.dataset.error,
      null,
      { timeout: 600000 },
    );
    const error = await page.evaluate(() => document.querySelector('#viewport').dataset.error);
    if (error) {
      console.log(shot, 'ERROR', error);
      report.push({ shot, error });
      page.off('pageerror', onError);
      continue;
    }
    const r = await page.evaluate(() => window.fauld.still(24));
    const png = await page.locator('#viewport canvas').screenshot();
    await writeFile(join(out, `${shot}.png`), png);
    const img = await decodePNG(png);
    let sum = 0,
      sq = 0,
      clip = 0,
      black = 0;
    const n = img.data.length / 4;
    for (let i = 0; i < img.data.length; i += 4) {
      const l = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      sum += l;
      sq += l * l;
      if (l >= 250) clip++;
      if (l <= 4) black++;
    }
    const row = {
      shot,
      mean: +(sum / n).toFixed(1),
      sd: +Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)).toFixed(1),
      clip: +((100 * clip) / n).toFixed(2),
      black: +((100 * black) / n).toFixed(1),
      seconds: (Date.now() - begun) / 1000,
      ...r,
      pageErrors,
    };
    report.push(row);
    console.log(JSON.stringify(row));
    page.off('pageerror', onError);
  }
} finally {
  await writeFile(join(out, 'stills.json'), JSON.stringify(report, null, 2));
  await context.close();
}
