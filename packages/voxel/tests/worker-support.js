// Test helpers for the worker mesher: a Web Worker on Node's worker_threads and a seeded random terrain.
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BlockTypes, VoxelChunk, VoxelWorld, blockState } from '../dist/index.js';

// Runs a classic worker script (a built dist/workers/*.js) with self, postMessage and onmessage, as a browser does.
const boot = `
const { parentPort, workerData } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
parentPort.on('message', (data) => self.onmessage?.({ data }));
require('node:vm').runInThisContext(require('node:fs').readFileSync(workerData, 'utf8'), { filename: workerData });
`;

/** Install as globalThis.Worker: `new Worker(url)` starts the script at url (its query dropped) on a Node thread. */
export class NodeWebWorker {
  constructor(url) {
    const file = new URL(url);
    file.search = '';
    this.thread = new Worker(boot, { eval: true, workerData: fileURLToPath(file) });
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(data, transfer) {
    this.thread.postMessage(data, transfer);
  }
  terminate() {
    this.thread.terminate();
  }
}

const hash = (x, y, z, seed) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const blocks = new BlockTypes();
export const STONE = blocks.define('stone', { textures: 0 }),
  DIRT = blocks.define('dirt', { textures: 1 }),
  GRASS = blocks.define('grass', { textures: [2, 2, 3, 1, 2, 2] }),
  WATER = blocks.define('water', { layer: 'translucent', shape: 'liquid', liquid: true, solid: false, textures: 4 }),
  GLASS = blocks.define('glass', { layer: 'translucent', textures: 5 }),
  FLOWER = blocks.define('flower', { layer: 'cutout', shape: 'cross', solid: false, textures: 6 });

/**
 * Seeded random hills over `size` x `size` chunk columns at cy = 0: stone with caves, dirt, grass, water up to y 14,
 * flowers and scattered glass, sky light in the open air. Returns the world and its chunk keys.
 */
export function terrainWorld(size, seed = 1) {
  const world = new VoxelWorld({ blocks }),
    keys = [];
  for (let cz = 0; cz < size; cz++)
    for (let cx = 0; cx < size; cx++) {
      const chunk = new VoxelChunk();
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) {
          const wx = cx * 32 + x,
            wz = cz * 32 + z,
            h = Math.floor(
              14 + 7 * Math.sin(wx * 0.11 + seed) * Math.cos(wz * 0.09) + 4 * hash(wx >> 3, 0, wz >> 3, seed),
            );
          for (let y = 0; y < 32; y++) {
            let s = 0;
            if (y < h - 3) s = hash(wx, y, wz, seed) < 0.05 ? 0 : STONE;
            else if (y < h) s = DIRT;
            else if (y === h) s = h < 14 ? DIRT : GRASS;
            else if (y <= 14) s = blockState(WATER, 0);
            else if (y === h + 1 && hash(wx, 1, wz, seed) < 0.06) s = FLOWER;
            else if (y > h + 1 && hash(wx, y, wz, seed + 1) < 0.004) s = GLASS;
            if (s) chunk.set(x, y, z, s);
            else if (y > h) chunk.setLight(x, y, z, 0xf0);
          }
        }
      world.addChunk(cx, 0, cz, chunk);
      keys.push(`${cx},0,${cz}`);
    }
  return { world, keys };
}
