// A player whose inputs wait on chunks the server is still generating is not closed for the wait (Plaza's load test:
// 38 of 150 flying bots got 1008 'too many messages'), while a flood is still closed, held or not.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  SPAWN = [-1.5, -16]; // chunk column (-1, -1): one chunk from the column that waits

// Flat ground, where chunk (1, 0, -1) is not done until the file `release` exists: a generator behind on its work.
function waitingGenerator(t) {
  const dir = mkdtempSync(join(tmpdir(), 'voxel-net-held-')),
    file = join(dir, 'generator.mjs'),
    release = join(dir, 'release');
  writeFileSync(
    file,
    `import { existsSync } from 'node:fs';
     export default async function waiting(chunk, cx, cy, cz) {
       if (cx === 1 && cy === 0 && cz === -1)
         while (!existsSync(${JSON.stringify(release)})) await new Promise((done) => setTimeout(done, 20));
       if (cy === 0) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) chunk.set(x, 0, z, 1);
     }`,
  );
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return { url: pathToFileURL(file), release: () => writeFileSync(release, '') };
}

async function start(t) {
  const generator = waitingGenerator(t),
    server = new VoxelServer({
      blocks,
      workers: 2,
      flight: true,
      view: 2,
      simulation: 2,
      simulationHeight: 1,
      generator: generator.url,
      spawn: () => SPAWN,
    }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, release: generator.release, url: `ws://127.0.0.1:${port}` };
}

// Joins with raw messages, so the test decides what is sent and when; resolves once spawned.
async function joinRaw(url) {
  const conn = await connectWebSocket(url),
    player = { conn, spawn: undefined, closed: undefined };
  conn.onclose = (code, reason) => {
    player.closed = { code, reason };
  };
  await new Promise((resolve) => {
    conn.onmessage = (data) => {
      const m = decodeServerMessage(data);
      if (m.type === 'state' && m.spawn) {
        player.spawn = m;
        resolve();
      }
    };
    conn.send(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name: 'held' }));
  });
  return player;
}

// One input of 6 steps flying along +x (yaw 49152 is a three quarter turn), claiming to be at `position`.
const input = (step, position) =>
  encodeClientMessage({
    type: 'input',
    step,
    acked: 0,
    runs: [{ steps: 6, keys: 1 | 128, yaw: 49152, pitch: 0 }],
    position,
  });

// Flies into chunk column 0, whose neighbour (1, 0, -1) is not made: the server holds the inputs from there on.
async function flyUntilHeld(player, server) {
  const position = [...player.spawn.position];
  let step = 1,
    x = -Infinity;
  for (let i = 0; i < 200 && !player.closed; i++) {
    player.conn.send(input(step, position));
    step += 6;
    await wait(50);
    x = server.players[0].character.position[0];
    if (x >= 0 && i > 10) break;
  }
  assert.ok(x >= 0, `the player got to x ${x}, short of the chunk that holds it`);
  await wait(200);
  return { step, position };
}

test('inputs waiting on the generator past the queue limit do not close the player, and it plays on', {
  timeout: 60_000,
}, async (t) => {
  const { server, release, url } = await start(t),
    player = await joinRaw(url);
  let { step, position } = await flyUntilHeld(player, server);
  const held = server.players[0].character.position[0];
  // 400 more than the 256 the old queue took, at the 64 a second the wait allows.
  for (let i = 0; i < 660 && !player.closed; i++) {
    player.conn.send(input(step, position));
    step += 6;
    if (i % 32 === 31) await wait(500);
  }
  await wait(100);
  assert.equal(player.closed, undefined, `held player was closed: ${player.closed?.reason}`);
  assert.equal(server.players[0].character.position[0], held, 'it moved over a chunk the server does not have');
  // The wait ends: every step is counted, so inputs still follow in order, and the player moves again.
  release();
  const end = performance.now() + 20_000;
  while (server.players[0].character.position[0] === held && performance.now() < end && !player.closed) {
    player.conn.send(input(step, position));
    step += 6;
    await wait(50);
  }
  for (let i = 0; i < 10 && !player.closed; i++) {
    player.conn.send(input(step, position));
    step += 6;
    await wait(50);
  }
  assert.equal(player.closed, undefined, `closed after the wait: ${player.closed?.reason}`);
  assert.ok(server.players[0].character.position[0] > held, 'the player never moved again');
});

test('a flood is closed while the inputs are held', { timeout: 60_000 }, async (t) => {
  const { server, url } = await start(t),
    player = await joinRaw(url);
  let { step, position } = await flyUntilHeld(player, server);
  for (let i = 0; i < 5_000 && !player.closed; i++) {
    player.conn.send(input(step, position));
    step += 6;
  }
  const end = performance.now() + 10_000;
  while (!player.closed && performance.now() < end) await wait(10);
  assert.deepEqual(player.closed, { code: 1008, reason: 'too many messages' });
});

test('a flood is closed when nothing holds the inputs', { timeout: 60_000 }, async (t) => {
  const { url } = await start(t),
    player = await joinRaw(url);
  let step = 1;
  for (let i = 0; i < 5_000; i++) {
    player.conn.send(input(step, player.spawn.position));
    step += 6;
  }
  const end = performance.now() + 10_000;
  while (!player.closed && performance.now() < end) await wait(10);
  assert.deepEqual(player.closed, { code: 1008, reason: 'too many messages' });
});

test("a held player's chunks overtake the generator's queue", { timeout: 60_000 }, async (t) => {
  // Everything past x = 3,200 takes 600 ms a chunk, so the far player's 39 chunks fill the queue for seconds.
  const dir = mkdtempSync(join(tmpdir(), 'voxel-net-order-')),
    file = join(dir, 'generator.mjs');
  writeFileSync(
    file,
    `export default async function slow(chunk, cx, cy) {
       if (cx > 90) await new Promise((done) => setTimeout(done, 600));
       if (cy === 0) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) chunk.set(x, 0, z, 1);
     }`,
  );
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  let joined = 0;
  const server = new VoxelServer({
      blocks,
      workers: 1,
      flight: true,
      view: 2,
      simulation: 2,
      simulationHeight: 1,
      generator: pathToFileURL(file),
      spawn: () => (joined++ ? [3200, 0] : SPAWN),
    }),
    { port } = await server.listen(0),
    url = `ws://127.0.0.1:${port}`;
  t.after(() => server.close());
  const near = await joinRaw(url);
  await wait(500); // its view is done
  let far;
  void joinRaw(url).then((player) => {
    far = player;
  });
  await wait(200);
  const position = [...near.spawn.position];
  let step = 1,
    crossed = false;
  const end = performance.now() + 20_000;
  while (performance.now() < end && !far) {
    near.conn.send(input(step, position));
    step += 6;
    await wait(50);
    if (server.players[0].character.position[0] > 70) {
      crossed = true; // into column 2: every wait on the way was over
      break;
    }
  }
  assert.equal(crossed, true, 'the far player got its slow chunks before the near player got the chunks it stood on');
  assert.equal(far, undefined);
});
