// An app generator module worker for the streamer tests that gives its column's ceiling: stone up to cell y 15 in
// every column, nothing above, so every chunk with cy >= 1 is air.
import { serveVoxelGenerator } from '../dist/generate.js';

serveVoxelGenerator((chunk, cx, cy, cz, { blocks }) => {
  const stone = blocks.find((type) => type.name === 'stone').id;
  if (cy < 0) chunk.fill(stone);
  else if (cy === 0)
    for (let y = 0; y <= 15; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) chunk.set(x, y, z, stone);
  return 15;
});
