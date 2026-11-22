// Owner/lifetime fixture for @margoengine/netcode. The package never touches the engine or the GPU: its objects are
// not engine plugins. What they hold is connections (their handlers and the peers' links), timers (a room's patch and
// simulation intervals, a held seat, a presence heartbeat, a signalling join deadline, a migration recovery timer) and
// listeners on the app's AbortSignal. Each entry builds the object the way an app does, on the in-memory loopback network
// (so nothing waits on a real socket), tied to a plugin registration that releases it as `engine.dispose()`,
// `scene.dispose()` and `scene.removePlugin()` do for anything an app hangs off an engine. After the release every
// connection must be closed, every timer cleared and every listener on the app's signal gone, a second release must be
// harmless, and the app's own signal must outlive the object. The real-socket entries (`/node`, `/websocket`) run in
// Node only, with a server on port 0 of the loopback interface; `/webrtc` and `/webtransport` wrap fake channels and a
// fake session, since a browser's peer connection needs a second peer. Not entries: `/interpolation*`, `/extrapolate`,
// `/smoothing`, `/hitboxes`, `/interest`, `/generate` and `/generate-rust` are functions and classes over numbers and
// bytes that hold no handle, timer or listener; tests/owner-exclusions.test.js cannot list the package because the
// entries above do hold some.
import { GameServer, LoopbackNetwork, defineSchema } from '../dist/index.js';
import { RollbackSession } from '../dist/rollback.js';
import { RollbackRelay, RollbackSpectator, relayPeers } from '../dist/relay.js';
import { Room, RoomServer, RoomsClient } from '../dist/rooms.js';
import { LobbyRoom, RoomLobby } from '../dist/lobby.js';
import { MemoryPresence, MemoryPresenceStore, RoomNode } from '../dist/presence.js';
import { HostMigration } from '../dist/migrate.js';
import { SignalClient, SignalServer } from '../dist/signal.js';
import { dataChannelConnection } from '../dist/webrtc.js';
import { openWebSocket } from '../dist/websocket.js';
import { ownedByEngine, lifetimeFault, watchTimers } from '../../../tests/support/owner-shell.js';
import { arena } from './arena.js';
import { game as arenaGame } from './arena.js';

const schema = defineSchema({ types: { State: { count: 'uint' } } });
class Match extends Room {
  schema = schema;
  stateType = 'State';
  maxClients = 2;
  onCreate() {
    this.setState({ count: 0 });
  }
}
class Seats extends LobbyRoom {
  schema = schema;
  stateType = 'State';
  maxClients = 2;
  onCreate() {
    this.setState({ count: 0 });
  }
}
// Lets the loopback network deliver, a step at a time, with the microtasks in between.
const settle = async (network, ms = 100) => {
  for (let i = 0; i < 10; i++) {
    network.advance(ms / 10);
    await new Promise((done) => setTimeout(done, 0));
  }
};
const node = !globalThis.document && typeof process !== 'undefined' && !!process.versions?.node;

