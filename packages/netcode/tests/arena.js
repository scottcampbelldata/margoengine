// The test harness around the arena example (examples/arena/game.js, the same game the demo plays).
import { GameClient, GameServer, LoopbackNetwork } from '../dist/index.js';
import { CRATE, game, schema, WALL } from '../examples/arena/game.js';

export { CRATE, game, schema, WALL };

/**
 * A server and a loopback network driven at 60 frames per second of virtual time. `frame()` advances one frame:
 * delivers messages, runs the server's due ticks, and updates every joined client.
 */
export function arena(conditions = {}, serverOptions = {}) {
  const network = new LoopbackNetwork(conditions),
    now = () => network.time,
    server = new GameServer(game, { now, ...serverOptions }),
    listener = network.listen(),
    clients = [],
    states = new Map();
  listener.onconnection = (connection) => server.accept(connection);
  let nextTick = game.tickMs;
  const frame = (ms = 1000 / 60) => {
    network.advance(ms);
    while (network.time >= nextTick) {
      server.step();
      states.set(server.tick, schema.encode('State', server.state));
      nextTick += game.tickMs;
    }
    for (const client of clients) if (client.open) client.update();
  };
  const run = (ms) => {
    for (const end = network.time + ms; network.time < end; ) frame();
  };
  const join = async (options = {}, link = {}) => {
    const connection = network.connect(link);
    let done = false;
    const promise = GameClient.join(game, connection, { now, input: () => ({ x: 0, y: 0, boost: false }), ...options });
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 600 && !done; i++) {
      frame();
      await null;
    }
    const client = await promise;
    clients.push(client);
    return client;
  };
  return { network, server, clients, states, frame, run, join };
}
