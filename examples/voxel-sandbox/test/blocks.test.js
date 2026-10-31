import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK_DEFINITIONS, defineBlocks, HOTBAR } from '../src/blocks.ts';
import { COUNTED_BLOCKS } from '../src/plaza-area.ts';
import { PLANTS, terrainOptions } from '../src/terrain.ts';
import { TEXTURE_NAMES } from '../src/textures.ts';

test('block ids keep their order (saved chunks store ids)', () => {
  const { blocks, labels } = defineBlocks();
  // Append new types at the end; reordering this list breaks every saved world.
  assert.deepEqual(
    blocks.table.map((type) => type.name),
    [
      'air',
      'stone',
      'dirt',
      'grass',
      'sand',
      'water',
      'log',
      'leaves',
      'planks',
      'cobblestone',
      'bricks',
      'glass',
      'torch',
      'tall_grass',
      'dandelion',
      'poppy',
      'glowstone',
      'stone_slab',
      'planks_slab',
      'cobblestone_stairs',
      'brick_stairs',
      'heart_red',
      'sandstone',
      'marble',
      'slate',
      'plaster',
      'walnut_planks',
      'roof_tiles',
      'gravel',
      'moss',
      'tin_ore',
      'silver_ore',
      'malachite_ore',
      'amber',
      'opal',
      'glow_cap',
    ],
  );
  assert.equal(labels.length, blocks.table.length);
  for (const type of blocks.table)
    for (const layer of type.textures) assert.ok(layer < TEXTURE_NAMES.length, `${type.name} texture ${layer}`);
});

test('the found blocks and the lights: opal and glow caps give light, a glow cap is walked through', () => {
  const { blocks } = defineBlocks(),
    get = (name) => blocks.get(blocks.id(name));
  assert.deepEqual(COUNTED_BLOCKS, ['tin_ore', 'silver_ore', 'malachite_ore', 'amber', 'opal']);
  for (const name of COUNTED_BLOCKS) assert.equal(get(name).solid, true, name);
  assert.equal(get('opal').light, 7);
  assert.equal(get('amber').layer, 'translucent');
  const cap = get('glow_cap');
  assert.equal(cap.light, 10);
  assert.equal(cap.solid, false);
  assert.equal(cap.shape, 'cross');
  assert.ok(!HOTBAR.includes('opal'), 'nobody starts with a found block');
});

test('the generator, the plants and the hotbar name defined blocks', () => {
  const { blocks } = defineBlocks();
  for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves', ...PLANTS.map(([n]) => n), ...HOTBAR])
    assert.doesNotThrow(() => blocks.id(name), name);
  assert.equal(HOTBAR.length, 9);
  const torch = blocks.get(blocks.id('torch')),
    water = blocks.get(blocks.id('water'));
  assert.equal(torch.light, 14);
  assert.equal(torch.solid, false);
  assert.equal(water.liquid, true);
  assert.equal(water.layer, 'translucent');
  assert.ok(BLOCK_DEFINITIONS.every(([, , label]) => label.length > 0));
  assert.equal(terrainOptions(7).seed, 7);
});
