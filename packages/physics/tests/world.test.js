// The physics world: one clock in exact base ticks, solvers stepped in coupling order at their dyadic rates, ports through
// the field registry, the same physics at any frame rate, no time dropped by a capped advance, a snapshot that replays bit
// for bit, rate levels chosen from state at 1/60 s boundaries, and origin cells that move without touching state.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BASE_HZ,
  PhysicsWorld,
  RandomStream,
  couplingGraph,
  regionWords,
  solverNumber,
  stateHash,
} from '../dist/world.js';
import { FilmClock } from '../../math/dist/clock.js';

const field = (name, quantity = 'position', unit = 'm') => ({
  name,
  kind: 'scalarSeries',
  quantity,
  unit,
  centring: 'particle',
});

/**
 * A damped spring stepped by semi-implicit Euler at its own rate, with a little noise from its random stream: its state
 * depends on every step it takes. It publishes its position as `<id>-x` and can read another's, which it is pulled toward.
 */
function spring(id, rate, { reads, optional = false, log, stable = () => 0, x = 1 } = {}) {
  const fields = [{ field: field(`${id}-x`), access: 'write' }];
  if (reads) fields.push({ field: field(`${reads}-x`), access: 'read', optional });
  const s = {
    describe: () => ({ id, rate, fields, stableRate: () => stable(s) }),
    init(host) {
      s.host = host;
      s.state = host.allocate('state', 24, 'f64', 1); // x, v, steps
      s.port = host.allocate('x', 8, 'f64', 1);
      s.words()[0] = x;
    },
    words: () => regionWords(s.host.memory, s.state),
    get x() {
      return s.words()[0];
    },
    step(context, dt) {
      const random = new RandomStream(context.seed, solverNumber(id)),
        w = s.words(),
        port = reads ? context.inputs.get(`${reads}-x`) : undefined,
        target = port ? regionWords(s.host.memory, port.region)[0] : 0;
      s.saw = port !== undefined;
      w[1] += (-40 * (w[0] - target) - 0.5 * w[1]) * dt + (random.uniform(context.tick, 0) - 0.5) * 1e-3;
      w[0] += w[1] * dt;
      w[2]++;
      s.cell = context.cell;
      log?.push(`${id}@${context.tick}`);
    },
    exportPorts(tick) {
      regionWords(s.host.memory, s.port)[0] = s.words()[0];
      return [{ field: `${id}-x`, region: s.port, tick }];
    },
    importPorts() {},
    stateRegions: () => [s.state],
    extraState: () => [],
  };
  return s;
}

test("the world counts the film clock's base ticks, its own clock or one the scene shares", () => {
  // Its own clock at an NTSC rate: frame 1001 of 30000/1001 fps is 256,256 base ticks, exactly.
  const ntsc = new PhysicsWorld({ rate: { num: 30000, den: 1001 } });
  ntsc.advance(1001);
  assert.equal(ntsc.clock.ticks(BASE_HZ), Number((1001n * 1001n * 7680n) / 30000n));
  assert.equal(ntsc.tick, ntsc.clock.ticks(BASE_HZ) - (ntsc.clock.ticks(BASE_HZ) % 128), 'stepped to the last 1/60 s');
  // A shared clock: the scene seeks it and the world advances to wherever it stands.
  const clock = new FilmClock({ fps: 24 }),
    shared = new PhysicsWorld({ clock }).add(spring('a', 7), {});
  clock.frame = 24;
  shared.advance();
  assert.equal(shared.tick, BASE_HZ);
  shared.advance(30, { offset: { num: 1, den: 2 } });
  assert.deepEqual(
    [clock.frame, clock.offset],
    [30, { num: 1, den: 2 }],
    'advance with a frame seeks the shared clock',
  );
  assert.equal(shared.tick, (30.5 * BASE_HZ) / 24);
  assert.throws(() => new PhysicsWorld({ clock, rate: { num: 30, den: 1 } }), /pass one of them/);
  assert.throws(() => new PhysicsWorld({ clock: { fps: 24 } }), TypeError);
  assert.throws(() => shared.advance(-1), RangeError);
});

test('the same shot at 24, 30 and 60 frames a second is the same physics', () => {
  const hashAt = (fps) => {
    const world = new PhysicsWorld({ rate: { num: fps, den: 1 } })
      .add(spring('a', 2), {})
      .add(spring('b', 0, { reads: 'a' }), {});
    for (let f = 1; f <= 2 * fps; f++) world.advance(f);
    return world.hash();
  };
  assert.equal(hashAt(24), hashAt(30));
  assert.equal(hashAt(24), hashAt(60));
});

