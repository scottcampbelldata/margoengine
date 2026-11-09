// The same raw WebGPU draw program through the existing Dawn development dependency, without a browser.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'webgpu';
import { blendRepeatRoot, blendRepeatScene, sourceSha256 } from './blend-repeat-scene.mjs';

const value = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const backend = value('backend', 'd3d12'),
  vendor = value('vendor', 'nvidia'),
  frames = Number(value('frames', '200'));
assert.ok(['d3d11', 'd3d12'].includes(backend));
assert.ok(['nvidia', 'amd'].includes(vendor));
assert.ok(Number.isInteger(frames) && frames >= 2 && frames <= 4096);
const root = blendRepeatRoot(),
  data = await blendRepeatScene(root),
  out = join(root, 'determinism', `node-${backend}-${vendor}-${Date.now()}-${process.pid}`);
mkdirSync(out, { recursive: true });
const navigator = { gpu: create([`backend=${backend}`, `adapter=${vendor === 'amd' ? 'AMD' : 'NVIDIA'}`]) },
  window = {},
  html = readFileSync(new URL('./blend-repeat.html', import.meta.url), 'utf8'),
  script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
// Only our checked-in diagnostic is evaluated. The WebGL branch is never called here.
new Function('navigator', 'window', 'crypto', script)(navigator, window, webcrypto);
const timer = setTimeout(() => {
  console.error('Dawn blend repeat exceeded its 120-second process deadline');
  process.exit(124);
}, 120000);
let result;
try {
  result = await window.repeatBlend(data, { api: 'webgpu', samples: 4, frames });
} finally {
  clearTimeout(timer);
  navigator.gpu = undefined;
}
delete result.first;
const variants = new Set(result.hashes).size;
writeFileSync(
  join(out, 'repeat.json'),
  JSON.stringify({ backend, vendor, frames, sourceSha256, inputSha256: data.inputSha256, ...result }, null, 2) + '\n',
);
console.log('RESULT', JSON.stringify({ backend, frames, renderer: result.renderer, variants, out }));
assert.equal(variants, 1, 'Identical blend draws must produce identical bytes in every frame');
