// Importer naming conventions: collision suffixes and the -loop clip token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipImportName, collisionBase, collisionTag, withCollisionTag } from '../dist/import-names.js';

test('collisionTag reads the last suffix, case-insensitively', () => {
  assert.equal(collisionTag('Wall-col'), 'col');
  assert.equal(collisionTag('Wall-CONVCOL'), 'convcol');
  assert.equal(collisionTag('Wall-colonly'), 'colonly');
  assert.equal(collisionTag('Wall-convcolonly'), 'convcolonly');
  assert.equal(collisionTag('Wall'), null);
  assert.equal(collisionTag('Wall_col'), null);
  assert.throws(() => collisionTag(1), TypeError);
});

test('withCollisionTag replaces every accumulated suffix', () => {
  assert.equal(collisionBase('Wall-col-convcol'), 'Wall');
  assert.equal(withCollisionTag('Wall-col-convcol', 'colonly'), 'Wall-colonly');
  assert.equal(withCollisionTag('Wall-colonly', null), 'Wall');
  assert.equal(withCollisionTag('Wall', 'col'), 'Wall-col');
  assert.throws(() => withCollisionTag('Wall', 'mesh'), { name: 'TypeError', message: /Collision tag/ });
});

test('clipImportName neutralizes loop tokens, then adds one when looping', () => {
  assert.equal(clipImportName('Walk', true), 'Walk-loop');
  assert.equal(clipImportName('loop_Walk-cycle', false), 'Walk');
  assert.equal(clipImportName(' Run loop ', true), 'Run-loop');
  assert.equal(clipImportName('loop', false), 'Animation');
  assert.equal(clipImportName('cycle', true, 'Clip'), 'Clip-loop');
  assert.throws(() => clipImportName('Walk', 'yes'), TypeError);
});