test('a capped advance drops nothing: settle reaches the uncapped state, and going back is refused', () => {
  const make = () => new PhysicsWorld().add(spring('a', 3), {}).add(spring('b', 1, { reads: 'a' }), {});
  const whole = make();
  whole.advance(48);
  const capped = make();
  capped.advance(48, { maxTicks: 1000 });
  assert.equal(capped.tick, 992); // the last step of level 3 (16 ticks) within 1,000
  assert.equal(capped.settled, false);
  capped.settle();
  assert.equal(capped.settled, true);
  assert.equal(capped.hash(), whole.hash());
  assert.throws(
    () => capped.advance(47),
    (e) => e.name === 'MargoError' && e.code === 'state',
  );
});

test('solvers step at their dyadic rates in coupling order, readers after writers', () => {
  const log = [];
  // 'slow' reads 'fast', so 'fast' runs first on the ticks they share, whatever the ids say.
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(spring('slow', 0, { reads: 'zfast', log }), {})
    .add(spring('zfast', 2, { log }), {});
  world.advance(1);
  assert.deepEqual(log, ['zfast@0', 'zfast@1', 'zfast@2', 'zfast@3', 'slow@0']);
  assert.equal(world.tick, 128);
});

test('the coupling graph groups two-way couplings and orders the groups by data, ties by id, in any add order', () => {
  const nodes = [
    { id: 'veg', writes: [], reads: ['wind'], accumulates: [] },
    { id: 'atmo', writes: ['wind'], reads: ['sea'], accumulates: [] },
    { id: 'sail', writes: [], reads: ['wind'], accumulates: ['hullPush'] },
    { id: 'hull', writes: ['hullPush', 'bodies'], reads: ['sea'], accumulates: [] },
    { id: 'ocean', writes: ['sea'], reads: ['bodies'], accumulates: [] },
  ];
  const graph = couplingGraph(nodes);
  // hull and ocean feed each other; the atmosphere reads the sea; sail and trees read the wind, and the sail pushes the hull,
  // which closes a loop through the hull: hull -> ocean -> atmo -> sail -> hull.
  assert.deepEqual(graph.groups, [['atmo', 'hull', 'ocean', 'sail'], ['veg']]);
  assert.deepEqual(couplingGraph([...nodes].reverse()).groups, graph.groups, 'the add order does not matter');
  assert.ok(graph.edges.some((e) => e.from === 'sail' && e.to === 'hull' && e.kind === 'accumulate'));
  assert.throws(
    () => couplingGraph([...nodes, { id: 'gust', writes: ['wind'], reads: [], accumulates: [] }]),
    /two writers|writes/,
  );
  assert.throws(() => couplingGraph([nodes[0]]), /writes/);
  assert.deepEqual(couplingGraph([nodes[0]], true).groups, [['veg']], 'a partial graph waits for the writer');
});

test('a snapshot replays bit for bit, the registry and levels with it', () => {
  const world = new PhysicsWorld()
    .add(spring('a', 1, { stable: (s) => (Math.abs(s.x) > 0.5 ? 3 : 1) }), {})
    .add(spring('b', 0, { reads: 'a' }), {});
  world.advance(10);
  const saved = world.takeSnapshot(),
    levelThen = world.levelOf('a');
  world.advance(40);
  const end = world.hash();
  assert.notEqual(world.levelOf('a'), levelThen, 'the stability limit moved the level');
  world.restoreSnapshot(saved.bytes);
  assert.equal(world.hash(), saved.hash);
  assert.equal(world.levelOf('a'), levelThen);
  // The world's counts come back; the clock is the scene's and stays where it was put (frame 40) until the next advance seeks it.
  const at10 = new FilmClock({ fps: 24, frame: 10 }).ticks(BASE_HZ);
  assert.equal(world.tick, at10 - (at10 % 16));
  assert.equal(world.clock.frame, 40);
  world.advance(40);
  assert.equal(world.hash(), end);
});

