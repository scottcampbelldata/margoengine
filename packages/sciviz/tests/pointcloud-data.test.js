import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readLASHeader } from '@margoengine/points/las';
import { lazChunks } from '@margoengine/points/laz';
const folder = new URL('../../../examples/assets/sciviz/pointcloud/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', folder)));
for (const record of manifest.nodes)
  test(`USGS EPT ${record.key}: every raw record matches independent lazrs`, async () => {
    const bytes = new Uint8Array(readFileSync(new URL(`${record.key}.laz`, folder)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    const { header, records } = readLASHeader(bytes),
      hash = createHash('sha256');
    let size = 0;
    for await (const chunk of lazChunks(bytes, header, records)) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    assert.equal(header.pointCount, record.count);
    assert.equal(size, record.count * header.pointRecordLength);
    assert.equal(hash.digest('hex'), record.recordsSha256);
  });
