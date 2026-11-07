import test from 'node:test';
import assert from 'node:assert/strict';
import { askedElements, judge, namedFiles, placeOf, runInNode } from '../scripts/run-readme-examples.mjs';

const samples = { byName: new Map(), byExtension: new Map() };

test('an example that throws fails, with its error as the reason', async () => {
  const result = await runInNode({ id: 'runner-test/throws', code: "throw new RangeError('wrong size');" }, samples);
  assert.equal(result.result, 'fail');
  assert.match(result.reason, /RangeError: wrong size/);
});

test('a promise left rejected fails an example', async () => {
  const result = await runInNode({ id: 'runner-test/rejects', code: "Promise.reject(new Error('lost'));" }, samples);
  assert.equal(result.result, 'fail');
  assert.match(result.reason, /lost/);
});

test('TypeScript runs as a reader would paste it', async () => {
  const result = await runInNode({ id: 'runner-test/passes', code: 'const size: number = 2;\nconsole.log(size);' }, samples);
  assert.equal(result.result, 'pass');
});

test('a failure off the known list is fresh, and a known one is not', () => {
  const report = [
    { id: 'a/readme-0', result: 'fail', reason: 'x' },
    { id: 'b/readme-0', result: 'fail', reason: 'y' },
  ];
  assert.deepEqual(
    judge(report, { 'a/readme-0': 'sample: x' }, false).fresh.map(({ id }) => id),
    ['b/readme-0'],
  );
});

test('the known list only shrinks: an entry that passes is reported', () => {
  const report = [{ id: 'a/readme-0', result: 'pass' }];
  assert.deepEqual(judge(report, { 'a/readme-0': 'sample: x' }, false).gone, ['a/readme-0']);
});

test('a narrowed run says nothing of the entries it left out', () => {
  assert.deepEqual(judge([], { 'a/readme-0': 'sample: x' }, true).gone, []);
});

test('an example goes where its code can run', () => {
  assert.equal(placeOf("import { readFile } from 'node:fs/promises';"), 'node');
  assert.equal(placeOf("const c = document.querySelector('canvas');"), 'page');
  assert.equal(placeOf('const a = 1;'), undefined);
});

test('the files and elements an example asks for are found', () => {
  assert.deepEqual(namedFiles("await load('/models/crate.glb');"), ['/models/crate.glb']);
  assert.ok(askedElements("document.querySelector('#viewport');").length > 0);
});
