// Lag compensation (@margoengine/voxel-net/rewind): the shot codec, then a real server where one player walks past
// another: a shot at where the walker was hits it rewound and misses it unrewound, the rewind is clamped, a block in
// the way stops the shot, and a client's own shot at the walker it draws comes back as a hit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient } from '../dist/index.js';
import { decodeShot, encodeShot, SHOT_PREFIX, sendShot, VoxelRewind } from '../dist/rewind.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const flat = new URL('./flat-generator.js', import.meta.url),
  blocks = testBlocks(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  STEP = 0.125; // blocks the walker moves each tick: 2.5 blocks per second at 20 Hz

async function until(what, done) {
  const end = performance.now() + 10_000;
  while (!done()) {
    assert.ok(performance.now() < end, `timed out waiting for ${what}`);
    await wait(10);
  }
}
// Player 1 (the shooter) at z 8, player 2 (the walker) at z 12; the walker is moved along +x by the server each tick,
// before the rewind records, so the recorded boxes are where its players messages say it is.
async function start(t, options = {}) {
  const server = new VoxelServer({ blocks, workers: 1, generator: flat, spawn: (id) => [31, 4 + id * 4] }),
    { port } = await server.listen(0),
    state = { tick: -1, walking: false };
  t.after(() => server.close());
  server.onTick((tick) => {
    state.tick = tick;
    const walker = server.players.find((p) => p.name === 'walker');
    if (state.walking && walker?.spawned) walker.character.position[0] += STEP;
  });
  const rewind = new VoxelRewind(server, options);
  t.after(() => rewind[Symbol.dispose]());
  return { server, rewind, state, url: `ws://127.0.0.1:${port}` };
}
async function join(url, name, options = {}) {
  const conn = await connectWebSocket(url),
    client = new VoxelNetClient(
      new VoxelWorld({ blocks }),
      { send: (d) => conn.send(d), close: () => conn.close() },
      { view: 2, name, ...options },
    );
  client.onError = (error) => assert.fail(error);
  conn.onmessage = (d) => client.receive(d);
  await until(`${name} spawned`, () => client.spawned);
  return client;
}
const centre = (shape) => shape.position;
const towards = (from, to) => [to[0] - from[0], to[1] - from[1], to[2] - from[2]];

test('a shot round-trips through its codec, and hostile shots throw', () => {
  const shot = { viewTick: 1234.375, direction: [0.5, -0.25, 1] },
    bytes = encodeShot(shot);
  assert.deepEqual([...bytes.subarray(0, 4)], [...SHOT_PREFIX]);
  assert.equal(bytes.length, 4 + 32);
  assert.deepEqual(decodeShot(bytes), shot);
  assert.equal(decodeShot(Uint8Array.of(0x4d, 0x43, 0x48, 1, 1)), undefined, 'a chat message is not a shot');
  assert.equal(decodeShot(Uint8Array.of(1)), undefined);
  assert.throws(() => decodeShot(bytes.subarray(0, 20)), RangeError, 'cut short');
  assert.throws(() => decodeShot(Uint8Array.of(...bytes, 0)), RangeError, 'trailing bytes');
  const nan = new Uint8Array(bytes);
  new DataView(nan.buffer).setFloat64(12, Number.NaN, true);
  assert.throws(() => decodeShot(nan), RangeError, 'not finite');
  assert.throws(
    () => decodeShot(encodeShot({ viewTick: 0, direction: [1, 0, 0] }).fill(0, 12)),
    RangeError,
    'zero aim',
  );
  assert.throws(() => encodeShot({ viewTick: -1, direction: [1, 0, 0] }), RangeError);
  assert.throws(() => encodeShot({ viewTick: 1, direction: [0, 0, 0] }), RangeError);
  assert.throws(() => encodeShot({ viewTick: 1, direction: [1, 0] }), TypeError);
});

test('a shot at where the walker was hits it rewound, misses it now, and is clamped to maxRewind', async (t) => {
  const { server, rewind, state, url } = await start(t, { maxRewind: 0.5 });
  assert.equal(rewind.maxRewindTicks, 10);
  await join(url, 'shooter');
  await join(url, 'walker');
  const shooter = server.players.find((p) => p.name === 'shooter'),
    walker = server.players.find((p) => p.name === 'walker');
  state.walking = true;
  const from = state.tick;
  await until('12 ticks of walking', () => state.tick >= from + 12);
  const now = state.tick,
    eye = [shooter.character.position[0], shooter.character.position[1] + 1.62, shooter.character.position[2]],
    then = rewind.at(now - 6).get(walker.id),
    aim = towards(eye, centre(then));
  // 6 ticks ago the walker was 0.75 blocks back along x: its box is 0.6 wide, so now the same aim passes beside it.
  assert.ok(Math.abs(centre(rewind.at(now).get(walker.id))[0] - centre(then)[0] - 6 * STEP) < 1e-9);
  const rewound = rewind.shoot(shooter, { viewTick: now - 6, direction: aim });
  assert.equal(rewound.player, walker);
  assert.equal(rewound.tick, now - 6);
  assert.deepEqual(rewound.origin, eye);
  assert.ok(Math.abs(rewound.distance - (Math.hypot(...aim) - (0.3 * Math.hypot(...aim)) / Math.abs(aim[2]))) < 1e-6);
  const unrewound = rewind.shoot(shooter, { viewTick: now, direction: aim });
  assert.equal(unrewound.player, undefined, 'no lag compensation: a miss');
  assert.ok(unrewound.block, 'it flies on, down to the ground behind');
  // A client claiming to see tick 0 (over 12 ticks back) is checked 10 back (0.5 s); a future tick is checked now.
  assert.ok(now > 12);
  assert.equal(rewind.shoot(shooter, { viewTick: 0, direction: aim }).tick, now - 10);
  assert.equal(rewind.shoot(shooter, { viewTick: now + 9, direction: aim }).tick, now);
  // The shooter never hits itself, and maxDistance cuts the shot short.
  assert.equal(rewind.shoot(shooter, { viewTick: now - 6, direction: [0, -1, 0] }).player, undefined);
  assert.equal(rewind.shoot(shooter, { viewTick: now - 6, direction: aim }, 2).player, undefined);
  assert.throws(() => rewind.shoot(shooter, { viewTick: Number.NaN, direction: aim }), RangeError);
});

test('a block between the shooter and the walker stops the shot', async (t) => {
  const { server, rewind, state, url } = await start(t);
  await join(url, 'shooter');
  await join(url, 'walker');
  const shooter = server.players.find((p) => p.name === 'shooter'),
    walker = server.players.find((p) => p.name === 'walker'),
    now = state.tick,
    eye = [shooter.character.position[0], shooter.character.position[1] + 1.62, shooter.character.position[2]],
    aim = towards(eye, centre(rewind.at(now).get(walker.id)));
  assert.equal(rewind.shoot(shooter, { viewTick: now, direction: aim }).player, walker);
  const cell = [Math.floor(eye[0]), Math.floor(eye[1]), 10];
  server.world.setBlock(cell[0], cell[1], cell[2], blocks.id('stone'));
  const blocked = rewind.shoot(shooter, { viewTick: now, direction: aim });
  assert.equal(blocked.player, undefined);
  assert.deepEqual(blocked.block.cell, cell);
  assert.ok(Math.abs(blocked.distance - Math.hypot(...blocked.point.map((v, i) => v - eye[i]))) < 1e-9);
});

for (const frameStall of [0, 30]) {
  test(`a client shot hits rewound and misses unrewound with a ${frameStall}s frame-clock stall`, async (t) => {
    const { server, rewind, state, url } = await start(t),
      shots = [];
    rewind.onShot = (shooter, hit, shot) => shots.push({ shooter, hit, shot });
    // Drawn 0.25 s behind: about 5 ticks, 0.6 blocks back, past the walker's half width of 0.3.
    const client = await join(url, 'shooter', { interpolationDelay: 0.25 });
    assert.equal(sendShot(client, [0, 0, 1]), false, 'no players message yet: no tick to send');
    await join(url, 'walker');
    const walker = server.players.find((p) => p.name === 'walker');
    state.walking = true;
    const from = state.tick;
    await until('the walker drawn walking', () => {
      const drawn = client.samplePlayers().get(walker.id);
      return state.tick >= from + 15 && drawn && drawn.snapshot.position[0] > 31 + STEP * 4;
    });
    // Anchor the rendered frame to a received simulation tick, not elapsed wall time.
    // A loaded event loop can advance the frame clock while the server tick is still waiting.
    const sampleTick = client.players.get(walker.id).last.time * server.tickRate - 5,
      frameClock = performance.now() / 1000 + frameStall,
      now = frameClock + (sampleTick - client.viewTick(frameClock)) / server.tickRate,
      drawn = client.samplePlayers(now).get(walker.id).snapshot.position,
      eye = [client.player.position[0], client.player.position[1] + 1.62, client.player.position[2]],
      aim = towards(eye, [drawn[0], drawn[1] + 0.9, drawn[2]]);
    const seen = client.viewTick(now);
    assert.ok(Math.abs(seen - sampleTick) < 1e-9, 'the frame shows the chosen received tick even after a clock stall');
    assert.ok(seen < state.tick - 2, 'the client sees the past');
    const shooterNow = server.players.find((p) => p.name === 'shooter');
    assert.equal(
      rewind.shoot(shooterNow, { viewTick: state.tick, direction: aim }).player?.id,
      undefined,
      'the same frame already misses without rewind before transport callbacks advance the walker',
    );
    assert.equal(sendShot(client, aim, now), true);
    await until('the shot', () => shots.length === 1);
    const [{ shooter, hit, shot }] = shots;
    assert.equal(shooter.name, 'shooter');
    assert.equal(hit.player, walker, `rewound to tick ${hit.tick}`);
    assert.equal(shot.viewTick, seen);
    assert.equal(
      rewind.shoot(shooter, { viewTick: state.tick, direction: aim }).player?.id,
      undefined,
      'unrewound: a miss',
    );
  });
}

test('options are checked, a custom hitbox is used, unreadable shots close the client, and dispose stops it', async (t) => {
  const server = new VoxelServer({ blocks, workers: 1, generator: flat });
  t.after(() => server.close());
  assert.throws(() => new VoxelRewind({}), TypeError);
  assert.throws(() => new VoxelRewind(server, { maxRewind: 0 }), RangeError);
  assert.throws(() => new VoxelRewind(server, { maxRewind: 1000 }), RangeError);
  assert.throws(() => new VoxelRewind(server, { maxDistance: -1 }), RangeError);
  assert.throws(() => new VoxelRewind(server, { hitbox: 1 }), TypeError);
  const {
    server: live,
    rewind,
    state,
    url,
  } = await start(t, {
    hitbox: (_player, [x, y, z]) => ({ position: [x, y + 1, z], radius: 2 }),
  });
  await join(url, 'shooter');
  await join(url, 'walker');
  const walker = live.players.find((p) => p.name === 'walker'),
    sphere = rewind.at(state.tick).get(walker.id);
  assert.equal(sphere.radius, 2);
  const shooterClient = await join(url, 'rude'),
    rude = live.players.find((p) => p.name === 'rude');
  assert.ok(rude);
  shooterClient.sendApp(Uint8Array.of(...SHOT_PREFIX, 1, 2));
  await until('rude closed', () => !live.players.includes(rude));
  rewind[Symbol.dispose]();
  assert.equal(rewind.at(state.tick).size, 0, 'nothing recorded after dispose');
});
