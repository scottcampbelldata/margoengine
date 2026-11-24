import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWGSL, parseWGSL } from '../dist/wgsl.js';

test('WGSL chooses subtraction and unary negation when decrement is not valid lookahead', () => {
  for (const [expression, expected] of [['1--2', 3], ['--2', 2], ['1---2', -1], ['1----2', 3], ['2*--3', 6]]) {
    const module = checkWGSL(`const result = ${expression};`);
    assert.equal(module.globals.find((item) => item.name === 'result').value, expected, expression);
  }
  const source = 'const result = 1--2;';
  const expression = parseWGSL(source).declarations[0].decl.init;
  assert.equal(expression.op, '-');
  assert.equal(expression.right.op, '-');
  assert.equal(expression.right.start, source.indexOf('--') + 1);
  assert.equal(expression.right.end, source.indexOf(';'));
});

test('statement and for-update decrements remain decrements and malformed expressions still reject', () => {
  const module = checkWGSL('fn f(){ var x = 2; x--; for(var i=2;i>0;i--){ x++; } }');
  assert.equal(module.functions[0].body[1].op, '--');
  assert.equal(module.functions[0].body[2].update.op, '--');
  for (const source of ['const x = 1--;', 'const x = ++1;', 'fn f(){ var x=2; x--2; }'])
    assert.throws(() => checkWGSL(source), { code: 'syntax' });
});
