import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {exportUSDZ} from '../dist/index.js';
import {exportUSDZ as Original} from '@margoengine/exporters';
test('standalone USDZ serializer preserves the tested exporter and input validation', () => {assert.equal(exportUSDZ, Original); assert.throws(() => exportUSDZ({nodes: []}), /mesh|scene|nodes/i);});

test('standalone USDZ entry imports the isolated serializer subpath', async () => {
  const wrapper = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.match(wrapper, /from ['"]@margoengine\/exporters\/usdz['"]/);
});
