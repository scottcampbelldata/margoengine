// Complete outside PotreeConverter sample. Only standard data, no reference implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { externalAssets, requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';
import { PotreeSource } from '../dist/potree.js';

test('the complete outside Potree 1.7 folder preserves all 341989 coordinates and RGB values exactly', async () => {
  const folder = requireExternalAssets('potree-lion/');
  const manifest = externalAssets.filter(({ file }) => file.startsWith('potree-lion/'));
  const meta = JSON.parse(readFileSync(resolve(folder, 'cloud.js'), 'utf8'));
  const b = meta.boundingBox;
  const low = [b.lx, b.ly, b.lz],
    high = [b.ux, b.uy, b.uz];
  const origin = low.map((v, axis) => (v + high[axis]) / 2);
  const requests = new Set();
  const source = await PotreeSource.open('https://samples.test/scans/site/', {
    hierarchy: 'eager',
    attributes: 'all',
    signal: AbortSignal.timeout(30_000),
    fetch: async (url) => {
      const file = new URL(url).pathname.slice('/scans/site/'.length);
      requests.add(file);
      if (file === 'metadata.json') return new Response('', { status: 404 });
      assert.ok(
        manifest.some((item) => item.file === 'potree-lion/' + file),
        file,
      );
      return new Response(readFileSync(resolve(folder, file)));
    },
  });
  assert.equal(source.version, '1.7');
  assert.equal(source.points, 341989);
  assert.deepEqual(source.origin, origin);
  const queue = [source.root],
    names = [];
  let points = 0;
  while (queue.length) {
    const node = queue.shift();
    const data = await source.load(node, AbortSignal.timeout(30_000));
    const bytes = readFileSync(resolve(folder, 'data/r/' + node.name + '.bin'));
    assert.equal(bytes.length % 18, 0);
    assert.equal(data.positions.length, (bytes.length / 18) * 3);
    assert.equal(data.colors.length, data.positions.length);
    assert.equal(data.colorComponents, 3);
    // Independent file-space octants: x is bit 2, y bit 1, z bit 0. The records
    // are uint32 XYZ from that node's corner, RGBA8, then two oct-normal bytes.
    const min = low.slice(),
      max = high.slice();
    for (const c of node.name.slice(1)) {
      const digit = Number(c);
      for (let axis = 0; axis < 3; axis++) {
        const middle = (min[axis] + max[axis]) / 2;
        if (digit & (4 >> axis)) min[axis] = middle;
        else max[axis] = middle;
      }
    }
    for (let p = 0; p < bytes.length / 18; p++)
      for (let axis = 0; axis < 3; axis++) {
        const expected = Math.fround(bytes.readUInt32LE(p * 18 + axis * 4) * meta.scale + (min[axis] - origin[axis]));
        assert.equal(data.positions[p * 3 + axis], expected, node.name + ' point ' + p + ' axis ' + axis);
        assert.equal(data.colors[p * 3 + axis], bytes[p * 18 + 12 + axis]);
      }
    queue.push(...node.children.filter(Boolean));
    points += node.count;
    names.push(node.name);
  }
  assert.equal(points, meta.points);
  assert.equal(names.length, 77);
  assert.deepEqual(
    names.sort(),
    manifest
      .filter(({ file }) => file.endsWith('.bin'))
      .map(({ file }) => basename(file, '.bin'))
      .sort(),
  );
  assert.equal(requests.size, 80); // expected metadata probe, cloud.js, hierarchy, 77 nodes
});
