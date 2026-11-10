import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTreeText, printTreeText, MAX_TREE_TEXT_LENGTH } from '../dist/text.js';
import { BehaviorTree, parseTree } from '../dist/index.js';
import { subtree, SubtreeTree } from '../dist/subtrees.js';

test('all node types, options, weights, labels and utility edges round trip canonically', () => {
  const nodes = [
    { type: 'sequence', reactive: true, children: [{ type: 'action', name: 'go"\n☃', label: 'hello /* literal */' }] },
    { type: 'selector', reactive: false, children: [{ type: 'condition', name: 'ready' }] },
    {
      type: 'randomSelector',
      weights: [0, 2],
      children: [
        { type: 'wait', seconds: 0 },
        { type: 'wait', seconds: 1e-5 },
      ],
    },
    { type: 'parallel', success: 1, failure: 'all', children: [{ type: 'wait', seconds: 0 }] },
    {
      type: 'utility',
      inertia: 0.1,
      threshold: -0.5,
      options: [{ score: 'value', child: { type: 'action', name: 'run' } }],
    },
    ...['inverter', 'repeater', 'cooldown', 'timeout', 'guard'].map((type) => ({
      type,
      child: { type: 'wait', seconds: 0 },
      ...(type === 'repeater'
        ? { count: 2, until: 'failure' }
        : type === 'guard'
          ? { condition: 'ready' }
          : type === 'cooldown' || type === 'timeout'
            ? { seconds: 1.25 }
            : {}),
    })),
  ];
  for (const root of nodes) {
    const document = { format: 'margo-behavior', version: 1, root };
    const text = printTreeText(document);
    assert.deepEqual(parseTreeText(text), document);
    assert.equal(printTreeText(parseTreeText(text)), text);
    assert.deepEqual(parseTree(parseTreeText(text)), document);
  }
});
test('comments, bare roots and registered references preserve standard runtime behavior', () => {
  const source = `# initial comment
    tree { /* node comment */
      sequence(reactive=true) { condition(name="yes") // line comment
        subtree(name="jump")
      }
    }`;
  const registry = { jump: { type: 'action', name: 'go' } };
  const document = parseTreeText(source, { subtrees: registry });
  assert.deepEqual(document.root.children[1], subtree('jump'));
  assert.deepEqual(parseTreeText(printTreeText(document, { subtrees: registry }), { subtrees: registry }), document);
  const handlers = { conditions: { yes: () => true }, actions: { go: () => true } };
  assert.equal(new SubtreeTree(document, { subtrees: registry, handlers }).tick(), 'success');
  assert.equal(new BehaviorTree(parseTreeText('action(name="go")', { handlers }), { handlers }).tick(), 'success');
});
test('syntax errors name a line/column, semantic errors name a path, hostile input is bounded', () => {
  for (const text of [
    '',
    'tree {',
    'wait(seconds=01)',
    'action(name="unterminated)',
    'wait(seconds=1e999)',
    'wait(seconds=0,seconds=1)',
    'sequence { action(name="a")',
    'wait(seconds=1) wait(seconds=2)',
    'action(name="a") { wait(seconds=0) }',
    '/* unfinished',
    'utility { action(name="bad") }',
    'inverter { wait(seconds=0) wait(seconds=0) }',
  ])
    assert.throws(() => parseTreeText(text), /Tree text \d+:\d+:/, text);
  for (const text of ['sequence', 'unknown', 'wait(seconds=-1)', 'action(name="missing")'])
    assert.throws(() => parseTreeText(text, { handlers: { actions: {} } }), /fix root/, text);
  assert.throws(() => parseTreeText('subtree(name="missing")', { subtrees: {} }), /unknown subtree/);
  assert.throws(() => parseTreeText(' '.repeat(MAX_TREE_TEXT_LENGTH + 1)), /at most/);
  assert.throws(() => parseTreeText('inverter {'.repeat(258) + 'wait(seconds=0)' + '}'.repeat(258)), /levels/);
  assert.throws(() => parseTreeText('wait(__proto__=0)'), /node body/);
});
test('deterministically generated JSON documents preserve exact fields across 200 round trips', () => {
  for (let i = 0; i < 200; i++) {
    const root = {
      type: i % 2 ? 'sequence' : 'selector',
      children: [
        { type: 'action', name: `name ${i} \\ "`, label: String.fromCodePoint(0x400 + i) },
        { type: 'timeout', seconds: i / 7, child: { type: 'wait', seconds: i / 17 } },
      ],
    };
    assert.deepEqual(parseTreeText(printTreeText(root)).root, root);
  }
});
