// The parity report's Feature JS column: sizes recorded at run time win, and a size it cannot measure is n/a, never a
// smaller sum (p-morph read 52 KB from a build folder that had lost most of its run's chunks, against 117 KB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { featureCell, featureGzip } from '../bench/lib/feature-bytes.mjs';

const page = ['/bench/assets/page-1.js', '/bench/assets/catalog-1.js'];

test('Feature JS takes the gzip sizes the run recorded and leaves out scripts both pages fetched', () => {
  const margo = {
      info: {
        scripts: [...page, '/bench/assets/api-1.js', '/bench/assets/gltf-1.js'],
        scriptGzip: { '/bench/assets/api-1.js': 17_391, '/bench/assets/gltf-1.js': 38_277, [page[0]]: 9, [page[1]]: 9 },
      },
    },
    three = {
      info: {
        scripts: [...page, '/ext/three-webgl-parity/engine.js', '/ext/three-webgl-parity/three.core-1.mjs'],
        scriptGzip: { '/ext/three-webgl-parity/engine.js': 1_607, '/ext/three-webgl-parity/three.core-1.mjs': 150_000 },
      },
    };
  const nothing = () => assert.fail('recorded sizes need no file');
  assert.equal(featureGzip(margo, three, nothing), 17_391 + 38_277);
  assert.equal(featureGzip(three, margo, nothing), 151_607, "three's .mjs chunks count");
  delete margo.info.scriptGzip['/bench/assets/gltf-1.js'];
  assert.equal(featureGzip(margo, three, nothing), null, 'a script without a recorded size makes the sum unknown');
  assert.equal(featureCell(null), 'n/a');
  assert.equal(featureCell(117_244), '117,244');
});

test('an older run without recorded sizes is measured from the build, and a file gone from it gives n/a', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-feature-')),
    body = 'export const x = 1;'.repeat(50);
  try {
    writeFileSync(join(dir, 'api-1.js'), body);
    const fileOf = (name) => join(dir, name.split('/').pop()),
      other = { info: { scripts: page } };
    const run = (scripts) => featureGzip({ info: { scripts: [...page, ...scripts] } }, other, fileOf);
    assert.equal(run(['/bench/assets/api-1.js']), gzipSync(body, { level: 9 }).length);
    assert.equal(run(['/bench/assets/api-1.js', '/bench/assets/gone-1.js']), null, 'not a smaller number');
    // Such runs listed only .js scripts: an engine-bench page shows its entry alone, so its size is unknown.
    assert.equal(run(['/ext/three-webgl-parity/engine.js']), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
