// Renders skin-sheet.html: a loaded person in the poses that load skin and clothes hardest, from the front, the
// three-quarter and the side, with textures stripped so the folds and bulges show. Writes
// test-results/humans/skin-sheet-<name>-<skinning>-<backend>.png and a .json of each row's joint world matrices.
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/humans/test/skin-sheet.browser.mjs --model=x.glb
//     [--skinning=linear|dual-quaternion|...] [--rows=<regex>] [--out=<dir>]
// Fails on a GPU or page error.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { prepare } from './glb-prepare.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const modelFile = arg('model'), skinning = arg('skinning'), rows = arg('rows') ?? null,
  outDir = arg('out') ?? 'test-results/humans';
assert.ok(modelFile, '--model=<file.glb> is required');
mkdirSync('test-results/humans', { recursive: true });
mkdirSync(outDir, { recursive: true });
const name = basename(modelFile, '.glb');
writeFileSync('test-results/humans/skin-sheet-model.glb', prepare(new Uint8Array(readFileSync(modelFile))));
const { page, close, hardware } = await openBrowser({ startPath: '/packages/humans/test/skin-sheet.html', port: 'free' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const backend = hardware.compat ? 'webgl2' : 'webgpu',
    result = await page.evaluate((o) => window.renderSheet(o), { model: '/test-results/humans/skin-sheet-model.glb', skinning, rows }),
    file = join(outDir, `skin-sheet-${name}-${skinning ?? 'default'}-${backend}.png`),
    png = Buffer.from(result.png, 'base64');
  writeFileSync(file, png);
  writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify(result.poses));
  console.log(`${backend}: ${file}, ${png.length} bytes`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
} finally {
  await close();
}
