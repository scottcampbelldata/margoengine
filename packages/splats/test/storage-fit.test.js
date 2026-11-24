import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEGREE3_SH_BYTES, STORAGE_BINDING_BYTES, fitDegree3Count, readPlyPrefix, writePlyPrefix } from '../../../scripts/rival-splats-fit.mjs';

test('degree-3 spherical harmonics fit 699050 splats in the WebGPU minimum binding', () => {
  assert.equal(DEGREE3_SH_BYTES, 192);
  assert.equal(STORAGE_BINDING_BYTES, 134_217_728);
  assert.equal(fitDegree3Count(), 699_050);
  assert.ok(699_050 * DEGREE3_SH_BYTES <= STORAGE_BINDING_BYTES);
  assert.ok(699_051 * DEGREE3_SH_BYTES > STORAGE_BINDING_BYTES);
});

test('a binary PLY prefix keeps the first vertices and rewrites the count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-splat-fit-'));
  try {
    const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nend_header\n';
    const body = Buffer.alloc(3 * 8);
    for (let i = 0; i < 6; i++) body.writeFloatLE(i + 1, i * 4);
    const source = join(dir, 'in.ply');
    const dest = join(dir, 'out.ply');
    writeFileSync(source, Buffer.concat([Buffer.from(header, 'latin1'), body]));
    const written = await writePlyPrefix(source, dest, 2);
    assert.equal(written.count, 2);
    assert.equal(written.sourceCount, 3);
    assert.equal(written.stride, 8);
    const info = readPlyPrefix(dest);
    assert.equal(info.count, 2);
    const file = readFileSync(dest);
    const start = info.headerBytes;
    assert.equal(file.readFloatLE(start), 1);
    assert.equal(file.readFloatLE(start + 4), 2);
    assert.equal(file.readFloatLE(start + 8), 3);
    assert.equal(file.readFloatLE(start + 12), 4);
    assert.equal(file.length, start + 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
