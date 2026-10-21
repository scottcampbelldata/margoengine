// Block types the tests and the bench share: the names noiseTerrain builds with.
import { BlockTypes } from '@margoengine/voxel';

/** Stone, dirt, grass, sand, water, log, leaves and a tall-grass plant, in that id order (1-8). */
export function testBlocks() {
  const blocks = new BlockTypes();
  for (const name of ['stone', 'dirt', 'grass', 'sand']) blocks.define(name);
  blocks.define('water', { liquid: true, solid: false, layer: 'translucent', shape: 'liquid' });
  blocks.define('log');
  blocks.define('leaves', { layer: 'cutout' });
  blocks.define('tall_grass', { shape: 'cross', solid: false, layer: 'cutout' });
  return blocks;
}
