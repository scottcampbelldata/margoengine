import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('examples/voxel-sandbox/test/shard-bench-blocks.mjs')
)
  process.exit(0);
// The Plaza's block types for the bench's bots: packages/voxel-net/bench/run.mjs --bot-options names this file.
import { defineBlocks } from '../src/blocks.ts';

export default () => defineBlocks().blocks;
