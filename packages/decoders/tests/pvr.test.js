// PVR files of PVRTC 1 data (@margoengine/decoders/pvr), on real files from PowerVR's SDK and cocos2d-x. records.json holds
// the output of an outside decoder (texture2ddecoder 1.0.6) for every level 8 texels wide or more; see fixtures/pvr/NOTICE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodePVRTC, parsePVR, pvrtcBytes } from '../dist/pvr.js';

const dir = new URL('./fixtures/pvr/', import.meta.url),
  read = (name) => new Uint8Array(readFileSync(new URL(name, dir))),
  records = JSON.parse(readFileSync(new URL('records.json', dir), 'utf8')),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('real files decode to the bytes of an outside decoder, 2 and 4 bits a texel, both header versions', () => {
  let levels = 0;
  for (const [name, record] of Object.entries(records)) {
    const file = parsePVR(read(name));
    assert.equal(file.mipmaps.length, record.levels, name);
    assert.equal(file.width, record.width, name);
    assert.equal(file.height, record.height, name);
    for (const [level, expected] of Object.entries(record.sha256)) {
      assert.equal(sha(file.mipmaps[level].data), expected, `${name} level ${level}`);
      levels++;
    }
  }
  assert.ok(levels >= 10);
});

test('the shape of a file: format, alpha, sizes down to 1 texel', () => {
  const fern = parsePVR(read('fern.pvr'));
  assert.equal(fern.target, 'pvr');
  assert.equal(fern.dimension, '2d');
  assert.equal(fern.layers, 1);
  assert.match(fern.format, /^rgba8unorm(-srgb)?$/);
  assert.equal(fern.format.endsWith('srgb'), fern.srgb);
  const last = fern.mipmaps.at(-1);
  assert.deepEqual([last.width, last.height, last.data.length], [1, 1, 4]);
  assert.equal(pvrtcBytes(1, 1, false), 32);
  assert.equal(pvrtcBytes(16, 16, true), 64);
  const tiny = parsePVR(read('Ground_Western_Village_roughness.pvr'));
  assert.deepEqual([tiny.width, tiny.height], [2, 2]);
});

// The real pairs are not the same data: 73 of 4,096 and 952 of 8,192 payload bytes differ, so each file is checked against the
// outside decoder above, and here the old file's data goes under the version 3 header, which has no metadata.
test('the old and the version 3 header read the same data alike', () => {
  for (const name of ['test_image_pvrtc2bpp', 'test_image_pvrtc4bpp']) {
    const old = read(`${name}.pvr`),
      moved = read(`${name}_v3.pvr`);
    moved.set(old.subarray(52), 52);
    const [a, b] = [parsePVR(old), parsePVR(moved)];
    assert.deepEqual([a.width, a.height, a.format, a.mipmaps.length], [b.width, b.height, b.format, b.mipmaps.length]);
    assert.equal(sha(a.mipmaps[0].data), sha(b.mipmaps[0].data));
  }
});

test('refusals name the way out', () => {
  const v3 = read('test_image_pvrtc4bpp_v3.pvr'),
    edited = (at, value) => {
      const bytes = v3.slice();
      new DataView(bytes.buffer).setUint32(at, value, true);
      return bytes;
    };
  assert.throws(() => parsePVR(new Uint8Array(8)), /too short for a header/);
  assert.throws(() => parsePVR(new Uint8Array(64)), /not a PVR file/);
  assert.throws(() => parsePVR(edited(0, 0x50565203)), /big-endian/);
  assert.throws(() => parsePVR(edited(8, 7)), /pixel format 7 is not PVRTC 1/);
  assert.throws(() => parsePVR(edited(32, 4)), /3D textures/);
  assert.throws(() => parsePVR(edited(28, 100)), /power-of-two/);
  assert.throws(() => parsePVR(v3.subarray(0, 4000)), /too few for its header's levels/);
  assert.throws(() => parsePVR('old.pvr'), TypeError);
  assert.throws(() => decodePVRTC(new Uint8Array(4), 8, 8, false), RangeError);
  assert.throws(() => decodePVRTC(new Uint8Array(4096), 12, 8, false), RangeError);
});
