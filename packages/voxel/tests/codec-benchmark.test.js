// Codec throughput and sizes, printed and not asserted (timings vary by machine). Single thread, about a second.
import test from 'node:test';
import { VoxelChunk } from '../dist/index.js';
import { decodeBlockChanges, decodeChunk, EntityCodec, encodeBlockChanges, encodeChunk } from '../dist/codec.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const time = async (n, run) => {
  const start = performance.now();
  for (let i = 0; i < n; i++) await run();
  return (performance.now() - start) / n;
};
const mbps = (bytes, ms) => `${(bytes / 1e3 / ms).toFixed(0)} MB/s`;

// A surface chunk: stone with ores, three dirt layers, grass, water below y 14, air above; sky light 15 in the open
// air, dimming 1 per block of water depth, 0 underground.
function terrain() {
  const next = random(5),
    chunk = new VoxelChunk();
  for (let x = 0; x < 32; x++)
    for (let z = 0; z < 32; z++) {
      const h = Math.floor(16 + 6 * Math.sin(x / 7) * Math.cos(z / 9) + 2 * Math.sin((x + z) / 3));
      for (let y = 0; y < 32; y++) {
        const state =
          y < h - 3 ? (next() < 0.02 ? 5 : next() < 0.01 ? 6 : 1) : y < h ? 2 : y === h ? 3 : y < 14 ? 4 : 0;
        chunk.set(x, y, z, state);
        if (y > h) chunk.setLight(x, y, z, Math.max(0, 15 - Math.max(0, 14 - y)) << 4);
      }
    }
  return chunk;
}

test('benchmark: chunk, block-change and entity codecs (printed)', async (t) => {
  const chunk = terrain(),
    raw = await encodeChunk(chunk, { compress: false }),
    deflated = await encodeChunk(chunk),
    bare = await encodeChunk(chunk, { compress: false, light: false }),
    bareDeflated = await encodeChunk(chunk, { light: false }),
    n = 100;
  await time(10, () => decodeChunk(deflated)); // warm up
  const encodeRaw = await time(n, () => encodeChunk(chunk, { compress: false })),
    encodeDeflated = await time(n, () => encodeChunk(chunk)),
    decodeRaw = await time(n, () => decodeChunk(raw)),
    decodeDeflated = await time(n, () => decodeChunk(deflated)),
    // Streams are latency-bound in Node (zlib on the thread pool): 32 decodes in flight, as a streamer issues them.
    decodeParallel = (await time(3, () => Promise.all(Array.from({ length: 32 }, () => decodeChunk(deflated))))) / 32;
  t.diagnostic(
    `terrain chunk (${chunk.pack().bits}-bit, ${chunk.pack().palette.length} states, dense light): ` +
      `${raw.length} B raw, ${deflated.length} B deflated; without light ${bare.length} B raw, ` +
      `${bareDeflated.length} B deflated`,
  );
  t.diagnostic(
    `encode ${encodeRaw.toFixed(3)} ms (${mbps(raw.length, encodeRaw)}), deflated ${encodeDeflated.toFixed(3)} ms ` +
      `(${mbps(raw.length, encodeDeflated)}); decode ${decodeRaw.toFixed(3)} ms (${mbps(raw.length, decodeRaw)}), ` +
      `deflated ${decodeDeflated.toFixed(3)} ms (${mbps(raw.length, decodeDeflated)}), 32 in flight ` +
      `${decodeParallel.toFixed(3)} ms each; MB/s of raw chunk bytes`,
  );

  const next = random(7),
    edits = [];
  for (let i = 0; i < 20000; i++)
    edits.push(Math.floor(next() * 64), Math.floor(next() * 64), Math.floor(next() * 64), Math.floor(next() * 30));
  const changes = encodeBlockChanges(edits),
    encodeChanges = await time(20, () => encodeBlockChanges(edits)),
    decodeChanges = await time(20, () => decodeBlockChanges(changes));
  t.diagnostic(
    `20,000 block changes in 8 chunks: ${changes.length} B (${(changes.length / 20000).toFixed(2)} B each), ` +
      `encode ${encodeChanges.toFixed(2)} ms, decode ${decodeChanges.toFixed(2)} ms`,
  );

  const codec = new EntityCodec({ position: 'position', rotation: 'rotation', health: 'u8', anim: 'u16' }),
    a = new Map(),
    b = new Map();
  for (let id = 0; id < 1000; id++) {
    const e = {
      position: [next() * 500, 64 + next() * 10, next() * 500],
      rotation: [0, 0.6, 0, 0.8],
      health: 20,
      anim: 3,
    };
    a.set(id, e);
    b.set(id, next() < 0.3 ? { ...e, position: e.position.map((c) => c + next() * 0.2) } : e);
  }
  const full = codec.encode(a),
    delta = codec.encode(b, a),
    encodeFull = await time(20, () => codec.encode(a)),
    encodeDelta = await time(20, () => codec.encode(b, a)),
    decodeDelta = await time(20, () => codec.decode(delta, a));
  t.diagnostic(
    `1,000 entities: full ${full.length} B in ${encodeFull.toFixed(2)} ms; 30% moved: delta ${delta.length} B, ` +
      `encode ${encodeDelta.toFixed(2)} ms, decode ${decodeDelta.toFixed(2)} ms`,
  );
});
