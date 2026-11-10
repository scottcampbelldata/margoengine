import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { VoxelWorld } from '@margoengine/voxel';
import { createDataChannels } from '@margoengine/netcode/webrtc';
import { VoxelServer } from '../dist/server.js';
import { acceptVoxelNetWebRTC, connectVoxelNetWebRTC } from '../dist/webrtc.js';
import { testBlocks } from './blocks.js';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent = [];
  constructor(options) {
    super();
    Object.assign(this, { maxRetransmits: null, maxPacketLifeTime: null }, options);
  }
  send(data) {
    const bytes = new Uint8Array(data).slice();
    this.sent.push(bytes);
    queueMicrotask(() => this.peer.dispatchEvent(new MessageEvent('message', { data: bytes.buffer })));
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}
function pair() {
  const create = () => createDataChannels({ createDataChannel: (_label, options) => new Channel(options) });
  const a = create(),
    b = create();
  for (const name of ['reliable', 'unreliable']) {
    a[name].peer = b[name];
    b[name].peer = a[name];
  }
  return [a, b];
}
const blocks = testBlocks();
async function until(fn) {
  const signal = AbortSignal.timeout(10000);
  while (!fn()) await delay(10, undefined, { signal });
}
test('WebRTC channels carry the real server codec, chunks and app messages, and select datagram inputs/snapshots', {
  timeout: 30000,
}, async (t) => {
  const server = new VoxelServer({
    blocks,
    workers: 1,
    generator: new URL('./flat-generator.js', import.meta.url),
    spawn: () => [16, 16],
  });
  t.after(() => server.close());
  await server.start();
  const [a, b] = pair();
  const connection = acceptVoxelNetWebRTC(server, b);
  const client = await connectVoxelNetWebRTC(a, new VoxelWorld({ blocks }), { view: 2 });
  t.after(() => client.close());
  client.onError = (e) => assert.fail(e);
  await until(() => client.spawned);
  const [otherNear, otherFar] = pair();
  acceptVoxelNetWebRTC(server, otherFar);
  const other = await connectVoxelNetWebRTC(otherNear, new VoxelWorld({ blocks }), { view: 2 });
  t.after(() => other.close());
  other.onError = (e) => assert.fail(e);
  await until(() => other.spawned);
  const apps = [];
  client.onApp = (data) => apps.push([...data]);
  server.broadcast(Uint8Array.of(8, 9));
  await until(() => apps.length === 1);
  assert.deepEqual(apps, [[8, 9]]);
  for (let i = 0; i < 6; i++) client.update(1 / 60, { keys: 0, yaw: 0, pitch: 0 });
  await until(() => a.unreliable.sent.some((d) => d[0] === 2) && b.unreliable.sent.some((d) => d[0] === 21));
  assert.ok(a.reliable.sent.some((d) => d[0] === 1));
  assert.ok(
    b.reliable.sent.some((d) => d[0] === 16),
    'welcome is reliable',
  );
  assert.ok(
    b.reliable.sent.some((d) => d[0] === 17),
    'chunks are reliable',
  );
  assert.ok(
    b.reliable.sent.some((d) => d[0] === 25),
    'app is reliable',
  );
  assert.equal(connection.datagrams, true);
  assert.ok(connection.bytesIn > 0);
});
test('bad reliability contracts, aborted setup and opening timeout fail clearly and release both channels', async () => {
  const [a] = pair();
  a.unreliable.ordered = true;
  await assert.rejects(connectVoxelNetWebRTC(a, new VoxelWorld({ blocks })), /unordered/);
  const [b] = pair();
  b.reliable.readyState = 'connecting';
  b.unreliable.readyState = 'connecting';
  await assert.rejects(connectVoxelNetWebRTC(b, new VoxelWorld({ blocks }), { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(b.reliable.readyState, 'closed');
  assert.equal(b.unreliable.readyState, 'closed');
  const [c] = pair();
  c.reliable.readyState = 'connecting';
  await assert.rejects(connectVoxelNetWebRTC(c, new VoxelWorld({ blocks }), { timeout: 10 }), /timeout/);
  assert.equal(c.reliable.readyState, 'closed');
  assert.equal(c.unreliable.readyState, 'closed');
  const [d] = pair();
  assert.throws(
    () =>
      acceptVoxelNetWebRTC(
        {
          accept: () => {
            throw new TypeError('start server first');
          },
        },
        d,
      ),
    /start/,
  );
  assert.equal(d.reliable.readyState, 'closed');
  assert.equal(d.unreliable.readyState, 'closed');
});
