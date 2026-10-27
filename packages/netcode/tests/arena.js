// The test fixture: a small arena of boxes. Each player drives one box; crates get pushed around. Deterministic
// (only + - * / and comparisons), so server and client agree bit for bit on the same inputs.
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from '../dist/index.js';

const unit = { type: 'quantized', min: -1, max: 1, bits: 8 },
  coordinate = { type: 'quantized', min: -32, max: 32, bits: 20 },
  speed = { type: 'quantized', min: -20, max: 20, bits: 16 };

export const schema = defineSchema({
  types: {
    Input: { x: unit, y: unit, boost: 'bool' },
    Box: { x: coordinate, y: coordinate, vx: speed, vy: speed, owner: 'uint' },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 256 } },
    Chat: { text: { type: 'string', maxLength: 64 } },
  },
});

export const WALL = 30,
  CRATE = 100000;
const clamp = (v, low, high) => (v < low ? low : v > high ? high : v);

export const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => ({
    boxes: new Map([0, 1, 2, 3].map((i) => [CRATE + i, { x: -6 + 4 * i, y: 8, vx: 0, vy: 0, owner: 0 }])),
  }),
  join(state, id) {
    state.boxes.set(id, { x: -20 + ((id * 5) % 40), y: -10, vx: 0, vy: 0, owner: id });
  },
  leave(state, id) {
    state.boxes.delete(id);
  },
  step(state, inputs, _tick, dt) {
    const boxes = [...state.boxes.values()];
    for (const box of boxes) {
      const input = box.owner ? inputs.get(box.owner) : undefined;
      if (input) {
        const accel = input.boost ? 60 : 30;
        box.vx += input.x * accel * dt;
        box.vy += input.y * accel * dt;
      }
      box.vx *= 1 - 4 * dt;
      box.vy *= 1 - 4 * dt;
      box.vx = clamp(box.vx, -19, 19);
      box.vy = clamp(box.vy, -19, 19);
      box.x += box.vx * dt;
      box.y += box.vy * dt;
      if (box.x < -WALL || box.x > WALL) {
        box.x = clamp(box.x, -WALL, WALL);
        box.vx = -box.vx * 0.5;
      }
      if (box.y < -WALL || box.y > WALL) {
        box.y = clamp(box.y, -WALL, WALL);
        box.vy = -box.vy * 0.5;
      }
    }
    // Unit boxes push each other apart along the axis of least overlap.
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j],
          dx = b.x - a.x,
          dy = b.y - a.y,
          ox = 1 - Math.abs(dx),
          oy = 1 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        if (ox < oy) {
          const push = (dx < 0 ? -ox : ox) / 2;
          a.x = clamp(a.x - push, -WALL, WALL);
          b.x = clamp(b.x + push, -WALL, WALL);
        } else {
          const push = (dy < 0 ? -oy : oy) / 2;
          a.y = clamp(a.y - push, -WALL, WALL);
          b.y = clamp(b.y + push, -WALL, WALL);
        }
      }
  },
});

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
