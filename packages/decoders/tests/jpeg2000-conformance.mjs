// The decoder tests of Rec. ITU-T T.803 (11/2002) | ISO/IEC 15444-4 over `decoders/jpeg2000`: every codestream against
// its reference components (the crate's `t803` example, Tables C.1, C.4, C.6 and C.7) and every JP2 file against its
// sRGB reference picture (Table G.1, a peak difference of at most 4). The set is not redistributed: unpack
// T-REC-T.803-200211.zip from itu.int into a folder outside the repository and run, after
// `npm run build --workspace=@margoengine/decoders`, with cargo on the path:
//   node packages/decoders/tests/jpeg2000-conformance.mjs <folder holding J2KP4files>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJPEG2000 } from '../dist/jpeg2000.js';
import { parseTIFF } from '../dist/tiff.js';

const folder = process.argv[2];
assert.ok(folder, 'usage: node packages/decoders/tests/jpeg2000-conformance.mjs <folder holding J2KP4files>');
const crate = fileURLToPath(new URL('../jpeg2000-kernel', import.meta.url));
const codestreams = spawnSync('cargo', ['run', '--quiet', '--release', '--example', 't803', '--', resolve(folder)], {
  cwd: crate,
  stdio: 'inherit',
  timeout: 600_000,
});
assert.equal(codestreams.status, 0, 'codestream reference components out of their bounds');

const wasm = readFileSync(new URL('../dist/jpeg2000.wasm', import.meta.url));
globalThis.fetch = async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } });
const read = await loadJPEG2000(),
  files = join(folder, 'J2KP4files');
let failed = 0;
for (let n = 1; n <= 9; n++) {
  const reference = parseTIFF(new Uint8Array(readFileSync(join(files, 'reference_jp2', `jp2_${n}.tif`))));
  assert.ok(reference.data instanceof Uint8Array, `jp2_${n}.tif is expected to hold 8-bit samples`);
  const image = read(new Uint8Array(readFileSync(join(files, 'testfiles_jp2', `file${n}.jp2`))));
  assert.deepEqual([image.width, image.height], [reference.width, reference.height], `file${n}.jp2 size`);
  let peak = 0;
  for (let i = 0; i < reference.data.length; i++)
    if (i % 4 !== 3) peak = Math.max(peak, Math.abs(image.data[i] - reference.data[i]));
  if (peak > 4) failed++;
  console.log(`file${n}.jp2  ${peak > 4 ? 'FAIL' : 'pass'}  peak ${peak}/4`);
}
assert.equal(failed, 0, `${failed} JP2 files out of their bounds`);
console.log('T.803: every codestream and JP2 test passes');
