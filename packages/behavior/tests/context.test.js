// Context steering: the chapter's stall, the map rules, subslot headings, blur and memory, and use inside Steering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextMap, ContextSteering, avoid, chase } from '../dist/context.js';
import { Steering, flee, integrate, seek } from '../dist/steering.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);
const heading = (direction) => Math.atan2(direction[2], direction[0]);
const agent = (extra = {}) => ({ position: [0, 0, 0], velocity: [0, 0, 0], maxSpeed: 4, ...extra });

test('the chapter example: seek and flee cancel out and stall, where context steering takes the clear target', () => {
  const targetA = { position: [6, 0, 0] };
  const targetB = { position: [0, 0, 12] };
  const obstacle = { position: [2.5, 0, 0], radius: 1 };

  // Blended forces, the way the chapter sets the trap: seek one way and flee the other along one line add to nothing.
  const blended = agent({ maxForce: 40 });
  const steering = new Steering()
    .add((a, out) => void seek(a, targetA.position, out))
    .add((a, out) => void flee(a, obstacle.position, out));
  for (let i = 0; i < 300; i++) integrate(blended, steering.compute(blended), 1 / 60);
  assert.deepEqual(blended.position, [0, 0, 0], 'blended steering never moved');

  const walked = agent();
  const context = new ContextSteering().add(chase([targetA, targetB])).add(avoid([obstacle], { clearance: 3 }));
  const first = context.decide(walked);
  assert.ok(first.direction[2] > 0.9, `heads for target B, got ${first.direction}`);
  assert.ok(first.strength > 0);
  assert.equal(first.danger, 0);
  for (let i = 0; i < 300; i++) {
    const { direction, strength } = context.decide(walked);
    walked.position[0] += direction[0] * strength * 4 * (1 / 60);
    walked.position[2] += direction[2] * strength * 4 * (1 / 60);
    assert.ok(Math.hypot(walked.position[0] - 2.5, walked.position[2]) > 1, 'never touches the obstacle');
  }
  assert.ok(Math.hypot(walked.position[0], walked.position[2]) > 1, 'it got somewhere');
});

test('an agent never takes a heading with more danger than the lowest available', () => {
  for (let turn = 0; turn < 64; turn++) {
    const a = (turn / 64) * 2 * Math.PI;
    const context = new ContextSteering({ resolution: 12 })
      .add(chase([{ position: [10 * Math.cos(a), 0, 10 * Math.sin(a)] }]))
      .add(avoid([{ position: [2 * Math.cos(a), 0, 2 * Math.sin(a)], radius: 1 }]));
    const { direction } = context.decide(agent());
    const across = Math.acos(direction[0] * Math.cos(a) + direction[2] * Math.sin(a));
    assert.ok(across > Math.asin(1 / 2) - 1e-9, `turn ${turn}: ${across} goes into the obstacle`);
  }
});

test('a second obstacle behind the first adds no danger, since maps keep the highest', () => {
  const map = new ContextMap(8);
  map.write(0, 0.5);
  map.write(0, 0.3);
  near(map.slots[0], 0.5);
  const other = new ContextMap(8);
  other.write(0, 0.9);
  other.write(Math.PI, 0.1);
  map.merge(other);
  near(map.slots[0], 0.9);
  near(map.slots[4], 0.1);
});

test('write wraps around the circle and falls off linearly, or stays flat', () => {
  const map = new ContextMap(8);
  const slot = (2 * Math.PI) / 8;
  map.write(0, 1, 2 * slot);
  near(map.slots[0], 1);
  near(map.slots[1], 0.5);
  near(map.slots[7], 0.5);
  assert.equal(map.slots[2], 0);
  assert.equal(map.slots[6], 0);
  const flat = new ContextMap(8);
  flat.write(-slot, 0.7, slot, true);
  near(flat.slots[7], 0.7);
  near(flat.slots[0], 0.7);
  near(flat.slots[6], 0.7);
  assert.equal(flat.slots[1], 0);
  const whole = new ContextMap(8);
  whole.write(0, 1, 100, true);
  for (const value of whole.slots) near(value, 1);
});

test('the heading lands between slots: 8 slots steer as true as 256', () => {
  for (const target of [0.1, 0.4, 1.3, 2.9, 4.4, 6.1]) {
    const context = new ContextSteering({ resolution: 8 }).add(
      chase([{ position: [10 * Math.cos(target), 0, 10 * Math.sin(target)] }]),
    );
    const angle = heading(context.decide(agent()).direction);
    near(Math.atan2(Math.sin(angle - target), Math.cos(angle - target)), 0, 1e-9);
  }
});

test('next to a masked slot the heading stays on its slot, so it cannot drift into danger', () => {
  const context = new ContextSteering({ resolution: 8 }).add((interest, danger) => {
    interest.write(0.2, 1, Math.PI / 2);
    danger.write(Math.PI / 4, 1);
  });
  near(heading(context.decide(agent()).direction), 0);
});

