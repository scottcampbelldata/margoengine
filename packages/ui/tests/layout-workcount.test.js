import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { arrange } from '../dist/index.js';
import { chain, corpus, layoutBytes } from './layout-corpus.js';

const box = { x: 0, y: 0, width: 200, height: 100 };

test('one arrange measures a nested leaf once per distinct width', () => {
  const widths = [];
  const { root, leaf } = chain(8, (width) => widths.push(width));
  arrange(root, box);
  assert.deepEqual(widths, [200, 20]); // Previously 24 calls for the same two constraints.
  assert.deepEqual(leaf.rect, { x: 0, y: 46, width: 20, height: 8 });
});

test('64 mixed trees retain the parent revision layout bytes', () => {
  const hash = createHash('sha256');
  for (let seed = 1; seed <= 64; seed++) {
    const tree = corpus(seed);
    arrange(tree, { x: 3, y: 7, width: 90 + seed, height: 70 + seed });
    hash.update(layoutBytes(tree));
  }
  // Captured from origin/main, prior to this change, using the same corpus.
  assert.equal(hash.digest('hex'), 'b0dffbf009a22ce56f39ccaf646440f7b52f30c0a86a27dcf2c0e96a8871c9e8');
});

test('edits and exceptions cannot leave measurements in the next arrange', () => {
  let size = 20;
  const { root, leaf } = chain(3);
  leaf.measure = () => ({ width: size, height: 8 });
  arrange(root, box);
  size = 30;
  arrange(root, box);
  assert.equal(leaf.rect.width, 30);
  leaf.measure = () => { throw new Error('measure failed'); };
  assert.throws(() => arrange(root, box), /measure failed/);
  leaf.measure = () => ({ width: 40, height: 9 });
  arrange(root, box);
  assert.equal(leaf.rect.width, 40);
  assert.equal(leaf.rect.height, 9);
});

test('a reentrant arrange has its own measurement lifetime', () => {
  const inner = chain(2);
  const { root, leaf } = chain(3);
  leaf.measure = () => {
    arrange(inner.root, { ...box, width: 50 });
    return { width: 35, height: 12 };
  };
  arrange(root, box);
  assert.equal(leaf.rect.width, 35);
  assert.equal(inner.leaf.rect.width, 20);
});
