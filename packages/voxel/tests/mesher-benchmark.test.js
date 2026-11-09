import { speedTest } from '../../../scripts/support/speed-test.mjs';
// meshChunk timings, printed and not asserted (they vary by machine). Single thread, about a second.
import { BlockTypes, VoxelWorld, blockState, chunkKey } from '../dist/index.js';
import { QUAD_WORDS, meshChunk, meshInput } from '../dist/mesher.js';

const hash = (x, y, z) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const blocks = new BlockTypes(),
  stone = blocks.define('stone', { textures: 0 }),
  dirt = blocks.define('dirt', { textures: 1 }),
  grass = blocks.define('grass', { textures: [2, 2, 3, 1, 2, 2] }),
  water = blocks.define('water', { layer: 'translucent', shape: 'liquid', liquid: true, textures: 4 }),
  flower = blocks.define('flower', { layer: 'cutout', shape: 'cross', textures: 5 }),
  leaves = blocks.define('leaves', { layer: 'cutout', textures: 6 });

// Rolling hills around sea level 14 with caves, flowers, leaf clumps and sky light above the ground.
function terrain(world, ox, oz) {
  const edits = [];
  for (let z = -1; z <= 32; z++)
    for (let x = -1; x <= 32; x++) {
      const [wx, wz] = [ox + x, oz + z],
        h = Math.floor(
          12 +
            6 * Math.sin(wx * 0.21 + 1.3) * Math.cos(wz * 0.17) +
            3 * Math.sin((wx + wz) * 0.37) +
            2 * hash(wx, 0, wz),
        );
      for (let y = -1; y <= 32; y++) {
        let s = 0;
        if (y < h - 3) s = hash(wx, y, wz) < 0.04 ? 0 : stone;
        else if (y < h) s = dirt;
        else if (y === h) s = h < 14 ? dirt : grass;
        else if (y <= 14) s = blockState(water, 0);
        else if (y === h + 1 && hash(wx, 1, wz) < 0.08) s = flower;
        else if (y > h + 3 && y < h + 7 && hash(wx >> 2, y >> 2, wz >> 2) < 0.06) s = leaves;
        if (s) edits.push(wx, y, wz, s);
      }
    }
  world.setBlocks(edits);
  for (let cz = -1; cz <= 1; cz++)
    for (let cx = -1; cx <= 1; cx++)
      for (let cy = -1; cy <= 1; cy++) {
        const chunk = world.getChunk((ox >> 5) + cx, cy, (oz >> 5) + cz);
        if (!chunk) continue;
        for (let y = 0; y < 32; y++)
          for (let z = 0; z < 32; z++)
            for (let x = 0; x < 32; x++) if (!chunk.get(x, y, z) || y + cy * 32 > 20) chunk.setLight(x, y, z, 0xf0);
      }
}

speedTest('benchmark: meshChunk per random-terrain chunk and per worst-case checkerboard (printed)', (t) => {
  const inputs = [],
    world = new VoxelWorld({ blocks });
  for (let i = 0; i < 8; i++) {
    terrain(world, i * 96, i * 64);
    inputs.push(meshInput(world, chunkKey(i * 3, 0, i * 2)));
  }
  let start = performance.now();
  for (let i = 0; i < 8; i++) meshInput(world, chunkKey(i * 3, 0, i * 2));
  const build = (performance.now() - start) / 8;
  for (const input of inputs) meshChunk(input); // warm up
  let quads = 0;
  const runs = 5;
  start = performance.now();
  for (let r = 0; r < runs; r++)
    for (const input of inputs) {
      const m = meshChunk(input);
      quads += (m.opaque.length + m.cutout.length + m.translucent.length) / QUAD_WORDS;
    }
  const terrainMs = (performance.now() - start) / (runs * inputs.length);
  const board = new VoxelWorld({ blocks });
  const edits = [];
  for (let y = 0; y < 32; y++)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) if (!((x + y + z) & 1)) edits.push(x, y, z, stone);
  board.setBlocks(edits);
  const boardInput = meshInput(board, '0,0,0');
  meshChunk(boardInput);
  start = performance.now();
  for (let r = 0; r < 5; r++) meshChunk(boardInput);
  const boardMs = (performance.now() - start) / 5,
    boardQuads = meshChunk(boardInput).opaque.length / QUAD_WORDS;
  t.diagnostic(
    `terrain: ${terrainMs.toFixed(2)} ms per chunk (${(quads / (runs * inputs.length)) | 0} quads); ` +
      `meshInput from the world ${build.toFixed(2)} ms`,
  );
  t.diagnostic(`checkerboard (worst case, ${boardQuads} quads): ${boardMs.toFixed(2)} ms per chunk`);
});
