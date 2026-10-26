// SPZ and SOG readers (@margoengine/splats/data) against real captures. The fixtures are slices of Niantic's sample
// splats (test/fixtures/NOTICE.md); the reference PLY files are PlayCanvas splat-transform's decodes of the same data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { parsePly, parseSog, parseSpz } from '../dist/data.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const buffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/** Largest absolute difference per attribute between two clouds in the same order. */
function difference(a, b) {
  assert.equal(a.positions.length, b.positions.length, 'splat count');
  const out = {};
  for (const key of ['positions', 'covariances', 'colors', 'sphericalHarmonics']) {
    assert.equal(a[key]?.length, b[key]?.length, `${key} length`);
    let max = 0;
    for (let i = 0; i < (a[key]?.length ?? 0); i++) max = Math.max(max, Math.abs(a[key][i] - b[key][i]));
    out[key] = max;
  }
  return out;
}

test('parseSpz reads a real SPZ version 2 capture exactly like the reference decoder', async () => {
  const reference = parsePly(fixture('raccoon-v2.ply')),
    splats = await parseSpz(fixture('raccoon-v2.spz'));
  assert.equal(splats.positions.length / 3, 8385);
  assert.equal(splats.sphericalHarmonics.length / 8385 / 3, 16);
  const d = difference(splats, reference);
  assert.ok(
    d.positions < 1e-6 && d.covariances < 1e-6 && d.colors < 1e-5 && d.sphericalHarmonics < 1e-5,
    JSON.stringify(d),
  );
  const lizard = await parseSpz(fixture('lizard-v2.spz'));
  assert.equal(lizard.positions.length / 3, 8109);
});

test('parseSpz reads SPZ version 3 (smallest-three rotations) within quantisation of the source', async () => {
  const d = difference(await parseSpz(fixture('raccoon-v3.spz')), parsePly(fixture('raccoon-v2.ply')));
  assert.ok(
    d.positions < 1e-3 && d.covariances < 1e-2 && d.colors < 0.02 && d.sphericalHarmonics < 0.05,
    JSON.stringify(d),
  );
});

test('parseSpz refuses version 4 with a coded error and rejects damaged files', async () => {
  await assert.rejects(
    parseSpz(fixture('raccoon-v4.spz')),
    (e) => e.name === 'MargoError' && e.code === 'unsupported' && /version 3/.test(e.message),
  );
  await assert.rejects(parseSpz(new Uint8Array(40)), RangeError);
  await assert.rejects(parseSpz('nope'), TypeError);
  const whole = fixture('raccoon-v2.spz');
  await assert.rejects(parseSpz(whole.subarray(0, whole.length - 400)), RangeError);
  await assert.rejects(parseSpz(whole, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
});

test('parseSpz keeps splats valid after rotation decoding (regression: v3 rotations unit length)', async () => {
  const s = await parseSpz(fixture('raccoon-v3.spz'));
  for (let i = 0; i < s.covariances.length; i += 6) {
    const trace = s.covariances[i] + s.covariances[i + 3] + s.covariances[i + 5];
    assert.ok(trace > 0 && Number.isFinite(trace));
  }
});

test('parseSog reads a real bundled SOG exactly like the reference decoder', async () => {
  const reference = parsePly(fixture('raccoon-sog.ply')),
    splats = await parseSog(fixture('raccoon.sog'));
  assert.equal(splats.positions.length / 3, 8385);
  const d = difference(splats, reference);
  assert.ok(
    d.positions < 1e-5 && d.covariances < 1e-5 && d.colors < 1e-5 && d.sphericalHarmonics < 1e-5,
    JSON.stringify(d),
  );
});

test('SOG agrees with its source scene within quantisation (reordered, so compared by statistics)', async () => {
  const source = parsePly(fixture('raccoon-v2.ply')),
    sog = await parseSog(fixture('raccoon.sog'));
  const mean = (a, stride, k) => {
    let s = 0;
    for (let i = k; i < a.length; i += stride) s += a[i];
    return s / (a.length / stride);
  };
  for (let k = 0; k < 3; k++) {
    const range =
      Math.max(...source.positions.filter((_, i) => i % 3 === k)) -
      Math.min(...source.positions.filter((_, i) => i % 3 === k));
    assert.ok(Math.abs(mean(source.positions, 3, k) - mean(sog.positions, 3, k)) < range * 1e-3, `position mean ${k}`);
  }
  for (let k = 0; k < 4; k++)
    assert.ok(Math.abs(mean(source.colors, 4, k) - mean(sog.colors, 4, k)) < 0.01, `colour mean ${k}`);
});

/** Pulls every entry out of a ZIP (using node:zlib, so the test does not depend on the reader under test). */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    files = {};
  let eocd = bytes.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let at = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
    const method = view.getUint16(at + 10, true),
      size = view.getUint32(at + 20, true),
      n = view.getUint16(at + 28, true),
      skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true),
      local = view.getUint32(at + 42, true),
      name = bytes.subarray(at + 46, at + 46 + n).toString(),
      data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true),
      raw = bytes.subarray(data, data + size);
    files[name] = method === 8 ? inflateRawSync(raw) : raw;
    at += 46 + n + skip;
  }
  return files;
}