export async function fixtures(load = (entry) => import(entry)) {
  const entries = [];
  // `make` builds the object (its synchronous part runs with every timer it arms recorded); it returns `release`, which
  // must be safe twice, and may return `check`. After the release no timer made in the scope may stay armed.
  const own = (name, make) =>
    entries.push({
      name,
      async create({ scene }) {
        const timers = watchTimers();
        const made = await make({ scope: timers.scope });
        const release = () => timers.scope(() => made.release());
        return ownedByEngine(scene, name, release, {
          async check({ phase }) {
            if (phase !== 'disposed') return;
            timers.expectNone(name);
            await made.check?.();
          },
        });
      },
    });

  own('GameServer', async ({ scope }) => {
    const world = scope(() => arena());
    const client = await world.join(),
      other = await world.join({}, { latency: 40 });
    world.run(200);
    if (!world.server.players.includes(client.player)) lifetimeFault('a joined client is a player of the server');
    return {
      release() {
        client.close();
        other.close();
        world.server.close();
      },
      check() {
        if (client.open) lifetimeFault('a closed server closes the connection of its clients');
      },
    };
  });

  own('RollbackSession', ({ scope }) => {
    const network = new LoopbackNetwork({ latency: 20 }),
      [a, b] = network.pair();
    const sessions = [
      [1, 2, a],
      [2, 1, b],
    ].map(([local, remote, link]) =>
      scope(
        () =>
          new RollbackSession(arenaGame, {
            players: [1, 2],
            local,
            peers: new Map([[remote, link]]),
            input: () => ({ x: 0, y: 0, boost: false }),
            now: () => network.time,
          }),
      ),
    );
    for (let i = 0; i < 30; i++) {
      network.advance(1000 / 60);
      for (const session of sessions) session.update();
    }
    return {
      release() {
        for (const session of sessions) session.close();
      },
      check() {
        if (a.open || b.open) lifetimeFault('closed sessions close their links');
      },
    };
  });

  own('RollbackRelay', ({ scope }) => {
    const network = new LoopbackNetwork({ latency: 10 }),
      relay = scope(() => new RollbackRelay({ players: [1, 2] }));
    const connect = () => {
      const [near, far] = network.pair();
      relay.accept(far);
      return near;
    };
    const links = [1, 2].map(() => connect());
    const sessions = [1, 2].map(
      (local, i) =>
        new RollbackSession(arenaGame, {
          players: [1, 2],
          local,
          peers: relayPeers(links[i], { players: [1, 2], local }),
          input: () => ({ x: 0, y: 0, boost: false }),
          now: () => network.time,
        }),
    );
    const watcher = scope(() => new RollbackSpectator(arenaGame, connect()));
    for (let i = 0; i < 30; i++) {
      network.advance(1000 / 60);
      for (const session of sessions) session.update();
      watcher.update();
    }
    return {
      release() {
        watcher.close();
        for (const session of sessions) session.close();
        relay.close();
      },
      check() {
        if (relay.watching) lifetimeFault('a closed relay lets go of its spectators');
      },
    };
  });

  own('RoomServer', async ({ scope }) => {
    const network = new LoopbackNetwork({ latency: 5 }),
      rooms = scope(() => new RoomServer().define('match', Match));
    network.listen().onconnection = (connection) => rooms.accept(connection);
    const client = new RoomsClient(async () => network.connect());
    const joining = scope(() => client.joinOrCreate('match', {}, { schema, stateType: 'State' }));
    joining.catch(() => {});
    await settle(network, 100);
    const joined = await joining;
    return {
      release() {
        joined.leave?.();
        rooms.close();
      },
      check() {
        if (rooms.rooms.length) lifetimeFault('a closed server disposes its rooms');
      },
    };
  });

  own('RoomLobby', async ({ scope }) => {
    const rooms = scope(() => new RoomServer().define('seats', Seats)),
      lobby = new RoomLobby(rooms);
    const room = await scope(() => rooms.create('seats'));
    const seat = scope(() => lobby.reserve(room.roomId, {}, 60_000));
    if (!seat || lobby.list().length !== 1) lifetimeFault('a lobby lists its room and reserves a seat');
    return {
      release() {
        rooms.close();
      },
    };
  });

  own('MemoryPresence', async ({ scope }) => {
    const rooms = scope(() => new RoomServer().define('match', Match)),
      presence = new MemoryPresence();
    const nodeA = scope(() => new RoomNode(rooms, { endpoint: 'ws://127.0.0.1:1/play', presence }));
    // sync() publishes the room directory once; the run() loops are real-time and covered by presence.test.js: a loop of
    // another instance that re-arms its abort listener while this one is being made would be counted as this one's.
    await scope(() => nodeA.sync());
    const store = new MemoryPresenceStore();
    return {
      async release() {
        await nodeA.close().catch(() => {});
        rooms.close();
        store[Symbol.dispose]();
        presence[Symbol.dispose]();
      },
    };
  });

  own('HostMigration', ({ scope }) => {
    const network = new LoopbackNetwork({ latency: 10 }),
      [a, b] = network.pair();
    const initial = { count: 0 };
    const sessions = [
      [1, 2, a],
      [2, 1, b],
    ].map(([local, remote, link]) =>
      scope(
        () =>
          new HostMigration({
            schema,
            stateType: 'State',
            local,
            peers: new Map([[remote, link]]),
            initial,
            now: () => network.time,
          }),
      ),
    );
    network.advance(50);
    return {
      release() {
        for (const session of sessions) session.close();
      },
    };
  });

  own('SignalServer', async ({ scope }) => {
    const network = new LoopbackNetwork({ latency: 5 }),
      signals = scope(() => new SignalServer({ now: () => network.time }));
    network.listen().onconnection = (connection) => signals.accept(connection);
    const joining = scope(() => SignalClient.join(network.connect(), 'room'));
    await settle(network, 100);
    const one = await joining;
    // A second connection never joins: the server's deadline timer is armed for it, and released with the server.
    scope(() => network.connect());
    await settle(network, 50);
    return {
      release() {
        one.close();
        signals.close();
      },
      check() {
        if (signals.roomCount) lifetimeFault('a closed signalling server holds no room');
      },
    };
  });

  own('dataChannelConnection', ({ scope }) => {
    const channel = Object.assign(new EventTarget(), {
      readyState: 'open',
      binaryType: 'blob',
      sent: 0,
      send() {
        this.sent++;
      },
      close() {
        this.readyState = 'closed';
        queueMicrotask(() => this.dispatchEvent(new Event('close')));
      },
    });
    const connection = scope(() => dataChannelConnection({ reliable: channel }));
    connection.send(new Uint8Array([1]));
    return {
      release() {
        connection.close();
      },
      check() {
        if (connection.open) lifetimeFault('a closed channel connection is not open');
      },
    };
  });

  if (node) {
    const { listenWebSocket } = await load('../dist/node.js');
    own('listenWebSocket', async ({ scope }) => {
      const listener = await scope(() => listenWebSocket({ port: 0, host: '127.0.0.1' }));
      const server = new GameServer(arenaGame);
      listener.onconnection = (connection) => server.accept(connection);
      const link = await openWebSocket(`ws://127.0.0.1:${listener.port}`);
      return {
        release: () => {
          link.close();
          server.close();
          return listener.close();
        },
      };
    });
  }
  return entries;
}
