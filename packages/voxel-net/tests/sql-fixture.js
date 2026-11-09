// One after hook, with dependencies released before their owners, even when setup or an assertion fails.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks();

export async function sqlFixture(t) {
  const disposers = [];
  const own = (dispose) => {
    let closing;
    const close = () => (closing ??= Promise.resolve().then(dispose));
    disposers.push(close);
    return close;
  };
  const close = async () => {
    const errors = [];
    while (disposers.length) {
      try {
        await disposers.pop()();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'SQL fixture cleanup failed');
  };
  t?.after(close);
  const directory = await mkdtemp(pathJoin(tmpdir(), 'margo-sql-store-'));
  own(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    close,
    database() {
      const db = new DatabaseSync(pathJoin(directory, 'world.db'));
      return { db, close: own(() => db.close()) };
    },
    async start(options) {
      const server = new VoxelServer({
        blocks, workers: 2,
        generator: { amplitude: 0, caves: 0, trees: 0, height: 8, seaLevel: -10 },
        spawn: () => [8, 8], ...options,
      });
      const closeServer = own(() => server.close());
      const { port } = await server.listen(0);
      return { server, close: closeServer, url: `ws://127.0.0.1:${port}` };
    },
    async join(url) {
      const conn = await connectWebSocket(url);
      own(() => conn.close());
      const world = new VoxelWorld({ blocks });
      const client = new VoxelNetClient(world, { send: (d) => conn.send(d), close: () => conn.close() }, { view: 2 });
      own(() => client.close());
      conn.onmessage = (d) => client.receive(d);
      return { client, conn, world };
    },
  };
}
