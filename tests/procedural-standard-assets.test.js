import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('the standard CityJSON reference retains its pinned publisher bytes across Git checkouts', () => {
  const path = 'packages/procedural/test/fixtures/buildings/twobuildings.city.json';
  const attribute = execFileSync('git', ['check-attr', 'text', '--', path], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  }).trim();
  assert.equal(attribute, `${path}: text: unset`, 'Git must not transform a hash-pinned standard fixture');
  const reference = JSON.parse(readFileSync('packages/procedural/test/fixtures/buildings/reference.json'));
  const bytes = readFileSync(path);
  assert.equal(bytes.length, reference.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
});

test('the standard Natural Earth reference retains its publisher bytes across Git checkouts', () => {
  const path = 'packages/procedural/test/fixtures/caves/ne_110m_land.geojson';
  assert.equal(
    execFileSync('git', ['check-attr', 'text', '--', path], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }).trim(),
    `${path}: text: unset`,
  );
  const ref = JSON.parse(readFileSync('packages/procedural/test/fixtures/caves/reference.json'));
  const bytes = readFileSync(path);
  assert.equal(bytes.length, ref.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
});
