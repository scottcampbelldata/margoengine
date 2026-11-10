import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeEXR, loadEXR } from '../dist/exr-codecs.js';
import { parseEXR } from '../dist/index.js';

const root = new URL('./fixtures/codecs/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('reference.json', root), 'utf8'));
const bytes = (name) => readFileSync(new URL(name, root));

test('standard decoder bytes match the pinned upstream provenance without checkout newline conversion', () => {
  const vendor = new URL('../vendor/exr-codecs/', import.meta.url);
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', vendor), 'utf8'));
  for (const [file, expected] of [['exrview.js', provenance.glueSha256], ['exrview.wasm', provenance.wasmSha256]])
    assert.equal(createHash('sha256').update(readFileSync(new URL(file, vendor))).digest('hex'), expected);
});

test('every remaining codec, HALF/FLOAT, scanline/tiled odd edge blocks matches native OpenEXR bits on a real photograph', async () => {
  for (const fixture of reference.fixtures) {
    const image = await decodeEXR(bytes(fixture.name + '.exr'));
    assert.equal(image.width, 37);
    assert.equal(image.height, 45);
    assert.equal(image.compression, fixture.compression);
    assert.equal(image.storage, fixture.storage);
    assert.deepEqual(image.dataWindow, { min: [-3, 7], max: [33, 51] });
    const raw = bytes(fixture.name + '.f32');
    const expected = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const got = new Uint32Array(image.data.buffer);
    assert.equal(got.length, expected.length);
    for (let i = 0; i < got.length; i++) assert.equal(got[i], expected[i], `${fixture.name} component ${i}`);
  }
});

test('complete decoder agrees with the existing clean-room ZIP/PIZ path', async () => {
  for (const file of ['synthetic-half-rgba-zip.exr', 'synthetic-float-rgb-piz.exr']) {
    const input = readFileSync(new URL('./fixtures/' + file, import.meta.url));
    const image = await decodeEXR(input),
      known = parseEXR(input);
    assert.deepEqual(new Uint32Array(image.data.buffer), new Uint32Array(known.data.buffer));
  }
});

test('multipart and named-layer selection skip incomplete root channels and retain the selected part pixels', async () => {
  const input = bytes('venice-parts.exr');
  for (const [options, expectedFile, prefix] of [
    [{}, 'venice-half-b44a.f32', 'beauty.'],
    [{ layer: 'beauty' }, 'venice-half-b44a.f32', 'beauty.'],
    [{ part: 1 }, 'venice-float-pxr24.f32', ''],
  ]) {
    const image = await decodeEXR(input, options),
      raw = bytes(expectedFile);
    assert.deepEqual(
      image.channelNames,
      ['R', 'G', 'B', 'A'].map((c) => prefix + c),
    );
    const expected = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
      got = new Uint32Array(image.data.buffer);
    for (let i = 0; i < got.length; i++) assert.equal(got[i], expected[i], `part ${options.part ?? 0} component ${i}`);
  }
});

test('bounds, malformed chunks, layer and part errors reject without retaining a decoding worker', async () => {
  const input = bytes('venice-half-dwaa.exr');
  for (const size of [0, 7, 40, input.length - 30]) await assert.rejects(decodeEXR(input.subarray(0, size)));
  await assert.rejects(decodeEXR(input, { maxPixels: 4 }), RangeError);
  await assert.rejects(decodeEXR(input, { maxBytes: 4 }), RangeError);
  await assert.rejects(decodeEXR(input, { part: 99 }), RangeError);
  await assert.rejects(decodeEXR(input, { layer: 'absent' }));
  await assert.rejects(decodeEXR(input, { timeout: 2147483648 }), RangeError);
  const image = await decodeEXR(input);
  assert.equal(image.width, 37);
});

test('fetch path, hard worker timeout and cancellation preserve rejection reasons, including a falsy reason', async () => {
  const input = bytes('venice-half-b44a-tiled.exr');
  const image = await loadEXR('data:application/octet-stream;base64,' + input.toString('base64'));
  assert.equal(image.storage, 'tiled');
  await assert.rejects(decodeEXR(input, { timeout: 1 }), { code: 'timeout' });
  const a = new AbortController();
  a.abort();
  await assert.rejects(decodeEXR(input, { signal: a.signal }), { name: 'AbortError' });
  const b = new AbortController(),
    pending = decodeEXR(input, { signal: b.signal });
  setImmediate(() => b.abort(0));
  await pending.then(
    () => assert.fail('aborted decode resolved'),
    (error) => assert.equal(error, 0),
  );
});
