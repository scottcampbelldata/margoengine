import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkOnnxReference } from './onnx-reference-cases.js';
const reference = JSON.parse(
  await readFile(new URL('./fixtures/onnx/operators-reference.json', import.meta.url), 'utf8'),
);
for (const c of reference.cases)
  test(`ONNX external reference: ${c.domain || 'ai.onnx'} ${c.id}`, () => checkOnnxReference(c));
