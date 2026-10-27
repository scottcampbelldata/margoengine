// The arena: a small multiplayer game of boxes. Each player drives one box; crates get pushed around. Shared by the
// server, the browser client and the package tests. Deterministic (only + - * / and comparisons), so server and
// client agree bit for bit on the same inputs.
import { defineGame, defineSchema } from '@margoengine/netcode';

const unit = { type: 'quantized', min: -1, max: 1, bits: 8 },
  coordinate = { type: 'quantized', min: -32, max: 32, bits: 20 },
  speed = { type: 'quantized', min: -20, max: 20, bits: 16 };

/** The arena's schema: inputs, boxes, the state, and two messages. */
export const schema = defineSchema({
  types: {
    Input: { x: unit, y: unit, boost: 'bool' },
    Box: { x: coordinate, y: coordinate, vx: speed, vy: speed, owner: 'uint' },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 256 } },
    Chat: { text: { type: 'string', maxLength: 64 } },
    Shot: { tick: 'f64', x: 'f32', y: 'f32', dx: 'f32', dy: 'f32' },
  },
});

/** Half the arena's width: boxes stay within -WALL..WALL on both axes. */
export const WALL = 30;
/** Entity ids of crates start here (players use their player ids). */
export const CRATE = 100000;
const clamp = (v, low, high) => (v < low ? low : v > high ? high : v);

/** The arena game at 30 ticks per second. */
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
      box.vx = clamp(box.vx * (1 - 4 * dt), -19, 19);
      box.vy = clamp(box.vy * (1 - 4 * dt), -19, 19);
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
