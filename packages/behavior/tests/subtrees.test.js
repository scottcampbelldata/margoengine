import test from 'node:test';
import assert from 'node:assert/strict';
import { SubtreeTree, subtree, resolveTree, validateTree } from '../dist/subtrees.js';
import { BehaviorTree, action, wait } from '../dist/index.js';

test('references resolve nested registrations and run like an inline tree, with shared blackboard', () => {
  const registry = { outer: { type: 'sequence', children: [subtree('inner'), action('done')] }, inner: wait(0.25) };
  const root = { type: 'sequence', children: [subtree('outer'), subtree('outer')] };
  const options = {
    handlers: {
      actions: {
        done: (tick) => {
          tick.blackboard.set('count', (tick.blackboard.get('count') ?? 0) + 1);
        },
      },
    },
    trace: true,
  };
  const tree = new SubtreeTree(root, { ...options, subtrees: registry });
  const inline = new BehaviorTree(resolveTree(root, registry), options);
  for (let i = 0; i < 10; i++) {
    assert.equal(tree.tick(0.125), inline.tick(0.125));
    assert.deepEqual(tree.trace, inline.trace);
  }
  assert.ok(tree.blackboard.get('count') >= 2);
  assert.equal(root.children[0].type, 'subtree');
});
test('each reference and agent has independent running state and abort signals', () => {
  const signals = [];
  const options = {
    subtrees: { task: action('work') },
    handlers: {
      actions: {
        work: (tick) => {
          signals.push(tick.signal);
          return new Promise(() => {});
        },
      },
    },
  };
  const root = { type: 'parallel', children: [subtree('task'), subtree('task')] };
  const a = new SubtreeTree(root, options),
    b = new SubtreeTree(root, options);
  a.tick();
  b.tick();
  assert.equal(new Set(signals).size, 4);
  a.dispose();
  assert.deepEqual(
    signals.map((s) => s.aborted),
    [true, true, false, false],
  );
  b[Symbol.dispose]();
  assert.ok(signals.every((s) => s.aborted));
});
test('validator rejects self/indirect cycles, missing names, malformed references and deep expansion', () => {
  assert.match(validateTree(subtree('a'), { a: subtree('a') })[0].message, /cycle|cyclic/);
  assert.match(validateTree(subtree('a'), { a: subtree('b'), b: subtree('a') })[0].message, /cycle|cyclic/);
  assert.match(validateTree(subtree('toString'))[0].message, /unknown subtree/);
  assert.ok(validateTree({ ...subtree('a'), label: 1, extra: true }, { a: wait(0) }).length >= 2);
  assert.throws(() => resolveTree('{'), /JSON/);
  assert.throws(() => resolveTree(subtree('missing')), /register/);
  const registry = {};
  for (let i = 0; i < 260; i++) registry[i] = i === 259 ? wait(0) : subtree(String(i + 1));
  assert.match(validateTree(subtree('0'), registry)[0].message, /levels/);
  assert.ok(validateTree(subtree('a'), { a: action('absent') }, { actions: {} }).length);
  assert.ok(validateTree(subtree('a'), { a: { format: 'bad', version: 2, root: wait(0) } }).length);
});
test('diamond reuse is not a cycle and labels survive', () => {
  const root = { type: 'selector', children: [subtree('a'), { ...subtree('a'), label: 'second' }] };
  assert.deepEqual(validateTree(root, { a: wait(0) }), []);
  const doc = resolveTree(JSON.stringify(root), { a: wait(0) });
  assert.equal(doc.root.children[1].label, 'second');
});
