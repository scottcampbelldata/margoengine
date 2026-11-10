import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertValidManifests,
  assertValidTrackedManifests,
  jsonProblems,
  manifestProblems,
} from '../scripts/support/manifest-json.mjs';

const root = resolve(import.meta.dirname, '..');
const files = ['package.json', 'packages/a/package.json', 'packages/a/src/data.json', 'docs/package.json'];
const reader = (map) => (f) => map[f] ?? '{}';

test('valid manifests pass', () => {
  const ok = '{\n  "name": "a",\n  "scripts": { "x": "y" },\n  "files": ["a", 1, true, null]\n}\n';
  assert.deepEqual(jsonProblems(ok), []);
  assert.doesNotThrow(() => assertValidManifests(files, reader({ 'package.json': ok, 'packages/a/package.json': ok })));
});

test('a missing comma is reported with file and line', () => {
  const bad = '{\n  "scripts": {\n    "a": "1"\n    "b": "2"\n  }\n}\n';
  const found = manifestProblems(files, reader({ 'packages/a/package.json': bad }));
  assert.equal(found.length, 1);
  assert.match(found[0], /^packages\/a\/package\.json: line 4:/);
  assert.throws(() => assertValidManifests(files, reader({ 'packages/a/package.json': bad })), /packages\/a\/package\.json: line 4/);
});

test('a duplicate key fails even when the JSON parses', () => {
  const dup = '{\n  "scripts": {\n    "test:gpu": "a",\n    "other": "b",\n    "test:gpu": "c"\n  }\n}\n';
  assert.doesNotThrow(() => JSON.parse(dup));
  const found = manifestProblems(files, reader({ 'package.json': dup }));
  assert.deepEqual(found, ['package.json: line 5: duplicate key "test:gpu"']);
  assert.throws(() => assertValidManifests(files, reader({ 'package.json': dup })), /duplicate key "test:gpu"/);
});

test('the same key in different objects is allowed; non-manifests are ignored', () => {
  assert.deepEqual(jsonProblems('{"a":{"x":1},"b":{"x":2}}'), []);
  assert.deepEqual(manifestProblems(files, reader({ 'packages/a/src/data.json': '{{' })), []);
});

test('truncated and trailing content are rejected', () => {
  assert.notDeepEqual(jsonProblems('{"a":'), []);
  assert.notDeepEqual(jsonProblems('{"a":1,}'), []);
  assert.notDeepEqual(jsonProblems('{"a":1} x'), []);
});

test('the real repository manifests pass and hygiene calls the check', () => {
  assert.doesNotThrow(() => assertValidTrackedManifests(root));
  assert.match(readFileSync(resolve(root, 'scripts/hygiene.js'), 'utf8'), /assertValidTrackedManifests\(root\);/);
});
