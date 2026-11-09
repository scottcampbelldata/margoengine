import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readKTX2Index } from '../dist/ktx2-file.js';

const folder = new URL('./fixtures/basis134/', import.meta.url),
  read = (name) => readFileSync(new URL(name, folder)),
  manifest = JSON.parse(read('manifest.json')),
  baseline = JSON.parse(read('baseline.json')),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('licensed Basis replacements retain every old target and image', () => {
  assert.equal(manifest.source.license, 'CC0-1.0');
  assert.equal(hash(read(manifest.source.file)), manifest.source.sha256);
  assert.equal(manifest.files.length, 4);
  assert.equal(baseline.pairs, 45);
  assert.equal(baseline.images, 250);
  for (const entry of manifest.files) {
    assert.equal(entry.license, 'CC0-1.0');
    const fixture = entry.file.endsWith('.basis')
      ? read(entry.file)
      : readFileSync(new URL('./fixtures/ktx2-hdr/cube-uastc-hdr.ktx2', import.meta.url));
    assert.equal(hash(fixture), entry.sha256);
    const record = baseline.records.find((row) => row.file === entry.file);
    assert.equal(record.sha256, entry.sha256);
    for (const target of record.targets) {
      assert.ok(Number.isFinite(target.mse));
      for (const image of target.images) {
        assert.match(image.sha256, /^[a-f0-9]{64}$/);
        assert.ok(Number.isFinite(image.mse) && image.mse >= 0);
      }
    }
    if (entry.file.endsWith('.basis')) {
      const view = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength),
        description = view.getUint32(65, true);
      assert.equal(view.getUint16(0, true), 0x4273);
      assert.equal(fixture[20], entry.uastc ? 1 : 0);
      assert.equal(!!(view.getUint16(21, true) & 4), entry.alpha);
      assert.equal(view.getUint16(description + 5, true), entry.width);
      assert.equal(view.getUint16(description + 7, true), entry.height);
      assert.equal(hash(gunzipSync(read(entry.file + '.rgba8.gz'))), entry.sourceSha256);
    } else {
      const index = readKTX2Index(fixture);
      assert.equal(index.width, 96);
      assert.equal(index.height, 96);
      assert.equal(index.faceCount, 6);
      assert.equal(index.levels.length, 7);
    }
  }
});

test('HDR cube has six pinned independent linear sources with retained dynamic range', () => {
  const cube = manifest.files.find((entry) => entry.faces);
  assert.equal(new Set(cube.faces.map((f) => f.sha256)).size, 6);
  for (const { face, sha256 } of cube.faces) {
    const raw = gunzipSync(read(`cc0-hdr-face${face}.rgba32f.gz`));
    assert.equal(hash(raw), sha256);
    assert.equal(raw.length, 96 * 96 * 16);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let maximum = 0;
    for (let i = 0; i < 96 * 96; i++) {
      for (let c = 0; c < 3; c++) {
        const value = view.getFloat32(i * 16 + c * 4, true);
        assert.ok(Number.isFinite(value) && value >= 0);
        maximum = Math.max(maximum, value);
      }
      assert.equal(view.getFloat32(i * 16 + 12, true), 1);
    }
    assert.ok(maximum > 1);
  }
});
