import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';
import { browserSpeedPhase } from '../packages/compute/tests/speed-phase.mjs';

function measurements(source) {
  const { program } = parseSync('gate.js', source),
    outside = [],
    checks = [];
  let count = 0;
  function visit(node, gated = false) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'IfStatement' &&
      node.test.type === 'CallExpression' &&
      node.test.callee.name === 'speedEnabled'
    ) {
      visit(node.consequent, true);
      visit(node.alternate, gated);
      return;
    }
    if (node.type === 'CallExpression' && node.callee.name === 'check' && typeof node.arguments[0]?.value === 'string')
      checks.push({ name: node.arguments[0].value, gated });
    if (
      node.type === 'CallExpression' &&
      ((node.callee.type === 'MemberExpression' &&
        node.callee.object.name === 'performance' &&
        node.callee.property.name === 'now') ||
        ['autotune', 'tuneCompute'].includes(node.callee.name))
    ) {
      count++;
      if (!gated) outside.push(node.start);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child, gated);
      else if (value && typeof value === 'object') visit(value, gated);
    }
  }
  visit(program);
  return { count, outside, checks };
}

test('compute mixed browser suites defer throughput clocks, retaining every measurement for the active phase', () => {
  for (const [file, count] of [
    ['compute-browser.js', 2],
    ['compute-extras-browser.js', 2],
    ['compute-cpu-browser.js', 4],
    ['compute-autotune-browser.js', 5],
  ]) {
    const result = measurements(readFileSync(`packages/compute/tests/${file}`, 'utf8'));
    assert.equal(result.count, count, file);
    assert.deepEqual(result.outside, [], file);
    assert.deepEqual(
      result.checks.filter((c) => c.gated).map((c) => c.name),
      file === 'compute-autotune-browser.js'
        ? [
            'autotune measures every size this GPU allows and picks the fastest',
            'the second call and a new context with the store run nothing',
            'two-dimensional candidates run',
            'tuneCompute measures the kernels on this GPU and uses the winners',
          ]
        : [],
      'a correctness case was deferred: ' + file,
    );
    if (file === 'compute-autotune-browser.js')
      assert.deepEqual(
        result.checks.filter((c) => !c.gated).map((c) => c.name),
        [
          'every permitted SAXPY candidate computes all original 2M values',
          'every original two-dimensional candidate computes the complete grid',
          "every size of the context's own kernels gives the same integers and order",
        ],
      );
  }
});
test('clock guard rejects missing, constant and else-branch deferrals', () => {
  for (const source of [
    'performance.now()',
    'if (true) { performance.now() }',
    'if(speedEnabled()) {} else { performance.now() }',
  ])
    assert.equal(measurements(source).outside.length, 1);
  assert.deepEqual(measurements('if(speedEnabled()) { performance.now() }').outside, []);
});
test('compute browser phase uses the central default and explicit runner phase, rejecting typos', () => {
  assert.equal(browserSpeedPhase(''), 'deferred');
  assert.equal(browserSpeedPhase('?speedPhase=deferred'), 'deferred');
  assert.equal(browserSpeedPhase('?speedPhase=active'), 'active');
  assert.throws(() => browserSpeedPhase('?speedPhase=actve'), /Invalid/);
  const driver = readFileSync('packages/compute/tests/compute-browser.mjs', 'utf8');
  assert.match(driver, /compute\.html\?speedPhase=\$\{speedPhase\(\)\}/);
});
