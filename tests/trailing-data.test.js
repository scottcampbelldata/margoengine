// packages/shared/trailing-data.js (bug 39): Node 22's DecompressionStream accepts data after the end of a 'deflate'
// (22.12), 'deflate-raw' (22.12 and 22.22) or 'gzip' stream (22.12, a single trailing zero byte), which browsers and
// Node 24 reject. With hasTrailingData the
// fbx, loaders ZIP, splats SOG and voxel chunk readers reject it on every runtime; this test runs on 24 in the unit
// suite and on 22.12 and the latest 22.x in CI's node22 job.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { acceptsTrailingData, hasTrailingData } from '../packages/shared/trailing-data.js';

const FORMATS = { deflate: deflateSync, 'deflate-raw': deflateRawSync, gzip: gzipSync };
const decodes = async (bytes, format) => {
  try {
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer();
    return true;
  } catch {
    return false;
  }
};

for (const [format, compress] of Object.entries(FORMATS))
  test(`${format}: a stream with data after its end is rejected on this Node (${process.version})`, async () => {
    for (const payload of [new Uint8Array(0), new Uint8Array(24), new TextEncoder().encode('margo '.repeat(500))]) {
      const clean = compress(payload);
      assert.equal(await decodes(clean, format), true);
      assert.equal(await hasTrailingData(clean, format), false, 'a clean stream has no trailing data');
      // A copy of a gzip stream is a second gzip member, which is valid gzip (RFC 1952), not trailing data.
      for (const after of format === 'gzip' ? [[0], [1, 2, 3, 4]] : [[0], [1, 2, 3, 4], [...clean]]) {
        const junk = Uint8Array.of(...clean, ...after);
        // Strict: either the runtime rejects it, or the decode succeeds and hasTrailingData says so.
        assert.ok(
          !(await decodes(junk, format)) || (await hasTrailingData(junk, format)),
          `${after.length} bytes after`,
        );
      }
    }
  });

test('the probe matches what this runtime does', async (t) => {
  for (const format of Object.keys(FORMATS)) {
    const junk = Uint8Array.of(...FORMATS[format](new Uint8Array(8)), 0);
    assert.equal(await acceptsTrailingData(format), await decodes(junk, format), format);
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  const accepted = [];
  for (const format of Object.keys(FORMATS)) if (await acceptsTrailingData(format)) accepted.push(format);
  // Measured 2026-10-28 on the official Windows builds.
  if (major === 22 && minor === 12) assert.deepEqual(accepted, ['deflate', 'deflate-raw', 'gzip']);
  if (major === 22 && minor === 22) assert.deepEqual(accepted, ['deflate-raw']);
  if (major >= 24) assert.deepEqual(accepted, []);
  t.diagnostic(`Node ${process.version} accepts trailing data for: ${accepted.join(', ') || 'none'}`);
  assert.throws(() => acceptsTrailingData('brotli'), TypeError);
});
