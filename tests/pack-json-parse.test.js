// 4156bb491: core's prepack prints a line before npm pack's JSON, so parsing the whole output failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the package test reads npm pack JSON after whatever prepack printed', () => {
  const source = readFileSync(new URL('../scripts/modern-package-tests.js', import.meta.url), 'utf8'),
    body = /const fromArray = (\(text\) => [^\n]+);/.exec(source)?.[1];
  assert.ok(body, 'fromArray is still how the output is read');
  const fromArray = new Function(`return ${body}`)();
  const json = '[\n  { "name": "@margoengine/core" }\n]';
  assert.deepEqual(JSON.parse(fromArray(`catalog: 93 packages\nnpm warn something\n${json}`)), JSON.parse(json));
  assert.deepEqual(JSON.parse(fromArray(json)), JSON.parse(json));
  assert.match(source, /JSON\.parse\(fromArray\(/);
});
