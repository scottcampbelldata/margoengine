// Ready-made chat and inventory messages (@margoengine/voxel-net/chat): the codec and hostile bytes, then chat lines,
// whispers, distance, the rate limit and inventories between a real server and clients.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import {
  CHAT_PREFIX,
  cleanChatText,
  decodeChatMessage,
  encodeChatMessage,
  isChatMessage,
  MAX_CHAT_BYTES,
  VoxelChat,
  VoxelChatClient,
  VoxelInventories,
} from '../dist/chat.js';
import { VoxelNetClient } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const flat = new URL('./flat-generator.js', import.meta.url),
  blocks = testBlocks(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, done, state = () => '') {
  const end = performance.now() + 10_000;
  while (!done()) {
    assert.ok(performance.now() < end, `timed out waiting for ${what} ${JSON.stringify(state())}`);
    await wait(10);
  }
}
// Players 1 and 2 spawn 4 blocks apart, player 3 far away when `far`.
async function start(t, far = 0) {
  const server = new VoxelServer({
      blocks,
      workers: 1,
      generator: flat,
      spawn: (id) => [31, id === 3 ? 4 + far : 4 + id * 4],
    }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}` };
}
async function join(url, name) {
  const conn = await connectWebSocket(url),
    client = new VoxelNetClient(
      new VoxelWorld({ blocks }),
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name },
    ),
    apps = [];
  client.onApp = (data) => apps.push(data);
  client.onError = (error) => assert.fail(error);
  conn.onmessage = (d) => client.receive(d);
  const chat = new VoxelChatClient(client),
    lines = [],
    system = [];
  chat.onChat = (line) => lines.push(line);
  chat.onSystem = (text) => system.push(text);
  await until(`${name} spawned`, () => client.spawned);
  return { client, conn, apps, chat, lines, system };
}

test('every chat message round-trips, after the prefix, and other app messages are not chat', () => {
  assert.deepEqual([...CHAT_PREFIX], [0x4d, 0x43, 0x48, 1]);
  for (const m of [
    { type: 'say', text: 'hello' },
    { type: 'say', text: 'psst', to: 0 },
    { type: 'say', text: '', to: 2 ** 32 - 2 },
    { type: 'chat', from: 7, name: 'Ada Ł', text: 'é'.repeat(128), whisper: false },
    { type: 'chat', from: 0, name: '', text: 'x', whisper: true },
    { type: 'system', text: 'Server restarts in 5 minutes' },
    { type: 'inventory', slots: [undefined, { item: 3, count: 64 }, undefined, { item: 2 ** 32 - 1, count: 1 }] },
    { type: 'inventory', slots: [] },
    { type: 'slot', index: 1023, stack: { item: 1, count: 2 } },
    { type: 'slot', index: 0, stack: undefined },
    { type: 'move', from: 0, to: 35, count: 0 },
  ]) {
    const bytes = encodeChatMessage(m);
    assert.ok(isChatMessage(bytes));
    assert.deepEqual(decodeChatMessage(bytes), m);
  }
  assert.equal(decodeChatMessage(Uint8Array.of(0x4d, 0x53, 0x48, 1, 0)), undefined, 'a shard handoff');
  assert.equal(decodeChatMessage(Uint8Array.of(1, 2, 3)), undefined, 'your own');
  assert.equal(decodeChatMessage(CHAT_PREFIX), undefined, 'the prefix alone');
});

test('hostile chat bytes throw instead of reading past their end, and bad fields do not encode', () => {
  const p = [...CHAT_PREFIX];
  for (const hostile of [
    [...p, 9],
    [...p, 1, 0, 5, 104],
    [...p, 1, 0, 200, 2, ...new Uint8Array(300).fill(97)],
    [...p, 1, 0, 2, 0xc0, 0xaf],
    [...p, 2, 1, 0, 2, 0],
    [...p, 3, 1, 97, 0],
    [...p, 4, 0x81, 0x08],
    [...p, 4, 1, 3, 0],
    [...p, 5, 0x80, 0x08, 0],
    [...p, 6, 1],
  ])
    assert.throws(() => decodeChatMessage(Uint8Array.from(hostile)), RangeError, String(hostile));
  assert.throws(() => encodeChatMessage({ type: 'say', text: 'a'.repeat(MAX_CHAT_BYTES + 1) }), RangeError);
  assert.throws(() => encodeChatMessage({ type: 'say', text: 5 }), TypeError);
  assert.throws(() => encodeChatMessage({ type: 'slot', index: 1024 }), RangeError);
  assert.throws(() => encodeChatMessage({ type: 'inventory', slots: [{ item: 0, count: 1 }] }), RangeError);
  assert.throws(() => encodeChatMessage({ type: 'inventory', slots: new Array(1025) }), RangeError);
  assert.throws(() => encodeChatMessage({ type: 'shout' }), TypeError);
});

test('cleanChatText drops what a line never shows and cuts on a character boundary', () => {
  assert.equal(cleanChatText('  hi\n\tthere\u202e\u200b  '), 'hi there');
  assert.equal(cleanChatText('a<b>'), 'a<b>', 'angle brackets stay: show it as text');
  assert.equal(cleanChatText(`e${'\u0301'.repeat(9)}`), '\u00e9\u0301\u0301', 'at most 2 marks in a row');
  const long = cleanChatText('ł'.repeat(200));
  assert.equal(new TextEncoder().encode(long).length, MAX_CHAT_BYTES);
  assert.equal(cleanChatText(7), '');
});

test('a line reaches everyone in range, a whisper only its target and the speaker', async (t) => {
  const { server, url } = await start(t, 400),
    chat = new VoxelChat(server, { distance: 64 }),
    logged = [];
  chat.onLine = (player, text, to) => logged.push([player.name, text, to?.name]);
  const ada = await join(url, 'Ada'),
    lin = await join(url, 'Lin'),
    far = await join(url, 'Far');
  const id = (name) => server.players.find((p) => p.name === name).id;
  assert.equal(ada.chat.say('  hello\u200b all '), true);
  await until('Lin hears it', () => lin.lines.length === 1);
  assert.deepEqual(lin.lines[0], { from: id('Ada'), name: 'Ada', text: 'hello all', whisper: false });
  await until('Ada hears herself', () => ada.lines.length === 1);
  assert.equal(far.lines.length, 0, '400 blocks away is out of range');
  assert.equal(ada.chat.say('psst', id('Far')), true);
  await until('Far hears the whisper', () => far.lines.length === 1);
  assert.deepEqual(far.lines[0], { from: id('Ada'), name: 'Ada', text: 'psst', whisper: true });
  await until('Ada gets her copy', () => ada.lines.length === 2);
  assert.equal(lin.lines.length, 1, 'Lin does not');
  assert.equal(ada.chat.say(' \u200b '), false, 'an empty line is not sent');
  assert.equal(chat.system('Welcome'), 3);
  await until('everyone gets the system line', () => far.system.length === 1 && ada.system.length === 1);
  assert.deepEqual(logged, [
    ['Ada', 'hello all', undefined],
    ['Ada', 'psst', 'Far'],
  ]);
  // Other app messages still reach the game.
  server.send(
    server.players.find((p) => p.name === 'Lin'),
    Uint8Array.of(5),
  );
  await until('the game message', () => lin.apps.length === 1);
  assert.deepEqual(lin.apps[0], Uint8Array.of(5));
  chat[Symbol.dispose]();
  const received = server.metrics.appsReceived;
  ada.chat.say('after dispose');
  await until('the server has the line', () => server.metrics.appsReceived === received + 1);
  // Sent after the line was handled, so Lin has whatever that line brought before this arrives.
  server.send(
    server.players.find((p) => p.name === 'Lin'),
    Uint8Array.of(6),
  );
  await until('the marker', () => lin.apps.length === 2);
  assert.equal(lin.lines.length, 1, 'a disposed chat delivers nothing');
});

test('chat drops lines over its rate, ones the filter refuses and whispers to nobody', async (t) => {
  const { server, url } = await start(t),
    chat = new VoxelChat(server, {
      rate: 0.001,
      burst: 2,
      filter: (text) => (text.includes('bad') ? undefined : text),
    });
  const ada = await join(url, 'Ada'),
    lin = await join(url, 'Lin');
  ada.chat.say('bad word');
  ada.chat.say('one');
  ada.chat.say('two');
  ada.chat.say('psst', 999);
  await until('all four handled', () => chat.stats.said + chat.stats.dropped === 4);
  assert.deepEqual(chat.stats, { said: 1, dropped: 3 });
  await until('Lin hears the one line', () => lin.lines.length === 1);
  assert.deepEqual(
    lin.lines.map((l) => l.text),
    ['one'],
  );
  assert.throws(() => new VoxelChat(server, { rate: 0 }), RangeError);
  assert.throws(() => new VoxelChat({}), TypeError);
});

test('a client that sends unreadable chat bytes is closed with 4002', async (t) => {
  const { server, url } = await start(t);
  new VoxelChat(server);
  const ada = await join(url, 'Ada'),
    closed = new Promise((done) => (ada.conn.onclose = (code, reason) => done({ code, reason })));
  ada.client.sendApp(Uint8Array.of(...CHAT_PREFIX, 1, 0, 9));
  assert.deepEqual(await closed, { code: 4002, reason: 'unreadable-chat' });
});

test('inventories: the server gives and takes, the client sees every slot and may only move its own items', async (t) => {
  const { server, url } = await start(t),
    inv = new VoxelInventories(server, { size: 4, stackLimit: 10, canMove: (_p, _from, to) => to !== 3 });
  const ada = await join(url, 'Ada'),
    changes = [];
  ada.chat.onInventory = (_slots, index) => changes.push(index);
  await until('the full inventory', () => ada.chat.inventory.length === 4);
  assert.deepEqual(ada.chat.inventory, [undefined, undefined, undefined, undefined]);
  const p = server.players[0];
  assert.equal(inv.give(p, 5, 15), 0);
  assert.equal(inv.give(p, 6, 30), 10, 'two slots left for item 6, 10 do not fit');
  assert.deepEqual(inv.slots(p), [
    { item: 5, count: 10 },
    { item: 5, count: 5 },
    { item: 6, count: 10 },
    { item: 6, count: 10 },
  ]);
  assert.equal(inv.count(p, 6), 20);
  assert.equal(inv.take(p, 6, 25), false, 'not that many');
  assert.equal(inv.take(p, 6, 15), true);
  assert.deepEqual(inv.slots(p).slice(2), [{ item: 6, count: 5 }, undefined]);
  await until('the client caught up', () => ada.chat.inventory[3] === undefined && ada.chat.inventory[2]?.count === 5);
  assert.deepEqual(ada.chat.inventory, inv.slots(p));
  // 5 onto the full 10-stack: nothing moves; 2 of slot 0 onto slot 1; whole stacks swap; to slot 3 refused by canMove;
  // to slot 9 is past the inventory. Every move is answered with its slots (6 slot messages so far, 9 more).
  ada.chat.move(1, 0);
  ada.chat.move(0, 1, 2);
  ada.chat.move(2, 0);
  ada.chat.move(0, 3);
  ada.chat.move(0, 9);
  await until(
    'the moves answered',
    () => changes.length === 15,
    () => changes,
  );
  assert.deepEqual(inv.slots(p), [{ item: 6, count: 5 }, { item: 5, count: 7 }, { item: 5, count: 8 }, undefined]);
  assert.deepEqual(ada.chat.inventory, inv.slots(p));
  // A saved inventory comes back whole.
  inv.load(p, [{ item: 9, count: 1 }]);
  await until('the loaded inventory', () => ada.chat.inventory[0]?.item === 9);
  assert.deepEqual(ada.chat.inventory, [{ item: 9, count: 1 }, undefined, undefined, undefined]);
  assert.throws(() => inv.set(p, 4, undefined), RangeError);
  assert.throws(() => inv.set(p, 0, { item: 1, count: 11 }), RangeError);
  assert.throws(() => inv.load(p, new Array(5)), RangeError);
  inv[Symbol.dispose]();
});
