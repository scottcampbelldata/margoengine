// An app generator module worker for the streamer tests: stone below y 0, a dirt marker cell that encodes the chunk
// coordinates, and a failure for chunk column (5, 5).
import { serveVoxelGenerator } from '../dist/generate.js';

serveVoxelGenerator(async (chunk, cx, cy, cz, { blocks }) => {
  const id = (name) => blocks.find((type) => type.name === name).id;
  if (cx === 5 && cz === 5) throw new RangeError(`no chunk ${cx},${cy},${cz} here`);
  if (cy < 0) chunk.fill(id('stone'));
  chunk.set(cx & 31, cy & 31, cz & 31, id('dirt'));
});
