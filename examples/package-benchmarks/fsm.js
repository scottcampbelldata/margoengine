import { StateMachine } from '../../packages/fsm/dist/index.js';
import { grid } from './layout.js';

export function createWorkload(count = 1000) {
  const points = grid(count),
    origins = points.slice(),
    machines = [];
  const names = ['idle', 'move', 'rest'];
  const states = {
    agent: {
      update(c, delta) {
        c.timer += delta;
        c.phase += delta;
      },
    },
    idle: {
      parent: 'agent',
      enter(c) {
        c.mode = 0;
      },
      update(c) {
        c.offset = 0;
      },
    },
    move: {
      parent: 'agent',
      enter(c) {
        c.mode = 1;
      },
      update(c) {
        c.offset = Math.sin(c.phase * 3) * 0.13;
      },
    },
    rest: {
      parent: 'agent',
      enter(c) {
        c.mode = 2;
      },
      update(c) {
        c.offset = Math.cos(c.phase) * 0.04;
      },
    },
  };
  const transitions = names.map((from, i) => ({ from, to: names[(i + 1) % 3], event: 'next', duration: 0.2 }));
  transitions.push({ from: 'agent', to: 'idle', event: 'reset', duration: 0.2 });
  for (let i = 0; i < count; i++)
    machines.push(
      new StateMachine(states, 'idle', { timer: (i % 17) / 17, phase: i * 0.137, offset: 0, mode: 0 }, transitions),
    );
  let changes = 0,
    frames = 0;
  return {
    points,
    machines,
    description:
      'Update a parent and child state for each agent; timed events cycle idle, moving and resting states with visible cross-fades.',
    step(delta) {
      frames++;
      for (let i = 0; i < count; i++) {
        const machine = machines[i],
          c = machine.context;
        machine.update(delta);
        if (c.timer >= 1) {
          c.timer -= 1;
          if (machine.send('next')) changes++;
        }
        const previous = machine.previous ? names.indexOf(machine.previous) : c.mode;
        points[i * 4] = origins[i * 4] + c.offset;
        points[i * 4 + 1] = 0.15 + (previous * (1 - machine.blend) + c.mode * machine.blend) * 0.16;
        points[i * 4 + 3] = c.mode;
      }
    },
    details: () => ({ machines: count, hierarchyUpdatesPerFrame: count * 2, transitions: changes, frames }),
    reset() {
      for (const machine of machines) if (machine.send('reset')) changes++;
    },
  };
}
