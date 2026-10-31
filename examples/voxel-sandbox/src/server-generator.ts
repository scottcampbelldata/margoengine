// The multiplayer server's generator module (server.mjs gives VoxelServer its URL with ?seed=): the same world as the
// browser's generator worker, run in the server's worker threads. With &plaza=1 (server/shard.mjs) the tunnels are wider,
// and it also stamps the Plaza's finds and its square at the origin.
import { sandboxGenerator } from './plants.ts';
import { plazaGenerator } from './plaza.ts';
import { DEFAULT_SEED, terrainOptions } from './terrain.ts';

const params = new URL(import.meta.url).searchParams,
  seed = Number(params.get('seed') ?? DEFAULT_SEED) | 0;

export default params.get('plaza') === '1'
  ? plazaGenerator(sandboxGenerator(seed, terrainOptions(seed)), seed)
  : sandboxGenerator(seed);
