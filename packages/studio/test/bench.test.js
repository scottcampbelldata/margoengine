import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openBench } from '../dist/bench.js';

const canvas = () => ({ getContext() {}, clientWidth: 100, clientHeight: 50, width: 0, height: 0, dataset: {} });

test('openBench rejects what is not a canvas before opening anything', async () => {
  await assert.rejects(openBench(null), TypeError);
  await assert.rejects(openBench({}), TypeError);
});

test('openBench rejects an invalid backbuffer size before opening anything', async () => {
  await assert.rejects(openBench(canvas(), { pixelRatio: 0 }), RangeError);
  await assert.rejects(openBench(canvas(), { maxWidth: 4 }), RangeError);
});

test('an aborted signal marks data-error and opens no engine', async () => {
  const target = canvas(),
    errors = [];
  await assert.rejects(
    openBench(target, { signal: AbortSignal.abort(), onError: (e) => errors.push(e) }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(errors.length, 1);
  assert.ok(target.dataset.error);
  assert.equal(target.dataset.ready, undefined);
  assert.equal(target.width, 100, 'the backbuffer is sized from the layout box before start-up');
});

test('the bench loads every optional package lazily, so a page pays only for what it turns on', async () => {
  const source = await readFile(new URL('../dist/bench.js', import.meta.url), 'utf8');
  for (const name of ['webgl2-compat', 'shadows', 'tonemap', 'post', 'controls'])
    assert.doesNotMatch(source, new RegExp(`^import[^;]*@margoengine/${name}`, 'm'), name);
});
