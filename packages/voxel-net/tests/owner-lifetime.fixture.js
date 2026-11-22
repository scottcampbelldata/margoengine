// Owner/lifetime fixture for @margoengine/voxel-net. The package holds no GPU resource; what it holds on an owner is
// network and process lifetimes: a server's tick timer, listening socket and generator worker threads, a client's silence
// timer and socket listeners, the tick and message subscriptions every server add-on takes (entities, chat, inventories,
// rewind, shards, the recorder), a lobby's rooms, and the files and sockets of a bot. Each object is created in the
// owner's scope and tied to a plugin registration that releases it the way a scene or engine disposal does
// (ownedByEngine); release is safe to repeat and is awaited.
//
// The server, bot, rooms and the stores use `node:http`, worker threads and files, so their entries run in Node only
// (the CPU leaf); the browser leaf runs the entries that work in a page: the client over a transport of the caller's
// and the client-side add-ons, which need no server. Not entries: the wire format (protocol), `serveVoxelBun` and
// `serveVoxelDeno` (they need those runtimes, `server-runtimes-check.mjs` and test/server-runtimes.test.js run them),
// and `acceptVoxelNetWebTransport`, `voxelNetTransport`, `connectVoxelNetWebTransport` and the WebRTC pair, which wrap
// a connection the caller owns and close it through its own API (test/webtransport*.test.js, test/webrtc.test.js).
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const node = typeof process === 'object' && !!process.versions?.node;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export async function fixtures(load = (entry) => import(entry)) {
  const { VoxelWorld, BlockTypes } = await load('../../voxel/dist/index.js');
  const { VoxelNetClient } = await load('../dist/index.js');
  const { VoxelChatClient } = await load('../dist/chat.js');
  const { VoxelEntityView } = await load('../dist/entities.js');
  const blocks = new BlockTypes();
  // The names noiseTerrain builds with (tests/blocks.js).
  for (const name of ['stone', 'dirt', 'grass', 'sand']) blocks.define(name);
  blocks.define('water', { liquid: true, solid: false, layer: 'translucent', shape: 'liquid' });
  blocks.define('log');
  blocks.define('leaves', { layer: 'cutout' });
  blocks.define('tall_grass', { shape: 'cross', solid: false, layer: 'cutout' });
  // A transport of the caller's: the client only calls send and close on it.
  const transport = () => {
    const sent = [];
    return { sent, send: (data) => sent.push(data), close: () => {} };
  };
  const clientOf = (options = {}) =>
    new VoxelNetClient(new VoxelWorld({ blocks }), transport(), { view: 2, name: 'owner', ...options });

  const entries = [
    {
      name: 'VoxelNetClient',
      create({ scene }) {
        const client = clientOf();
        client.update(0.05, { keys: 0, yaw: 0, pitch: 0 });
        return ownedByEngine(scene, 'VoxelNetClient', () => client.close());
      },
    },
    {
      name: 'VoxelChatClient',
      create({ scene }) {
        const client = clientOf();
        const previous = client.onApp;
        const chat = new VoxelChatClient(client);
        chat.say('hello');
        return ownedByEngine(
          scene,
          'VoxelChatClient',
          () => {
            chat[Symbol.dispose]();
            client.close();
          },
          {
            check({ phase }) {
              if (phase === 'disposed' && client.onApp !== previous)
                throw new Error('OWNER_LIFETIME: a disposed VoxelChatClient leaves its onApp handler on the client');
            },
          },
        );
      },
    },
    {
      name: 'VoxelEntityView',
      create({ scene }) {
        const client = clientOf();
        const view = new VoxelEntityView(client);
        view.sample(0);
        return ownedByEngine(scene, 'VoxelEntityView', () => {
          view[Symbol.dispose]();
          client.close();
        });
      },
    },
  ];
  if (!node) return entries;

  const { VoxelServer, connectWebSocket, acceptWebSocket } = await load('../dist/server.js');
  const { VoxelBot } = await load('../dist/bot.js');
  const { VoxelEntities } = await load('../dist/entities.js');
  const { VoxelChat, VoxelInventories } = await load('../dist/chat.js');
  const { VoxelRewind } = await load('../dist/rewind.js');
  const { ShardMap, VoxelShard, VoxelShardClient } = await load('../dist/shards.js');
  const { VoxelRecorder } = await load('../dist/replay.js');
  const { VoxelLobby } = await load('../dist/rooms.js');
  const { FileChunkStore } = await load('../dist/file-store.js');
  const { SqlChunkStore } = await load('../dist/sql-store.js');
  const { connectVoxelNet } = await load('../dist/index.js');
  const { createServer } = await import('node:http');
  const { mkdtemp, rm: remove } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const flat = { amplitude: 0, caves: 0, trees: 0, height: 8, seaLevel: -10 };
  const server = (options = {}) =>
    new VoxelServer({ blocks, workers: 1, generator: flat, spawn: () => [8, 8], ...options });
  const until = async (done, ms = 10000) => {
    for (const end = performance.now() + ms; !done(); await wait(20))
      if (performance.now() > end) throw new Error('OWNER_FIXTURE: the server did not answer in time');
  };
  // A bare WebSocket endpoint with no world behind it, for the clients and the bot: a joined player makes a real server
  // start generator worker threads, and a Worker's own message port carries listeners of the runtime's, not the
  // package's. The VoxelServer entries run the real server with no player; the client entries run against this.
  const endpoint = async () => {
    const connections = new Set();
    const http = createServer();
    http.on('upgrade', (req, socket, head) => {
      const conn = acceptWebSocket(req, socket, head);
      if (conn) connections.add(conn);
    });
    await new Promise((done) => http.listen(0, '127.0.0.1', done));
    return {
      url: `ws://127.0.0.1:${http.address().port}`,
      connections,
      close() {
        for (const conn of connections) conn.close();
        return new Promise((done) => http.close(() => done()));
      },
    };
  };
  // Closes a client and waits for its socket to end (the client's onClose), as a page that tears a connection down does.
  const closed = (client, close = () => client.close()) =>
    (client.closes ??= new Promise((done) => {
      const target = client.client ?? client;
      if (target.closed) return done();
      const previous = target.onClose;
      target.onClose = (event) => {
        target.closed = true;
        previous?.(event);
        done();
      };
      close();
    }));
  // One server, with an add-on made on it, released add-on first, then the server.
  const addon = (name, make) => ({
    name,
    async create({ scene }) {
      const host = server();
      const thing = make(host);
      return ownedByEngine(scene, name, async () => {
        thing[Symbol.dispose]?.();
        thing.dispose?.();
        await host.close();
      });
    },
  });
  entries.push(
    {
      name: 'VoxelServer',
      async create({ scene }) {
        const host = server();
        const { port } = await host.listen(0);
        const conn = await connectWebSocket(`ws://127.0.0.1:${port}`);
        conn.onmessage = () => {};
        return ownedByEngine(scene, 'VoxelServer', async () => {
          conn.close();
          await host.close();
        });
      },
    },
    {
      name: 'VoxelServer.stores',
      async create({ scene }) {
        const directory = await mkdtemp(join(tmpdir(), 'owner-voxel-net-'));
        const db = new DatabaseSync(join(directory, 'world.db'));
        const files = new FileChunkStore(join(directory, 'chunks'));
        const sql = new SqlChunkStore(db);
        const first = server({ store: files });
        const second = server({ store: sql });
        await first.listen(0);
        await second.listen(0);
        return ownedByEngine(scene, 'VoxelServer.stores', async () => {
          await first.close();
          await second.close();
          await files.flush();
          await sql.flush();
          if (db.isOpen) db.close();
          await remove(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        });
      },
    },
    {
      name: 'connectVoxelNet',
      async create({ scene }) {
        const host = await endpoint();
        const client = connectVoxelNet(host.url, new VoxelWorld({ blocks }), { view: 2, name: 'owner' });
        await until(() => host.connections.size > 0);
        return ownedByEngine(scene, 'connectVoxelNet', async () => {
          await closed(client);
          await host.close();
        });
      },
    },
    {
      name: 'VoxelBot',
      async create({ scene }) {
        const host = await endpoint();
        const bot = await VoxelBot.connect({ url: host.url, blocks, view: 2 });
        await until(() => host.connections.size > 0);
        return ownedByEngine(scene, 'VoxelBot', async () => {
          bot.close();
          await host.close();
        });
      },
    },
    {
      name: 'VoxelShardClient',
      async create({ scene }) {
        const host = await endpoint();
        const client = new VoxelShardClient(host.url, new VoxelWorld({ blocks }), { view: 2 });
        await until(() => host.connections.size > 0);
        return ownedByEngine(scene, 'VoxelShardClient', async () => {
          await closed(client, () => client[Symbol.dispose]());
          await host.close();
        });
      },
    },
    addon('VoxelEntities', (host) => {
      const entities = new VoxelEntities(host);
      entities.spawn({ kind: 1, position: [8, 12, 8] });
      return entities;
    }),
    addon('VoxelChat', (host) => new VoxelChat(host, { distance: 64 })),
    addon('VoxelInventories', (host) => new VoxelInventories(host)),
    addon('VoxelRewind', (host) => new VoxelRewind(host)),
    addon('VoxelShard', (host) => {
      const map = new ShardMap({ shards: ['ws://127.0.0.1:1', 'ws://127.0.0.1:2'] });
      return new VoxelShard({ map, index: 0, secret: 'owner-lifetime-shard-secret' }).attach(host);
    }),
    {
      name: 'VoxelRecorder',
      async create({ scene }) {
        const host = server();
        const written = [];
        let closed = 0;
        const recorder = new VoxelRecorder(host, {
          write: async (data) => void written.push(data),
          close: async () => void closed++,
        });
        await recorder.flush();
        return ownedByEngine(scene, 'VoxelRecorder', async () => {
          await recorder.close();
          await host.close();
        });
      },
    },
    {
      name: 'VoxelLobby',
      async create({ scene }) {
        const lobby = new VoxelLobby({ secret: 'owner-lifetime-lobby-secret' });
        await lobby.create({ code: 'owner', server: { blocks, workers: 1, generator: flat } });
        return ownedByEngine(scene, 'VoxelLobby', () => lobby.close());
      },
    },
  );
  return entries;
}