/** Writes a ZIP with every entry stored (method 0) or deflated (method 8). */
function zip(files, method) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = method === 8 ? deflateRawSync(data) : data,
      nameBytes = Buffer.from(name),
      head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    parts.push(head, nameBytes, body);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

test('parseSog reads loose files and stored or deflated archives to the same result', async () => {
  const files = unzip(fixture('raccoon.sog')),
    expected = await parseSog(fixture('raccoon.sog'));
  assert.ok(files['meta.json'] && files['means_l.webp'] && files['shN_labels.webp']);
  for (const splats of [await parseSog(files), await parseSog(zip(files, 0)), await parseSog(buffer(zip(files, 8)))])
    assert.deepEqual(difference(splats, expected), { positions: 0, covariances: 0, colors: 0, sphericalHarmonics: 0 });
});

test('parseSog rejects what it cannot read with the fix in the message', async () => {
  const files = unzip(fixture('raccoon.sog')),
    meta = JSON.parse(files['meta.json']),
    withMeta = (changes) => ({ ...files, 'meta.json': Buffer.from(JSON.stringify({ ...meta, ...changes })) });
  await assert.rejects(parseSog(new Uint8Array(30)), RangeError);
  await assert.rejects(parseSog(5), TypeError);
  await assert.rejects(parseSog({ ...files, 'meta.json': undefined }), TypeError);
  await assert.rejects(parseSog({ 'means_l.webp': files['means_l.webp'] }), /meta\.json/);
  await assert.rejects(parseSog(withMeta({ version: 1 })), /version 1/);
  await assert.rejects(parseSog(withMeta({ model: '2dgs' })), (e) => e.code === 'unsupported');
  await assert.rejects(parseSog(withMeta({ count: 10_000_000 })), RangeError);
  await assert.rejects(parseSog({ ...files, 'quats.webp': files['quats.webp'].subarray(0, 100) }), RangeError);
  await assert.rejects(
    parseSog({ ...files, 'quats.webp': Buffer.from('RIFF\0\0\0\0WEBPVP8 \0\0\0\0') }),
    (e) => e.code === 'unsupported',
  );
  await assert.rejects(parseSog(fixture('raccoon.sog'), { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
});

// The complete captures are 18-24 MB, so they stay outside the repository (test/fixtures/NOTICE.md).
const samples = process.env.MARGO_SPLAT_SAMPLES;
const full = (name) => (samples && existsSync(join(samples, name)) ? join(samples, name) : undefined);
for (const [name, count, slab] of [
  ['racoonfamily.spz', 932_560, 'raccoon-v2.ply'],
  ['hornedlizard.spz', 786_233, undefined],
]) {
  test(`parseSpz reads the complete ${name} sample`, {
    skip: full(name) ? false : `set MARGO_SPLAT_SAMPLES to a folder holding ${name} to run this`,
  }, async () => {
    const splats = await parseSpz(readFileSync(full(name)));
    assert.equal(splats.positions.length / 3, count);
    assert.equal(splats.sphericalHarmonics.length / count / 3, 16);
    if (!slab) return;
    // Every splat of the committed slice must appear, bit for bit, in the complete file.
    const reference = parsePly(fixture(slab)),
      index = new Map();
    for (let i = 0; i < count; i++) {
      const key = splats.positions.subarray(i * 3, i * 3 + 3).join();
      index.set(key, [...(index.get(key) ?? []), i]);
    }
    for (let j = 0; j < reference.positions.length / 3; j++) {
      const candidates = index.get(reference.positions.subarray(j * 3, j * 3 + 3).join());
      assert.ok(candidates, `splat ${j} missing`);
      // Splats can share a centre, so one candidate must match in every attribute.
      assert.ok(
        candidates.some((i) => {
          for (let k = 0; k < 6; k++)
            if (Math.abs(splats.covariances[i * 6 + k] - reference.covariances[j * 6 + k]) > 1e-6) return false;
          for (let k = 0; k < 4; k++)
            if (Math.abs(splats.colors[i * 4 + k] - reference.colors[j * 4 + k]) > 1e-5) return false;
          return true;
        }),
        `splat ${j} differs`,
      );
    }
  });
}