test('a level changes only where every level meets, from the state there', () => {
  const levels = [];
  const s = spring('a', 0, { stable: (st) => (st.host && st.words()[2] >= 3 ? 2 : 0) }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(s, {});
  for (let f = 1; f <= 5; f++) {
    world.advance(f);
    levels.push(world.levelOf('a'));
  }
  // Three steps at 60 Hz, then 240 Hz from the 1/60 s boundary after the third.
  assert.deepEqual(levels, [0, 0, 2, 2, 2]);
  assert.equal(s.words()[2], 3 + 4 * 2);
});

test('an impulse pair through an accumulated field conserves momentum exactly', () => {
  // Two unit masses: the sail pushes the hull by 1/8 N s a step and takes it from itself, at twice the hull's rate.
  const body = (id, rate, extra) => {
    const b = {
      describe: () => ({ id, rate, fields: extra.fields, stableRate: () => 0 }),
      init(host) {
        b.host = host;
        b.state = host.allocate('state', 16, 'f64', 1);
        b.port = host.allocate('push', 8, 'f64', 1);
      },
      v: () => regionWords(b.host.memory, b.state)[1],
      step(_context, dt) {
        const w = regionWords(b.host.memory, b.state);
        extra.step?.(b, w);
        w[0] += w[1] * dt;
      },
      exportPorts: (tick) => extra.exports?.(b, tick) ?? [],
      importPorts() {
        const sum = b.host.port('hullPush');
        if (sum) regionWords(b.host.memory, b.state)[1] += regionWords(b.host.memory, sum.region)[0];
      },
      stateRegions: () => [b.state],
      extraState: () => [],
    };
    return b;
  };
  const push = field('hullPush', 'impulse', 'N s'),
    hull = body('hull', 0, { fields: [{ field: push, access: 'write' }] }),
    sail = body('sail', 1, {
      fields: [{ field: push, access: 'accumulate' }],
      step(b, w) {
        w[1] -= 1 / 8;
        regionWords(b.host.memory, b.port)[0] = 1 / 8;
      },
      exports(b, tick) {
        const out = [{ field: 'hullPush', region: b.port, tick }];
        return out;
      },
    }),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(hull, {}).add(sail, {});
  for (let f = 1; f <= 30; f++) {
    world.advance(f);
    assert.equal(hull.v() + sail.v(), 0, `frame ${f}`);
  }
  assert.equal(hull.v(), 30 * 2 * (1 / 8));
});

test('origin cells move without touching simulated state', () => {
  const a = spring('a', 0),
    world = new PhysicsWorld({ cellSize: 4096 }).add(a, {}, [10, 0, -3]);
  world.advance(5);
  const before = world.hash(),
    state = stateHash(world.memory, [a]);
  assert.deepEqual(world.fields.port('a-x').cell, [10, 0, -3], "a port carries its solver's cell");
  assert.deepEqual(a.cell, [10, 0, -3], 'a step sees its cell');
  world.shiftOrigin([10, 0, -3]);
  assert.deepEqual(world.cellOf('a'), [0, 0, 0]);
  assert.equal(stateHash(world.memory, [a]), state, "the solver's state is untouched");
  world.shiftOrigin([-10, 0, 3]);
  assert.equal(world.hash(), before, 'there and back is the world it was');
  world.shiftOrigin([10, 0, -3]);
  world.advance(6);
  assert.deepEqual(
    [a.cell, world.fields.port('a-x').cell],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    'later steps and ports use the new cell',
  );
  assert.deepEqual(world.relocate([1.5, 2, 0.25], [10, 0, -3], [0, 0, 0]), [40961.5, 2, -12287.75]);
  assert.throws(() => world.setCell('a', [0.5, 0, 0]), RangeError);
});

test('a staggered reader sees both retained publications in the rebased origin immediately', () => {
  const position = field('position');
  let startCell, writerHost, readerHost, point, seen;
  const writer = {
    describe: () => ({
      id: 'writer',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: position, access: 'write' }],
    }),
    init(host) {
      writerHost = host;
      startCell = host.cell;
      point = host.allocate('point', 8, 'f64', 1);
    },
    step({ tick }) {
      regionWords(writerHost.memory, point)[0] = (tick + 1) * 0.75;
    },
    exportPorts: (tick) => [{ field: position.name, region: point, tick, cell: writerHost.cell }],
    importPorts() {},
    stateRegions: () => [point],
    extraState: () => [],
  };
  const reader = {
    describe: () => ({
      id: 'reader',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: position, access: 'read' }],
    }),
    init(host) {
      readerHost = host;
    },
    step({ cell, inputs }) {
      const port = inputs.get(position.name);
      const x = regionWords(readerHost.memory, port.region)[0];
      seen = world.relocate([x, 0, 0], port.cell, cell)[0];
    },
    importPorts() {},
    exportPorts: () => [],
    stateRegions: () => [],
    extraState: () => [],
  };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 4096 })
    .add(writer, {}, [1, 0, 0])
    .add(reader, {}, [1, 0, 0])
    .couple(['reader', 'writer'], 'staggered');
  assert.deepEqual(startCell, [1, 0, 0]);
  world.advance(2);
  const snapshot = world.takeSnapshot();
  const retained = () => {
    const { current, previous } = world.fields.field(position.name);
    return [current, previous].map(({ port: { tick, cell, region }, level }) => ({
      tick,
      level,
      cell,
      region,
      bytes: new Uint8Array(world.memory.buffer, region.byteOffset, region.byteLength).slice(),
    }));
  };
  const before = retained();
  assert.deepEqual(
    before.map(({ tick }) => tick),
    [1, 0],
  );
  const used = world.arena.used;
  world.advance(3);
  assert.equal(seen, 1.5);
  world.restoreSnapshot(snapshot.bytes);
  world.shiftOrigin([-1, 0, 0]);
  assert.equal(world.tick, 256);
  assert.equal(world.arena.used, used);
  assert.deepEqual(
    retained(),
    before.map((value) => ({ ...value, cell: [2, 0, 0] })),
  );
  assert.deepEqual(readerHost.port(position.name).cell, [2, 0, 0]);
  assert.deepEqual(readerHost.cell, [2, 0, 0]);
  assert.deepEqual(startCell, [1, 0, 0], 'caller-held cells remain snapshots');
  world.advance(3);
  assert.equal(seen, 1.5);
  const shifted = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  assert.deepEqual(readerHost.cell, [1, 0, 0]);
  world.shiftOrigin([-1, 0, 0]).advance(3);
  assert.equal(world.hash(), shifted);
});

