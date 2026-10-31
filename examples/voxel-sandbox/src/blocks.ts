// The sandbox's block types. Ids follow this order and saved chunks store ids, so only append to the list.
import { type BlockTypeOptions, BlockTypes } from '@margoengine/voxel';
import { textureLayer, WATER_FRAMES } from './textures.ts';

const t = textureLayer;

/** Block type names, options and hotbar labels, in id order (id 0 is air). */
export const BLOCK_DEFINITIONS: readonly (readonly [name: string, options: BlockTypeOptions, label: string])[] = [
  ['stone', { textures: t('stone') }, 'Stone'],
  ['dirt', { textures: t('dirt') }, 'Dirt'],
  [
    'grass',
    { textures: [t('grass_side'), t('grass_side'), t('grass_top'), t('dirt'), t('grass_side'), t('grass_side')] },
    'Grass',
  ],
  ['sand', { textures: t('sand') }, 'Sand'],
  [
    'water',
    {
      textures: t('water'),
      layer: 'translucent',
      shape: 'liquid',
      liquid: true,
      solid: false,
      opacity: 1,
      roughness: 0.08,
      animation: { frames: WATER_FRAMES, fps: 5 },
    },
    'Water',
  ],
  [
    'log',
    { textures: [t('log_side'), t('log_side'), t('log_top'), t('log_top'), t('log_side'), t('log_side')] },
    'Log',
  ],
  ['leaves', { textures: t('leaves'), layer: 'cutout', opacity: 1 }, 'Leaves'],
  ['planks', { textures: t('planks') }, 'Planks'],
  ['cobblestone', { textures: t('cobblestone') }, 'Cobblestone'],
  ['bricks', { textures: t('bricks') }, 'Bricks'],
  ['glass', { textures: t('glass'), layer: 'translucent', roughness: 0.05 }, 'Glass'],
  ['torch', { textures: t('torch'), layer: 'cutout', shape: 'cross', solid: false, light: 14, emissive: 0.5 }, 'Torch'],
  ['tall_grass', { textures: t('tall_grass'), layer: 'cutout', shape: 'cross', solid: false }, 'Tall grass'],
  ['dandelion', { textures: t('dandelion'), layer: 'cutout', shape: 'cross', solid: false }, 'Dandelion'],
  ['poppy', { textures: t('poppy'), layer: 'cutout', shape: 'cross', solid: false }, 'Poppy'],
  ['glowstone', { textures: t('glowstone'), light: 15, emissive: 0.5 }, 'Glowstone'],
  ['stone_slab', { textures: t('stone'), shape: 'slab', waterlog: 'water' }, 'Stone slab'],
  ['planks_slab', { textures: t('planks'), shape: 'slab', waterlog: 'water' }, 'Plank slab'],
  ['cobblestone_stairs', { textures: t('cobblestone'), shape: 'stair', waterlog: 'water' }, 'Cobblestone stairs'],
  ['brick_stairs', { textures: t('bricks'), shape: 'stair', waterlog: 'water' }, 'Brick stairs'],
  ['heart_red', { textures: t('heart_red'), light: 8, emissive: 0.5 }, 'Heart red'],
  // Free building blocks.
  ['sandstone', { textures: t('sandstone') }, 'Sandstone'],
  ['marble', { textures: t('marble'), roughness: 0.35 }, 'Marble'],
  ['slate', { textures: t('slate') }, 'Slate'],
  ['plaster', { textures: t('plaster') }, 'White plaster'],
  ['walnut_planks', { textures: t('walnut_planks') }, 'Walnut planks'],
  ['roof_tiles', { textures: t('roof_tiles') }, 'Roof tiles'],
  ['gravel', { textures: t('gravel') }, 'Gravel'],
  ['moss', { textures: t('moss') }, 'Moss'],
  // Found underground and counted per player in Plaza worlds (plaza-area.ts COUNTED_BLOCKS).
  ['tin_ore', { textures: t('tin_ore'), emissive: 0.18 }, 'Tin ore'],
  ['silver_ore', { textures: t('silver_ore'), roughness: 0.4, emissive: 0.22 }, 'Silver ore'],
  ['malachite_ore', { textures: t('malachite_ore'), emissive: 0.22 }, 'Malachite ore'],
  ['amber', { textures: t('amber'), layer: 'translucent', roughness: 0.15, emissive: 0.25 }, 'Amber'],
  ['opal', { textures: t('opal'), light: 7, emissive: 0.45, roughness: 0.2 }, 'Opal'],
  [
    'glow_cap',
    { textures: t('glow_cap'), layer: 'cutout', shape: 'cross', solid: false, light: 10, emissive: 0.6 },
    'Glow cap',
  ],
];

/** Blocks in the hotbar at the start, by name (keys 1-9). */
export const HOTBAR: readonly string[] = [
  'stone',
  'dirt',
  'planks',
  'cobblestone',
  'bricks',
  'log',
  'glass',
  'torch',
  'glowstone',
];

/** The block types, defined in {@link BLOCK_DEFINITIONS} order, and each type's label by id. */
export function defineBlocks(): { blocks: BlockTypes; labels: string[] } {
  const blocks = new BlockTypes(),
    labels = ['Air'];
  for (const [name, options, label] of BLOCK_DEFINITIONS) {
    blocks.define(name, options);
    labels.push(label);
  }
  return { blocks, labels };
}
