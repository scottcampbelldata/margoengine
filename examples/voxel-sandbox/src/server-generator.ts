// The multiplayer server's generator module (server.mjs gives VoxelServer its URL with ?seed=): the same world as the
// browser's generator worker, run in the server's worker threads.
import { sandboxGenerator } from './plants.ts';
import { DEFAULT_SEED } from './terrain.ts';

export default sandboxGenerator(Number(new URL(import.meta.url).searchParams.get('seed') ?? DEFAULT_SEED) | 0);