test('an out-of-range retained publication refuses the whole origin shift', () => {
  const writer = spring('writer', 0);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(writer, {}, [2147483647, 0, 0]);
  world.setCell('writer', [0, 0, 0]).advance(1);
  assert.deepEqual(world.fields.field('writer-x').previous.port.cell, [2147483647, 0, 0]);
  const hash = world.hash();
  assert.throws(() => world.shiftOrigin([-1, 0, 0]), /pass \[i, j, k\]/);
  assert.equal(world.hash(), hash);
  assert.deepEqual(world.cellOf('writer'), [0, 0, 0]);
});

test('refusals: ids, a field nobody writes, a solver added mid-step', () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  world.add(spring('reader', 0, { reads: 'nobody' }), {});
  assert.throws(
    () => world.advance(1),
    (e) => e.code === 'state' && /No solver writes field "nobody-x"/.test(e.message),
  );
  world.remove('reader');
  world.add(spring('fast', 3), {});
  assert.throws(() => world.add(spring('fast', 0), {}), /already in the world/);
  assert.throws(() => world.add(spring('', 0), {}), /non-empty string/);
  // solver139599 and solver322382 share a 32-bit random-stream number (the FNV-1a of each is c9553142).
  world.add(spring('solver139599', 3), {});
  assert.throws(
    () => world.add(spring('solver322382', 3), {}),
    (e) => e.name === 'MargoError' && e.code === 'state' && /"solver139599" and "solver322382"/.test(e.message),
  );
  world.remove('solver139599');
  world.advance(1, { offset: { num: 1, den: 8 } });
  assert.equal(world.tick, 144);
  assert.throws(
    () => world.add(spring('slow', 0), {}),
    (e) => e.code === 'state',
  );
  assert.equal(world.ids.join(), 'fast', 'a refused add leaves no trace');
});

test('alpha is where a frame lies between steps of a level, exactly', () => {
  const world = new PhysicsWorld({ rate: { num: 24, den: 1 } });
  // Frame 1 at 24 fps is 320 base ticks: 2.5 steps of level 0 (128 ticks).
  world.clock.frame = 1;
  assert.equal(world.alpha(0), 0.5);
  assert.equal(world.alpha(7), 0);
  world.clock.at(0, { num: 1, den: 4 });
  assert.equal(world.alpha(0), 80 / 128);
});

test('an optional read runs without a writer, and takes the port once one comes', () => {
  // A field read optionally (FieldUse.optional) and written by nobody is no refusal: the reader steps with no port for it.
  // A writer added later is read as any other's.
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }),
    reader = spring('reader', 0, { reads: 'later', optional: true });
  world.add(reader, {});
  world.advance(2);
  assert.equal(reader.saw, false, 'no port while nobody writes it');
  const saved = world.takeSnapshot();
  world.add(spring('later', 0, { x: 3 }), {});
  world.advance(4);
  assert.equal(reader.saw, true, 'the port once its writer comes');
  // A snapshot from before the writer came, restored into a world of the reader alone, goes on to the same bits when the
  // writer joins at the same place.
  const again = new PhysicsWorld({ rate: { num: 60, den: 1 } }),
    second = spring('reader', 0, { reads: 'later', optional: true });
  again.add(second, {});
  again.restoreSnapshot(saved.bytes);
  assert.equal(second.saw, undefined, 'restored, not stepped');
  again.add(spring('later', 0, { x: 3 }), {});
  again.advance(4);
  assert.equal(second.saw, true);
  assert.equal(again.hash(), world.hash(), 'the same bits as the run that never stopped');
  // A read that is not optional is still refused.
  const strict = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(spring('strict', 0, { reads: 'none' }), {});
  assert.throws(
    () => strict.advance(1),
    (e) => e.code === 'state' && /No solver writes field "none-x"/.test(e.message),
  );
});
