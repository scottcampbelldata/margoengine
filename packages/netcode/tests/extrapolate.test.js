import test from 'node:test';
import assert from 'node:assert/strict';
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from '../dist/index.js';
import { Extrapolator } from '../dist/extrapolate.js';

const SPEED = 3;
const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    Box: {
      x: 'f32',
      heading: { type: 'f32', interpolate: 'angle' },
      lap: 'u32',
    },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 8 } },
  },
});
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => ({ boxes: new Map() }),
  join: (state, id) => void state.boxes.set(id, { x: 0, heading: 3, lap: 0 }),
  step(state, _inputs, tick, dt) {
    for (const box of state.boxes.values()) {
      box.x += SPEED * dt;
      box.heading = ((box.heading + 0.5 * dt + Math.PI) % (2 * Math.PI)) - Math.PI;
      box.lap = tick;
    }
  },
});

async function world(options) {
  const network = new LoopbackNetwork({ latency: 20 }),
    now = () => network.time,
    server = new GameServer(game, { now });
  network.listen().onconnection = (connection) => server.accept(connection);
  let stalled = false;
  const frame = () => {
    network.advance(1000 / 60);
    if (!stalled) while (network.time >= (server.tick + 1) * game.tickMs) server.step();
  };
  let client;
  GameClient.join(game, network.connect(), { now, input: () => ({ x: 0 }) }).then((joined) => (client = joined));
  for (let i = 0; i < 2000 && !client; i++) {
    frame();
    await null;
  }
  const view = new Extrapolator(client, { now, ...options });
  const draw = () => {
    frame();
    client.update();
    return view.state().boxes.get(client.player);
  };
  for (let i = 0; i < 120; i++) draw();
  return { client, draw, server, view, stall: (on) => (stalled = on) };
}

test('extrapolate: with the snapshots on time it draws just what interpolated() draws', async () => {
  const w = await world();
  for (let i = 0; i < 30; i++) {
    const drawn = w.draw();
    assert.equal(w.view.late, 0);
    assert.ok(Math.abs(drawn.x - w.client.interpolated().boxes.get(w.client.player).x) < 1e-6);
  }
});

test('extrapolate: a late snapshot keeps the entity moving at its speed, where interpolated() freezes', async () => {
  const w = await world({ maxTicks: 12 });
  w.stall(true);
  let moved = 0,
    last = w.draw().x;
  for (let i = 0; i < 40; i++) {
    const drawn = w.draw();
    if (w.view.late > 0 && w.view.late < 12) {
      moved++;
      const held = w.client.authoritative.boxes.get(w.client.player).x,
        expected = held + (SPEED * w.view.late) / game.tickRate;
      assert.ok(Math.abs(drawn.x - expected) < 1e-3, `${drawn.x} is on the line to ${expected}`);
      assert.ok(drawn.x > last, 'it moves');
      assert.ok(drawn.x > w.client.interpolated().boxes.get(w.client.player).x);
    }
    last = drawn.x;
  }
  assert.ok(moved > 5, `${moved} frames ran past the newest snapshot`);
});

test('extrapolate: it stops at maxTicks and holds, and a step field keeps its newest value', async () => {
  const w = await world({ maxTicks: 3 });
  w.stall(true);
  let drawn;
  for (let i = 0; i < 80; i++) drawn = w.draw();
  assert.ok(w.view.late > 3);
  const held = w.client.authoritative.boxes.get(w.client.player);
  assert.ok(Math.abs(drawn.x - (held.x + (SPEED * 3) / game.tickRate)) < 1e-3);
  assert.equal(w.draw().x, drawn.x, 'holding');
  assert.equal(drawn.lap, held.lap);
});

test('extrapolate: when the truth arrives it blends there with no jump, then matches interpolated()', async () => {
  const stalled = async (blend) => {
    const w = await world({ maxTicks: 12, blend });
    w.stall(true);
    let last;
    for (let i = 0; i < 60; i++) last = w.draw().x;
    w.stall(false);
    let largest = 0,
      settled;
    for (let i = 0; i < 60; i++) {
      settled = w.draw();
      largest = Math.max(largest, Math.abs(settled.x - last));
      last = settled.x;
    }
    assert.equal(w.view.late, 0);
    assert.ok(Math.abs(settled.x - w.client.interpolated().boxes.get(w.client.player).x) < 1e-6);
    return largest;
  };
  const jump = await stalled(0),
    eased = await stalled(100);
  assert.ok(jump > 1, `with no blend the truth is ${jump} away`);
  assert.ok(eased < jump / 3, `largest step ${eased} of a jump of ${jump}`);
});

test('extrapolate: an angle goes on the short way across the wrap', async () => {
  const w = await world({ maxTicks: 30, blend: 0 });
  w.stall(true);
  let before = w.draw().heading;
  for (let i = 0; i < 90; i++) {
    const heading = w.draw().heading,
      step = Math.abs(((heading - before + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    assert.ok(step < 0.1, `heading stepped ${step}`);
    before = heading;
  }
});

test('extrapolate: bad options are refused', async () => {
  const w = await world();
  assert.throws(() => new Extrapolator(w.client, { maxTicks: -1 }), RangeError);
  assert.throws(() => new Extrapolator(w.client, { blend: Number.NaN }), RangeError);
  assert.throws(() => new Extrapolator({}), TypeError);
});
