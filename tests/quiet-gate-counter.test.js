// 213ecac6a: Win32_Processor.LoadPercentage read 18-97% from call to call on an idle desktop, so the quiet gate never passed.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const answers = [];
const queries = [];
mock.module('node:child_process', {
  namedExports: {
    execFileSync(_file, args) {
      queries.push(args.at(-1));
      return answers.shift() ?? '';
    },
  },
});
const { cpuLoad } = await import('../scripts/quiet-gate.mjs');

test('cpuLoad reads the processor-time counter and falls back to LoadPercentage only without it', () => {
  answers.push('7', '97');
  assert.equal(cpuLoad(), 7);
  assert.match(queries[0], /PercentProcessorTime/);
  assert.equal(queries.length, 1);
  answers.length = 0;
  answers.push('', '42');
  assert.equal(cpuLoad(), 42);
  assert.match(queries[2], /LoadPercentage/);
});
