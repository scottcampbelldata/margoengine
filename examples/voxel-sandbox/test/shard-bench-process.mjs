import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('examples/voxel-sandbox/test/shard-bench-process.mjs')
)
  process.exit(0);
// A bench server for the Plaza: packages/voxel-net/bench/run.mjs forks it with --server, in place of its own, so the bots
// meet the Plaza's blocks and terrain. Modes, in --server-options:
//   plain: a VoxelServer on the sandbox's own terrain (no plaza=1), for comparing bytes;
//   shard: the real PlazaShard from `shard` (a path, so that another checkout's can be measured), behind a stand-in for nginx.
// `stress` starts every address with opals to place, so with the bots' place=opal every edit they make runs the rare block
// rules and sends a message: far more than people will ever do, as an upper bound.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VoxelServer } from '@margoengine/voxel-net/server';
import { measureServer } from '../../../packages/voxel-net/bench/server-window.mjs';
import { defineBlocks } from '../src/blocks.ts';
import { COUNTED_BLOCKS } from '../src/plaza-area.ts';
import { plazaFloor } from '../src/plaza.ts';

const {
  scenario,
  workers,
  mode,
  shard: shardPath,
  seed = 5,
  home = [150, 150],
  stress = false,
} = JSON.parse(process.argv[2]);
const { blocks } = defineBlocks(),
  radius = scenario === 'crowd' ? 32 : 1024;

function spawn(id) {
  let h = Math.imul(id, 0x9e3779b1) ^ 0x5bd1e995;
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const r = radius * Math.sqrt(next()),
    a = 2 * Math.PI * next();
  return [home[0] + Math.round(r * Math.cos(a)), home[1] + Math.round(r * Math.sin(a))];
}

if (mode === 'plain') {
  const server = new VoxelServer({
    blocks,
    generator: new URL(`../src/server-generator.ts?seed=${seed}`, import.meta.url),
    workers: workers ?? 1,
    flight: true,
    spawn,
    maxPlayers: 5000,
    maxPerAddress: 1000,
    maxPending: 1000,
    origins: '*',
  });
  measureServer(server, (await server.listen(0, '127.0.0.1')).port);
} else {
  // What nginx does: overwrite the one header, here with one address per connection, in the order they come.
  const address = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  let connections = 0;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, ...rest) {
    if (event === 'upgrade') req.headers['x-real-ip'] = address(++connections);
    return emit.call(this, event, req, ...rest);
  };

  const dataDir = mkdtempSync(join(tmpdir(), 'plaza-bench-')),
    shardUrl = pathToFileURL(shardPath),
    { PlazaShard } = await import(shardUrl.href),
    { identityOfAddress, loadSalt } = await import(new URL('identity.mjs', shardUrl).href);
  if (stress) {
    const salt = loadSalt(dataDir),
      inventory = {},
      startedAt = Date.now(),
      id = `s0-${startedAt.toString(36)}`;
    for (let n = 1; n <= 2000; n++)
      inventory[identityOfAddress(address(n), salt)] = COUNTED_BLOCKS.map((name) => (name === 'opal' ? 60000 : 0));
    mkdirSync(join(dataDir, 'shard-0', id), { recursive: true });
    writeFileSync(
      join(dataDir, 'shard-0', 'state.json'),
      JSON.stringify({
        id,
        shard: 0,
        seed,
        floor: plazaFloor(seed, blocks.table),
        startedAt,
        endsAt: startedAt + 6 * 3600_000,
        edits: 0,
        frozen: [],
        counts: { found: 0, total: 1000, inventory, dug: [], placed: [] },
      }),
    );
  }
  const shard = new PlazaShard({
    index: 0,
    dataDir,
    proxied: true,
    origins: '*',
    seed,
    capacity: 5000,
    perIdentity: 5000,
    beatMs: 3_600_000, // a beat resets the metrics the window reads
    idleMs: 0,
    quiet: true,
    spawn,
  });
  await shard.start();
  measureServer(shard.server, shard.address.port, {
    close: async () => {
      await shard.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
}
