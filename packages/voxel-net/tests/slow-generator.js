// A generator module for tests: flat stone up to y = 7, taking 15 ms a chunk, so the order of the work shows.
export default function slow(chunk, cx, cy, cz, { blocks }) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  const stone = blocks.findIndex((type) => type.name === 'stone');
  if (cy !== 0) return 7;
  for (let z = 0; z < 32; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) chunk.set(x, y, z, stone);
  return 7;
}
