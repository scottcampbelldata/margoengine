// How a WebTransport session ends, as the client and server report it. A server that closes the session is not a
// close by the client: joinOver's own close (called as the client shuts down after the drop) once marked every end
// byClient. A session this package opened or took on is closed again when joining or accepting on it throws.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelServer } from '../dist/server.js';
import { acceptVoxelNetWebTransport, connectVoxelNetWebTransport, joinOver } from '../dist/webtransport.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks();
function connection() {
  const end = { open: true, onmessage: null, onclose: null, sent: [] };
  end.send = (data) => end.sent.push(data);
  end.close = (code = 1000, reason = '') => {
    if (!end.open) return;
    end.open = false;
    end.onclose?.(code, reason);
  };
  return end;
}
// The W3C session shape over in-memory streams, enough to open and accept; `info` records how it was closed.
function session() {
  let ended;
  const s = {
    info: undefined,
    ready: Promise.resolve(),
    closed: new Promise((resolve) => (ended = resolve)),
    close(info = {}) {
      s.info = info;
      ended(info);
    },
    datagrams: {
      readable: new TransformStream().readable,
      maxDatagramSize: 1200,
      createWritable: () => new TransformStream().writable,
    },
    async createBidirectionalStream() {
      const t = new TransformStream();
      return { readable: new TransformStream().readable, writable: t.writable };
    },
    incomingBidirectionalStreams: new ReadableStream({
      start: (c) => c.enqueue({ readable: new TransformStream().readable, writable: new TransformStream().writable }),
    }),
  };
  return s;
}

test('a session the server closes is reported with byClient false; one the client closes with byClient true', () => {
  const dropped = connection(),
    client = joinOver(dropped, new VoxelWorld({ blocks }), { view: 2 }),
    closes = [];
  client.onClose = (event) => closes.push(event);
  dropped.close(1001, 'server closing');
  const mine = connection(),
    other = joinOver(mine, new VoxelWorld({ blocks }), { view: 2 });
  other.onClose = (event) => closes.push(event);
  other.close();
  assert.deepEqual(closes, [
    { code: 1001, reason: 'server closing', byClient: false },
    { code: 1000, reason: '', byClient: true },
  ]);
});

test('connect closes the session it opened when the client cannot be made', async () => {
  const s = session();
  await assert.rejects(
    connectVoxelNetWebTransport('https://game.test/voxel', new VoxelWorld({ blocks }), {
      WebTransport: function () {
        return s;
      },
      inputCopies: 99,
    }),
    RangeError,
  );
  assert.ok(s.info, 'the session was closed');
});

test('accept closes the session it took on when the server refuses it', async () => {
  const server = new VoxelServer({ blocks, workers: 1 }),
    s = session();
  await assert.rejects(acceptVoxelNetWebTransport(server, s), { code: 'state' });
  assert.ok(s.info, 'the session was closed');
  await server.close();
});
