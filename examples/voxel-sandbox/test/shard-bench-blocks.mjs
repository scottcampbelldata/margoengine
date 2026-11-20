// The Plaza's block types for the bench's bots: packages/voxel-net/bench/run.mjs --bot-options names this file.
import { deferSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
import { defineBlocks } from '../src/blocks.ts';

// Run directly, this data module only announces the deferral; the bench imports it.
deferSpeedEntry(import.meta.url, 'examples/voxel-sandbox/test/shard-bench-blocks.mjs');

export default () => defineBlocks().blocks;
