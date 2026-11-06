import test from 'node:test';
import assert from 'node:assert/strict';
import { Picking, Selection } from '../dist/index.js';

test('pickMany on a detached Picking rejects with the same coded error as pick', async () => {
  await assert.rejects(new Picking().pickMany([[1, 1]]), { name: 'MargoError', code: 'state', message: /attach/ });
});

test('selection and picking throw coded errors that name the fix', () => {
  assert.throws(() => new Selection().setup({ gpu: null }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /WebGPU/,
  });
  assert.throws(() => new Picking().setup({ gpu: null }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /WebGPU/,
  });
});

test('a disposed selection throws a disposed MargoError', () => {
  const selection = new Selection();
  selection.dispose();
  assert.throws(() => selection.set([]), { name: 'MargoError', code: 'disposed', message: /create a new Selection/ });
  assert.throws(() => selection.add({}), { name: 'MargoError', code: 'disposed' });
});

test('selection validation errors keep their types and say what to pass', () => {
  assert.throws(() => new Selection({ name: '' }), { name: 'TypeError', message: /options\.name/ });
  assert.throws(() => new Selection({ width: 0 }), { name: 'RangeError', message: /width 1-32/ });
  assert.throws(() => new Selection({ xray: { dash: -1 } }), { name: 'RangeError', message: /dash 0-256/ });
});
