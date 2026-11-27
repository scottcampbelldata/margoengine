// addCAD from @margoengine/cad-import/stage: argument checks, and a stage disposed (or a signal aborted) before the import
// rejects with AbortError and adds nothing. The loader is cad's own module, so addCAD imports it directly instead of
// through the stage's optional-package helper (whose copy here duplicated the stage's own code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { addCAD } from '@margoengine/cad-import/stage';

const url = (extension) => `https://example.test/part.${extension}`;

/** The parts of a stage addCAD reads before it loads anything. */
const stage = (signal = new AbortController().signal) => ({
  signal,
  engine: {},
  fit: () => assert.fail('nothing may be fitted'),
});

test('addCAD checks its arguments before it loads anything', async () => {
  await assert.rejects(addCAD(stage(), url('step'), { fit: 'yes' }), {
    name: 'TypeError',
    message: /^Invalid fit: expected a boolean/,
  });
  await assert.rejects(addCAD(stage(), url('unknown')), { name: 'TypeError', message: /^Specify format/ });
});

test('a disposed stage or an aborted signal rejects with AbortError and adds nothing', async () => {
  const disposed = new AbortController();
  disposed.abort();
  await assert.rejects(addCAD(stage(disposed.signal), url('step')), { name: 'AbortError' });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(addCAD(stage(), url('stl'), { signal: caller.signal }), { name: 'AbortError' });
});
