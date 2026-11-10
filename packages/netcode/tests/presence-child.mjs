import { defineSchema } from '../dist/index.js';
import { LobbyRoom } from '../dist/lobby.js';
import { RoomServer } from '../dist/rooms.js';
import { listenWebSocket } from '../dist/node.js';
import { openSqlitePresence, RoomNode } from '../dist/presence.js';
const schema = defineSchema({ types: { State: { joined: 'uint' } } });
class Match extends LobbyRoom {
  schema = schema;
  stateType = 'State';
  maxClients = 1;
  onCreate() {
    this.setPatchRate(0);
    this.setState({ joined: 0 });
    this.setMetadata({ label: process.argv[3] });
  }
  onAuth(_client, options) {
    return options.player === 'Ada';
  }
  onJoin() {
    this.state.joined++;
  }
}
const server = new RoomServer().define('match', Match);
const room = await server.create('match');
const listener = await listenWebSocket({ host: '127.0.0.1', port: 0, origins: '*' });
listener.onconnection = (connection) => server.accept(connection);
const presence = await openSqlitePresence(process.argv[2], { pollInterval: 5 });
const node = new RoomNode(server, {
  endpoint: `ws://127.0.0.1:${listener.port}`,
  presence,
  leaseMs: 5000,
  heartbeatMs: 100,
});
const running = node.run();
running.catch((error) => {
  console.error(error);
  process.send?.({ fatal: String(error) });
});
await node.sync();
process.send({ ready: true, roomId: room.roomId, processId: node.processId });
process.on('message', async (message) => {
  try {
    if (message.command === 'list') process.send({ id: message.id, value: await node.list() });
    if (message.command === 'reserve')
      process.send({ id: message.id, value: await node.reserve(message.roomId, { player: 'Ada' }) });
    if (message.command === 'close') {
      await node.close();
      server.close();
      listener.close();
      presence[Symbol.dispose]();
      process.send({ id: message.id, value: 'closed' });
      process.disconnect();
    }
  } catch (error) {
    process.send({ id: message.id, error: String(error) });
  }
});
