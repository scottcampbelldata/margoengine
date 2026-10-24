import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, blockData, blockId, blockState } from '../dist/index.js';

test('block states pack a 16-bit id and 16 bits of data into a u32', () => {
  assert.equal(blockState(0), 0);
  assert.equal(blockState(7), 7);
  assert.equal(blockState(7, 3), 7 + 3 * 65536);
  assert.equal(blockState(0xffff, 0xffff), 0xffffffff);
  for (const [id, data] of [
    [0, 0],
    [1, 0x8000],
    [0xffff, 1],
    [1234, 0xffff],
  ]) {
    const s = blockState(id, data);
    assert.ok(s >= 0 && s <= 0xffffffff);
    assert.deepEqual([blockId(s), blockData(s)], [id, data]);
  }
  for (const [id, data] of [
    [65536, 0],
    [-1, 0],
    [1.5, 0],
    [0, 65536],
    [0, -1],
    [Number.NaN, 0],
  ])
    assert.throws(() => blockState(id, data), RangeError);
  assert.throws(() => blockState('1'), TypeError);
});

test('BlockTypes assigns ids in order after air and resolves every option', () => {
  const blocks = new BlockTypes();
  assert.equal(blocks.id('air'), 0);
  assert.deepEqual([blocks.get(0).layer, blocks.get(0).solid, blocks.get(0).opacity], ['invisible', false, 0]);
  const stone = blocks.define('stone'),
    grass = blocks.define('grass', { textures: [2, 2, 0, 1, 2, 2], color: '#ff0000', roughness: 0.5 }),
    leaves = blocks.define('leaves', { layer: 'cutout', light: 3, animation: { frames: 4, fps: 8 }, textures: 252 });
  assert.deepEqual([stone, grass, leaves], [1, 2, 3]);
  assert.equal(blocks.id('grass'), grass);
  assert.deepEqual(blocks.get(stone), {
    id: 1,
    name: 'stone',
    textures: [0, 0, 0, 0, 0, 0],
    layer: 'opaque',
    shape: 'cube',
    solid: true,
    liquid: false,
    light: 0,
    opacity: 15,
    color: [1, 1, 1],
    roughness: 1,
    metalness: 0,
    emissive: 0,
    animation: { frames: 1, fps: 0 },
    maps: { normal: 0, roughness: 0, emissive: 0 },
    transmission: 0,
    scatter: 0,
    waterlog: 0,
  });
  assert.deepEqual(blocks.get(grass).textures, [2, 2, 0, 1, 2, 2]);
  assert.deepEqual(blocks.get(grass).color, [1, 0, 0]);
  assert.equal(blocks.get(grass).roughness, 0.5);
  assert.deepEqual([blocks.get(leaves).opacity, blocks.get(leaves).light], [0, 3]);
  assert.deepEqual(blocks.get(leaves).animation, { frames: 4, fps: 8 });
  // The table is plain data a worker receives intact.
  assert.deepEqual(structuredClone(blocks.table), blocks.table);
  assert.equal(blocks.table[grass].name, 'grass');
});

test('BlockTypes validates names and options', () => {
  const blocks = new BlockTypes();
  blocks.define('stone');
  assert.throws(() => blocks.define('stone'), { name: 'MargoError', code: 'state' });
  assert.throws(() => blocks.define(''), RangeError);
  assert.throws(() => blocks.define(3), TypeError);
  assert.throws(() => blocks.define('a', null), TypeError);
  assert.throws(() => blocks.define('a', { layer: 'glass' }), TypeError);
  assert.throws(() => blocks.define('a', { shape: 'wedge' }), TypeError);
  assert.throws(() => blocks.define('a', { solid: 1 }), TypeError);
  assert.throws(() => blocks.define('a', { light: 16 }), RangeError);
  assert.throws(() => blocks.define('a', { opacity: -1 }), RangeError);
  assert.throws(() => blocks.define('a', { light: '3' }), TypeError);
  assert.throws(() => blocks.define('a', { roughness: 2 }), RangeError);
  assert.throws(() => blocks.define('a', { metalness: Number.NaN }), RangeError);
  assert.throws(() => blocks.define('a', { emissive: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => blocks.define('a', { textures: [1, 2, 3, 4, 5] }), TypeError);
  assert.throws(() => blocks.define('a', { textures: 2048 }), RangeError);
  assert.throws(() => blocks.define('a', { textures: 2045, animation: { frames: 4, fps: 1 } }), RangeError);
  assert.throws(() => blocks.define('a', { animation: { frames: 0, fps: 1 } }), RangeError);
  assert.throws(() => blocks.define('a', { animation: { frames: 2, fps: -1 } }), RangeError);
  assert.throws(() => blocks.define('a', { color: 'red' }), TypeError);
  assert.throws(() => blocks.id('missing'), RangeError);
  assert.throws(() => blocks.get(99), RangeError);
  assert.throws(() => blocks.get(0.5), RangeError);
  // Nothing was defined by the failed calls.
  assert.equal(blocks.table.length, 2);
  assert.equal(blocks.define('a'), 2);
  assert.throws(() => blocks.define('b', { maps: { normal: 2048 } }), RangeError);
  assert.throws(() => blocks.define('b', { transmission: 2 }), RangeError);
  const glass = blocks.define('glass', { maps: { normal: 1 }, transmission: 0.5, scatter: 0.25 });
  assert.deepEqual(blocks.get(glass).maps, { normal: 1, roughness: 0, emissive: 0 });
  assert.equal(blocks.get(glass).transmission, 0.5);
  assert.equal(blocks.get(glass).scatter, 0.25);
});

test('BlockTypes holds 65,536 ids, the 16 bits of a block state', () => {
  const blocks = new BlockTypes();
  for (let i = 1; i <= 0xffff; i++) blocks.define(`b${i}`);
  assert.equal(blocks.id('b65535'), 0xffff);
  assert.throws(() => blocks.define('one more'), RangeError);
});
