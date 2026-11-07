import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askedElements,
  goneLine,
  judge,
  listenPort,
  namedFiles,
  nodeTurns,
  pickExamples,
  placeOf,
  runInNode,
} from '../scripts/run-readme-examples.mjs';

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

test('a known entry whose example is gone fails a whole run, and says so', () => {
  const report = [{ id: 'a/readme-0', result: 'pass' }],
    { gone } = judge(report, { 'a/readme-0': 'sample: x', 'a/readme-9': 'sample: y' }, false);
  assert.deepEqual(gone, ['a/readme-0', 'a/readme-9']);
  assert.match(goneLine('a/readme-0', report), /passes, still on the known list/);
  assert.match(goneLine('a/readme-9', report), /no such example, still on the known list/);
});

// Four voxel-net examples listen on 8787: side by side one got the port, the others failed in Node and then in a page.
test('examples on one port take turns, and the rest stay side by side', () => {
  assert.equal(listenPort("await server.listen(8787, '0.0.0.0');"), '8787');
  assert.equal(listenPort('const a = 8787;'), undefined);
  const example = (id, code) => ({ id, code }),
    turns = nodeTurns([
      example('a', 'await server.listen(8787);'),
      example('b', 'const x = 1;'),
      example('c', "server.listen( 8787, '0.0.0.0');"),
      example('d', 'const y = 2;'),
      example('e', 'server.listen(9000);'),
    ]);
  assert.deepEqual(
    turns.map((turn) => turn.map(({ id }) => id)),
    [['a', 'c'], ['b'], ['d'], ['e']],
  );
});

test('--packages takes whole package names, and adds to --only', () => {
  const examples = [
      { id: 'sky/readme-0', name: 'sky' },
      { id: 'sky/readme-1', name: 'sky' },
      { id: 'sky-extra/readme-0', name: 'sky-extra' },
    ],
    ids = (options) => pickExamples(examples, options).map(({ id }) => id);
  assert.equal(ids({}).length, 3);
  assert.deepEqual(ids({ packages: ['sky'] }), ['sky/readme-0', 'sky/readme-1']);
  assert.deepEqual(ids({ packages: ['sky'], only: 'readme-1' }), ['sky/readme-1']);
  assert.deepEqual(ids({ ids: new Set(['sky-extra/readme-0']) }), ['sky-extra/readme-0']);
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
