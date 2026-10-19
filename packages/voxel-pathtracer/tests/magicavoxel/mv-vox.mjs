// node test-results/mv-vox.mjs <out-dir> <samples> <file.vox>... : renders each .vox with the tracer's MagicaVoxel
// mapping at 960 x 800 into <out-dir>/<name>-ours.png (run under the GPU lock).
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openBrowser } from '../scripts/browser.js';
const [out, samples, ...files] = process.argv.slice(2);
const path = '/test-results/mv-vox.html', port = 5264, context = await openBrowser({ startPath: path, port }), { page } = context;
try {
  for (const f of files) {
    await page.goto(`http://127.0.0.1:${port}${path}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const b64 = (await readFile(f)).toString('base64');
    const r = await page.evaluate(([b, s, t, e]) => window.render(b, { width: 960, height: 800, samples: s, tweak: t, environment: e }), [b64, Number(samples), process.env.TWEAK, process.env.ENV && JSON.parse(process.env.ENV)]);
    const name = basename(f, '.vox');
    await writeFile(`${out}/${name}-ours${process.env.SUFFIX ?? ''}.png`, Buffer.from(r.png, 'base64'));
    console.log(name, `${Math.round(r.ms)} ms`, 'errors', JSON.stringify(r.errors), 'unsupported', JSON.stringify(r.unsupported));
  }
} finally { await context.close(); }
