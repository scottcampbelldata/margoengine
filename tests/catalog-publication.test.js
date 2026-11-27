import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationFromRegistry } from '../scripts/support/catalog-publication.mjs';

test('a package on npm at a different version than package.json is published', () => {
  const body = { 'dist-tags': { latest: '0.1.0' }, versions: { '0.1.0': {} } };
  assert.deepEqual(publicationFromRegistry('1.0.0', body), { published: true, npmVersion: '0.1.0' });
});

test('a package whose package.json version is on npm needs no separate npm version', () => {
  const body = { 'dist-tags': { latest: '1.0.0' }, versions: { '0.1.0': {}, '1.0.0': {} } };
  assert.deepEqual(publicationFromRegistry('1.0.0', body), { published: true });
});

test('a missing registry body is not published', () => {
  assert.deepEqual(publicationFromRegistry('1.0.0', null), { published: false });
  assert.deepEqual(publicationFromRegistry('1.0.0', {}), { published: false });
});