test('with interest nowhere the agent holds still; when every way is dangerous it takes the least bad', () => {
  const idle = new ContextSteering().decide(agent());
  assert.deepEqual([...idle.direction], [0, 0, 0]);
  assert.equal(idle.strength, 0);
  const trapped = new ContextSteering({ resolution: 8 }).add((interest, danger) => {
    for (let i = 0; i < 8; i++) danger.slots[i] = i === 3 ? 0.2 : 0.8;
    interest.slots.fill(0.5);
  });
  const decision = trapped.decide(agent());
  near(decision.danger, 0.2);
  near(heading(decision.direction), (3 / 8) * 2 * Math.PI);
});

test('slack lets a faint danger through', () => {
  const behavior = (interest, danger) => {
    interest.slots[0] = 1;
    interest.slots[4] = 0.2;
    danger.slots[0] = 0.05;
  };
  assert.ok(new ContextSteering({ resolution: 8 }).add(behavior).decide(agent()).direction[0] < 0);
  assert.ok(new ContextSteering({ resolution: 8, slack: 0.1 }).add(behavior).decide(agent()).direction[0] > 0);
});

test('blur softens a spike and keeps its peak in place', () => {
  const context = new ContextSteering({ resolution: 8, blur: 1 }).add((interest) => {
    interest.slots[2] = 1;
  });
  const { strength, direction } = context.decide(agent());
  near(strength, 0.5);
  near(heading(direction), (2 / 8) * 2 * Math.PI);
  near(context.interest.slots[1], 0.25);
  near(context.interest.slots[3], 0.25);
});

test('memory stops a flip-flop when one target peaks over the other for a moment', () => {
  const flip = (memory) => {
    let tick = 0;
    const context = new ContextSteering({ resolution: 8, memory }).add((interest) => {
      interest.slots[0] = 0.95;
      interest.slots[4] = ++tick % 5 === 0 ? 1.05 : 0.8;
    });
    let flips = 0;
    let last = 0;
    for (let i = 0; i < 40; i++) {
      const side = Math.sign(context.decide(agent()).direction[0]);
      if (last !== 0 && side !== last) flips++;
      last = side;
    }
    return flips;
  };
  // Eight peaks in 40 updates, each a turn there and a turn back, less the last that has no update after it.
  assert.equal(flip(0), 15);
  // The blend settles on the means, 0.95 against 0.85, and a ripple of 0.25 at a tenth weight cannot close that gap.
  assert.equal(flip(0.9), 0);
});

test('steer writes a force toward the heading, scaled by strength, and fits inside Steering', () => {
  const walker = agent({ velocity: [1, 0, 0], maxSpeed: 4 });
  const context = new ContextSteering({ resolution: 8 }).add((interest) => {
    interest.slots[0] = 0.5;
  });
  const out = [0, 0, 0];
  context.steer(walker, out);
  near(out[0], 4 * 0.5 - 1);
  near(out[2], 0);
  const steering = new Steering().add((a, force) => void context.steer(a, force));
  integrate(walker, steering.compute(walker), 1 / 60);
  assert.ok(walker.position[0] > 0);
});

test('chase ignores what is out of range or on top of the agent, and nearer is stronger', () => {
  const near1 = new ContextSteering().add(chase([{ position: [5, 0, 0] }], { range: 10 })).decide(agent());
  const far = new ContextSteering().add(chase([{ position: [9, 0, 0] }], { range: 10 })).decide(agent());
  assert.ok(near1.strength > far.strength);
  assert.equal(new ContextSteering().add(chase([{ position: [11, 0, 0] }], { range: 10 })).decide(agent()).strength, 0);
  assert.equal(new ContextSteering().add(chase([{ position: [0, 0, 0] }])).decide(agent()).strength, 0);
});

test('avoid ignores obstacles past the clearance and grows as they near', () => {
  const danger = (x) => {
    const context = new ContextSteering({ resolution: 16 }).add(
      avoid([{ position: [x, 0, 0], radius: 1 }], { clearance: 2 }),
    );
    context.decide(agent());
    return context.danger.slots[0];
  };
  assert.equal(danger(3.5), 0);
  near(danger(2), 0.5);
  near(danger(1), 1);
  near(danger(0.5), 1);
});

test('malformed input is refused with a message that names the fix', () => {
  assert.throws(() => new ContextMap(3), /resolution/);
  assert.throws(() => new ContextSteering({ blur: -1 }), /blur/);
  assert.throws(() => new ContextSteering({ memory: 1 }), /memory/);
  assert.throws(() => new ContextSteering({ slack: -1 }), /slack/);
  assert.throws(() => new ContextSteering().add(3), /must be a function/);
  assert.throws(() => chase([], { range: 0 }), /range/);
  assert.throws(() => chase([], { spread: -1 }), /spread/);
  assert.throws(() => avoid([], { clearance: 0 }), /clearance/);
  assert.throws(() => avoid([], { radius: -1 }), /radius/);
});
