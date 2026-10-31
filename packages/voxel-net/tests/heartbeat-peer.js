// The far end of the slow event loop tests, in its own process, so that blocking the test's own thread leaves it running.
//   server <options as JSON>: a VoxelServer; reports { port }.
//   client <url>: a client that joins and then sends nothing of its own; its WebSocket still answers pings. Reports { joined }.
import { decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const [mode, argument] = process.argv.slice(2);
if (mode === 'server') {
  const server = new VoxelServer({
      blocks: testBlocks(),
      workers: 1,
      generator: new URL('./flat-generator.js', import.meta.url),
      ...JSON.parse(argument),
    }),
    { port } = await server.listen(0);
  process.send({ port });
} else {
  const connection = await connectWebSocket(argument);
  connection.onmessage = (bytes) => {
    if (decodeServerMessage(bytes).type === 'state') process.send({ joined: true });
  };
  connection.send(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name: 'quiet' }));
}
