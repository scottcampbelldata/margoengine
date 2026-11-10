// Transport-only browser proof: no rendering, GPU API or GPU lock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { build } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = resolve(import.meta.dirname, '../../..');
const folder = join(root, 'test-results/batch242-webrtc-browser');
const limit = setTimeout(() => {
  console.error('WebRTC browser proof exceeded 60 seconds');
  process.exit(1);
}, 60000);
let browser, web;
try {
  await mkdir(folder, { recursive: true });
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      outDir: folder,
      emptyOutDir: true,
      target: 'es2022',
      lib: {
        entry: {
          webrtc: join(root, 'packages/voxel-net/dist/webrtc.js'),
          voxel: join(root, 'packages/voxel/dist/index.js'),
          rtc: join(root, 'packages/netcode/dist/webrtc.js'),
          codec: join(root, 'packages/voxel-net/dist/index.js'),
        },
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
      },
    },
  });
  web = createServer(async (req, res) => {
    if (!req.url.endsWith('.js')) {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>WebRTC transport proof</title>');
      return;
    }
    try {
      res.setHeader('content-type', 'text/javascript');
      res.end(await readFile(join(folder, basename(req.url))));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((done) => web.listen(0, '127.0.0.1', done));
  browser = await launchBrowser({
    headless: true,
    needs: 'dom',
    args: ['--disable-gpu', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(`http://127.0.0.1:${web.address().port}/`);
  const result = await page.evaluate(async () => {
    const [{ connectVoxelNetWebRTC, acceptVoxelNetWebRTC }, { BlockTypes, VoxelWorld }, { createDataChannels }, codec] =
      await Promise.all([import('/webrtc.js'), import('/voxel.js'), import('/rtc.js'), import('/codec.js')]);
    const a = new RTCPeerConnection(),
      b = new RTCPeerConnection();
    const ca = createDataChannels(a),
      cb = createDataChannels(b);
    const blocks = new BlockTypes();
    const types = [],
      apps = [],
      received = [];
    const errors = [];
    const ready = (fn) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new RangeError('RTC proof wait expired'));
        }, 10000);
        const poll = setInterval(() => {
          if (fn()) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 5);
      });
    try {
      const adapted = acceptVoxelNetWebRTC(
        {
          accept: (connection) => {
            connection.onmessage = (bytes) => {
              const m = codec.decodeClientMessage(bytes);
              types.push(m.type);
              if (m.type === 'hello')
                connection.send(
                  codec.encodeServerMessage({
                    type: 'welcome',
                    version: codec.PROTOCOL_VERSION,
                    id: 1,
                    tickRate: 20,
                    view: 2,
                    viewHeight: 1,
                    simulation: 1,
                    simulationHeight: 1,
                    playerDistance: 96,
                    blocks: codec.blockTableHash(blocks),
                    flight: false,
                    resume: new Uint8Array(),
                    resent: 0,
                  }),
                );
              if (m.type === 'input') received.push([...bytes]);
            };
          },
        },
        cb,
      );
      const ice = [];
      a.onicecandidate = ({ candidate }) => {
        if (candidate) ice.push(b.addIceCandidate(candidate).catch((e) => errors.push(e.message)));
      };
      b.onicecandidate = ({ candidate }) => {
        if (candidate) ice.push(a.addIceCandidate(candidate).catch((e) => errors.push(e.message)));
      };
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      const client = await connectVoxelNetWebRTC(ca, new VoxelWorld({ blocks }), { timeout: 10000, players: false });
      client.onError = (e) => errors.push(String(e));
      client.onApp = (data) => apps.push([...data]);
      await ready(() => !!client.welcome);
      adapted.send(codec.encodeServerMessage({ type: 'app', data: Uint8Array.of(9, 0, 255) }));
      const input = codec.encodeClientMessage({
        type: 'input',
        step: 1,
        acked: 0,
        runs: [{ steps: 1, keys: 0, yaw: 0, pitch: 0 }],
        position: [0, 0, 0],
      });
      ca.unreliable.send(input);
      await ready(() => apps.length === 1 && received.length === 1);
      const answer = {
        ordered: ca.unreliable.ordered,
        retransmits: ca.unreliable.maxRetransmits,
        types,
        apps,
        received,
        expected: [...input],
        errors,
      };
      client.close();
      await Promise.all(ice);
      return answer;
    } finally {
      a.close();
      b.close();
    }
  });
  assert.equal(result.ordered, false);
  assert.equal(result.retransmits, 0);
  assert.deepEqual(result.types, ['hello', 'input']);
  assert.deepEqual(result.apps, [[9, 0, 255]]);
  assert.deepEqual(result.received, [result.expected]);
  assert.deepEqual(result.errors, []);
  console.log('WebRTC: real reliable welcome/app and unordered zero-retransmit input round-trip passed; no GPU work');
} finally {
  await closeAll({ browser, servers: web ? [web] : [] });
  clearTimeout(limit);
}
