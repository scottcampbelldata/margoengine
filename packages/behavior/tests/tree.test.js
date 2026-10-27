// Behaviour trees: every node type, async tasks and their AbortSignal, the blackboard, determinism, traces, and the
// JSON description (validation, round trips, fuzzed input that never crashes the validator).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BehaviorTree,
  Blackboard,
  MAX_TREE_DEPTH,
  action,
  blackboardKey,
  chooseBest,
  combineConsiderations,
  condition,
  cooldown,
  curves,
  formatTrace,
  guard,
  inverter,
  parallel,
  parseTree,
  randomSelector,
  reactiveSelector,
  reactiveSequence,
  repeater,
  selector,
  sequence,
  timeout,
  treeDocument,
  utility,
  validateTree,
  wait,
} from '../dist/index.js';

const ok = () => 'success';
const no = () => 'failure';
const busy = () => 'running';

test('sequence and selector run children in order and resume at the running child', () => {
  const calls = [];
  const log = (name, result) => () => (calls.push(name), result);
  const tree = new BehaviorTree(sequence(action('a'), action('b'), action('c')), {
    handlers: { actions: { a: log('a', 'success'), b: log('b', 'running'), c: log('c', 'success') } },
  });
  assert.equal(tree.tick(), 'running');
  assert.equal(tree.tick(), 'running');
  assert.deepEqual(calls, ['a', 'b', 'b'], 'memory sequence resumes at b');
  const pick = new BehaviorTree(selector(action('no'), action('ok'), action('never')), {
    handlers: { actions: { no, ok, never: () => assert.fail('selector stops at the first success') } },
  });
  assert.equal(pick.tick(), 'success');
  assert.equal(
    new BehaviorTree(selector(action('no'), action('no')), { handlers: { actions: { no } } }).tick(),
    'failure',
  );
  assert.equal(
    new BehaviorTree(sequence(action('ok'), action('no')), { handlers: { actions: { ok, no } } }).tick(),
    'failure',
  );
});

test('reactive selector halts a running lower-priority branch when a higher one succeeds, aborting its task', async () => {
  let enemy = false,
    signal = null;
  const tree = new BehaviorTree(reactiveSelector(sequence(condition('enemy'), action('attack')), action('patrol')), {
    handlers: {
      conditions: { enemy: () => enemy },
      actions: {
        attack: ok,
        patrol: (tick) => {
          signal = tick.signal;
          return new Promise(() => {});
        },
      },
    },
  });
  assert.equal(tree.tick(), 'running');
  assert.equal(signal.aborted, false);
  enemy = true;
  assert.equal(tree.tick(), 'success');
  assert.equal(signal.aborted, true, 'the patrol task saw its signal abort');
  assert.equal(signal.reason.code, 'state');
});

test('reactive sequence re-checks its conditions and halts the running action when one fails', () => {
  let safe = true,
    halted = 0;
  const tree = new BehaviorTree(reactiveSequence(condition('safe'), action('work')), {
    handlers: {
      conditions: { safe: () => safe },
      actions: {
        work: (tick) => {
          tick.signal.addEventListener('abort', () => halted++, { once: true });
          return 'running';
        },
      },
    },
  });
  assert.equal(tree.tick(), 'running');
  safe = false;
  assert.equal(tree.tick(), 'failure');
  assert.equal(halted, 1);
});

test('parallel policies: all, any and counts, halting the children still running', () => {
  const run = (spec, actions) => new BehaviorTree(spec, { handlers: { actions } }).tick();
  assert.equal(run(parallel([action('ok'), action('ok')]), { ok }), 'success');
  assert.equal(run(parallel([action('ok'), action('busy')]), { ok, busy }), 'running');
  assert.equal(run(parallel([action('no'), action('busy')]), { no, busy }), 'failure', "default failure 'any'");
  assert.equal(run(parallel([action('ok'), action('busy')], { success: 'any' }), { ok, busy }), 'success');
  assert.equal(
    run(parallel([action('no'), action('ok'), action('ok')], { success: 2, failure: 'all' }), { ok, no }),
    'success',
  );
  assert.equal(
    run(parallel([action('no'), action('ok')], { success: 'all', failure: 'all' }), { ok, no }),
    'failure',
    'mixed and finished',
  );
  let aborted = false;
  const tree = new BehaviorTree(parallel([action('ok'), action('task')], { success: 'any' }), {
    handlers: {
      actions: {
        ok: () => 'running',
        task: (tick) => {
          tick.signal.addEventListener('abort', () => (aborted = true));
          return new Promise(() => {});
        },
      },
    },
  });
  tree.tick();
  tree.halt();
  assert.equal(aborted, true, 'halt aborts running tasks inside a parallel');
});

test('decorators: inverter, repeater count and until, cooldown in tree time, guard, timeout', () => {
  assert.equal(new BehaviorTree(inverter(action('ok')), { handlers: { actions: { ok } } }).tick(), 'failure');
  assert.equal(new BehaviorTree(inverter(action('busy')), { handlers: { actions: { busy } } }).tick(), 'running');
  let runs = 0;
  const rep = new BehaviorTree(repeater(action('count'), { count: 3 }), {
    handlers: { actions: { count: () => (runs++, 'success') } },
  });
  assert.deepEqual([rep.tick(), rep.tick(), rep.tick()], ['running', 'running', 'success']);
  assert.equal(runs, 3);
  let n = 0;
  const until = new BehaviorTree(repeater(action('flaky'), { until: 'failure' }), {
    handlers: { actions: { flaky: () => (++n < 3 ? 'success' : 'failure') } },
  });
  assert.deepEqual([until.tick(), until.tick(), until.tick()], ['running', 'running', 'success']);

  let fired = 0;
  const cool = new BehaviorTree(cooldown(1, action('fire')), {
    handlers: { actions: { fire: () => (fired++, 'success') } },
  });
  assert.equal(cool.tick(0.1), 'success');
  assert.equal(cool.tick(0.5), 'failure', 'cooling down');
  assert.equal(cool.tick(0.5), 'success', 'ready again after 1 s of tree time');
  assert.equal(fired, 2);

  let open = true;
  const guarded = new BehaviorTree(guard('open', action('busy')), {
    handlers: { conditions: { open: () => open }, actions: { busy } },
  });
  assert.equal(guarded.tick(), 'running');
  open = false;
  assert.equal(guarded.tick(), 'failure');

  let signal;
  const slow = new BehaviorTree(timeout(0.5, action('slow')), {
    handlers: { actions: { slow: (tick) => ((signal = tick.signal), 'running') } },
  });
  assert.equal(slow.tick(0.2), 'running', 'started: durations count from the tick a node starts on');
  assert.equal(slow.tick(0.2), 'running');
  assert.equal(slow.tick(0.2), 'running');
  assert.equal(slow.tick(0.2), 'failure', 'timed out after 0.6 s >= 0.5 s');
  assert.equal(signal.aborted, true);
});

test('wait leaves run for their seconds of tree time', () => {
  const tree = new BehaviorTree(sequence(wait(1), action('ok')), { handlers: { actions: { ok } } });
  assert.equal(tree.tick(0.6), 'running', 'started');
  assert.equal(tree.tick(0.6), 'running', '0.6 s waited');
  assert.equal(tree.tick(0.6), 'success', '1.2 s waited');
  assert.equal(new BehaviorTree(wait(0), { handlers: {} }).tick(0), 'success');
});

test('async actions resolve on a later tick, map their results, and a rejection surfaces with its cause', async () => {
  let resolve;
  const tree = new BehaviorTree(action('load'), {
    handlers: { actions: { load: () => new Promise((r) => (resolve = r)) } },
  });
  assert.equal(tree.tick(), 'running');
  assert.equal(tree.tick(), 'running');
  resolve(false);
  await Promise.resolve();
  assert.equal(tree.tick(), 'failure');
  const broken = new Error('network down');
  const failing = new BehaviorTree(action('load'), { handlers: { actions: { load: () => Promise.reject(broken) } } });
  failing.tick();
  await Promise.resolve();
  assert.throws(
    () => failing.tick(),
    (error) => error.name === 'MargoError' && error.code === 'failed' && error.cause === broken,
  );
  const bad = new BehaviorTree(action('bad'), { handlers: { actions: { bad: () => 42 } } });
  assert.throws(() => bad.tick(), TypeError);
});

test('a halted async task that settles later is ignored, and dispose aborts and blocks further ticks', async () => {
  let resolve, signal;
  const tree = new BehaviorTree(action('task'), {
    handlers: { actions: { task: (tick) => ((signal = tick.signal), new Promise((r) => (resolve = r))) } },
  });
  tree.tick();
  tree.halt();
  assert.equal(signal.aborted, true);
  resolve('success');
  await Promise.resolve();
  assert.equal(tree.tick(), 'running', 'a fresh run started; the stale result was dropped');
  {
    using scoped = tree;
    assert.ok(scoped);
  }
  assert.throws(
    () => tree.tick(),
    (error) => error.code === 'disposed',
  );
});

test('utility selector picks the best score, honours inertia and threshold, and halts the option it leaves', () => {
  let hunger = 0.2,
    fear = 0.5,
    eatHalted = false;
  const tree = new BehaviorTree(
    utility(
      [
        { score: 'hunger', child: action('eat') },
        { score: 'fear', child: action('flee') },
      ],
      { inertia: 0.1 },
    ),
    {
      handlers: {
        scores: { hunger: () => hunger, fear: () => fear },
        actions: {
          eat: (tick) => (tick.signal.addEventListener('abort', () => (eatHalted = true)), 'running'),
          flee: () => 'running',
        },
      },
      trace: true,
    },
  );
  tree.tick();
  assert.equal(tree.trace[1].name, 'flee');
  assert.deepEqual(tree.trace[0].scores, [0.2, 0.5]);
  hunger = 0.55; // within flee's inertia: stays
  tree.tick();
  assert.equal(tree.trace[1].name, 'flee');
  hunger = 0.9;
  fear = 0;
  tree.tick();
  assert.equal(tree.trace[1].name, 'eat');
  hunger = 0.5;
  fear = 0.95;
  tree.tick();
  assert.equal(tree.trace[1].name, 'flee');
  assert.equal(eatHalted, true);
  hunger = 0;
  fear = 0;
  assert.equal(tree.tick(), 'failure', 'nothing above the threshold');
  const nan = new BehaviorTree(utility([{ score: 's', child: action('ok') }]), {
    handlers: { scores: { s: () => NaN }, actions: { ok } },
  });
  assert.throws(() => nan.tick(), RangeError);
});

test('typed blackboard keys, fallbacks, version and JSON round trip', () => {
  const target = blackboardKey('target', null),
    ammo = blackboardKey('ammo', 0);
  const board = new Blackboard();
  assert.equal(board.get(ammo), 0);
  assert.equal(board.has(ammo), false);
  board.set(ammo, 3).set(target, [1, 2, 3]);
  assert.equal(board.version, 2);
  board.set(ammo, 3);
  assert.equal(board.version, 2, 'writing the same value is not a change');
  const copy = new Blackboard(JSON.parse(JSON.stringify(board)));
  assert.deepEqual(copy.get(target), [1, 2, 3]);
  assert.equal(copy.get(ammo), 3);
  assert.equal(board.delete(ammo), true);
  assert.equal(board.get(ammo), 0);
  board.clear();
  assert.equal(board.has(target), false);
  assert.throws(() => blackboardKey('', 0), TypeError);
  const tree = new BehaviorTree(sequence(action('reload'), condition('loaded')), {
    blackboard: board,
    handlers: {
      actions: { reload: (tick) => void tick.blackboard.set(ammo, 6) },
      conditions: { loaded: (tick) => tick.blackboard.get(ammo) > 0 },
    },
  });
  assert.equal(tree.tick(), 'success');
});

test('trace lists every ticked node depth first, and formatTrace draws it', () => {
  const tree = new BehaviorTree(
    selector({ ...sequence(condition('enemy'), action('attack')), label: 'combat' }, action('patrol')),
    {
      handlers: { conditions: { enemy: () => false }, actions: { attack: ok, patrol: busy } },
      trace: true,
    },
  );
  tree.tick();
  assert.deepEqual(
    tree.trace.map((entry) => [entry.path, entry.depth, entry.name, entry.status]),
    [
      ['root', 0, 'selector', 'running'],
      ['root.children[0]', 1, 'combat', 'failure'],
      ['root.children[0].children[0]', 2, 'enemy', 'failure'],
      ['root.children[1]', 1, 'patrol', 'running'],
    ],
  );
  assert.equal(
    formatTrace(tree.trace),
    '[R] selector\n  [F] sequence combat\n    [F] condition enemy\n  [R] action patrol',
  );
  const quiet = new BehaviorTree(action('ok'), { handlers: { actions: { ok } } });
  quiet.tick();
  assert.deepEqual(quiet.trace, []);
});

test('argument and state errors name their fix', () => {
  assert.throws(() => new BehaviorTree(action('x'), {}), TypeError);
  assert.throws(
    () => new BehaviorTree(action('x'), { handlers: {} }),
    /unknown action 'x'; register it in handlers.actions/,
  );
  assert.throws(
    () => new BehaviorTree(action('toString'), { handlers: { actions: {} } }),
    TypeError,
    'prototype names are not handlers',
  );
  assert.throws(() => new BehaviorTree(wait(1), { handlers: {}, seed: 0.5 }), RangeError);
  const tree = new BehaviorTree(action('again'), {
    handlers: { actions: { again: () => (tree.tick(), 'success') } },
  });
  assert.throws(
    () => tree.tick(),
    (error) => error.code === 'state',
  );
  const plain = new BehaviorTree(wait(1), { handlers: {} });
  assert.throws(() => plain.tick(-1), RangeError);
  assert.throws(() => plain.tick(Number.NaN), RangeError);
});

// A small seeded generator for the property and fuzz tests (not the package's stream, so the tests are independent).
function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const ACTIONS = ['a', 'b', 'c', 'd'];
const CONDITIONS = ['p', 'q'];
const SCORES = ['s', 't'];
function randomTree(random, depth = 0) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const kids = () => Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomTree(random, depth + 1));
  const leaf = depth > 3 || random() < 0.35;
  if (leaf) {
    const k = random();
    return k < 0.5
      ? action(pick(ACTIONS))
      : k < 0.8
        ? condition(pick(CONDITIONS))
        : wait(Math.floor(random() * 3) / 10);
  }
  const k = Math.floor(random() * 11);
  switch (k) {
    case 0:
      return sequence(...kids());
    case 1:
      return reactiveSelector(...kids());
    case 2: {
      const children = kids();
      return randomSelector(
        children,
        children.map(() => random()),
      );
    }
    case 3: {
      const children = kids();
      return parallel(children, { success: random() < 0.5 ? 'any' : 'all', failure: random() < 0.5 ? 'all' : 1 });
    }
    case 4:
      return utility(
        kids().map((child) => ({ score: pick(SCORES), child })),
        { inertia: 0.05 },
      );
    case 5:
      return inverter(randomTree(random, depth + 1));
    case 6:
      return repeater(randomTree(random, depth + 1), { count: 1 + Math.floor(random() * 3) });
    case 7:
      return cooldown(0.1, randomTree(random, depth + 1));
    case 8:
      return guard(pick(CONDITIONS), randomTree(random, depth + 1));
    case 9:
      return timeout(0.2, randomTree(random, depth + 1));
    default:
      return reactiveSequence(...kids());
  }
}
/** Handlers whose results depend only on the tick count, the tree's random stream and the blackboard. */
function handlers() {
  const counter = blackboardKey('n', 0);
  const actions = Object.fromEntries(
    ACTIONS.map((name, i) => [
      name,
      (tick) => {
        const n = tick.blackboard.get(counter) + 1;
        tick.blackboard.set(counter, n);
        const r = tick.random();
        return r < 0.3 ? 'running' : (n + i) % 3 === 0 ? 'failure' : 'success';
      },
    ]),
  );
  const conditions = Object.fromEntries(
    CONDITIONS.map((name, i) => [name, (tick) => (tick.blackboard.get(counter) + i) % 2 === 0]),
  );
  const scores = Object.fromEntries(
    SCORES.map((name, i) => [name, (tick) => ((tick.blackboard.get(counter) * (i + 3)) % 7) / 7]),
  );
  return { actions, conditions, scores };
}
const run = (description, seed, ticks = 40) => {
  const tree = new BehaviorTree(description, { handlers: handlers(), seed, trace: true });
  const out = [];
  for (let i = 0; i < ticks; i++) {
    tree.tick(0.05);
    out.push(formatTrace(tree.trace));
  }
  return { out, board: tree.blackboard.toJSON() };
};

test('property: the same description, seed and deltas give the same traces, and a JSON round trip changes nothing', () => {
  const random = lcg(7);
  for (let i = 0; i < 150; i++) {
    const description = treeDocument(randomTree(random));
    assert.deepEqual(validateTree(description, handlers()), [], 'generated trees are valid');
    const seed = Math.floor(random() * 1000);
    const first = run(description, seed);
    assert.deepEqual(run(description, seed), first, `tree ${i} is deterministic`);
    assert.deepEqual(run(parseTree(JSON.stringify(description), handlers()), seed), first, `tree ${i} survives JSON`);
  }
});

test('random selectors follow the seed and their weights', () => {
  const tally = (seed) => {
    const firsts = [];
    const tree = new BehaviorTree(randomSelector([action('a'), action('b')], [3, 1]), {
      handlers: { actions: { a: () => (firsts.push('a'), 'success'), b: () => (firsts.push('b'), 'success') } },
      seed,
    });
    for (let i = 0; i < 400; i++) tree.tick();
    return firsts;
  };
  assert.deepEqual(tally(5), tally(5));
  assert.notDeepEqual(tally(5), tally(6));
  const share = tally(5).filter((x) => x === 'a').length / 400;
  assert.ok(share > 0.65 && share < 0.85, `weight 3:1 gives about 75% first picks, got ${share}`);
  const zero = new BehaviorTree(randomSelector([action('a'), action('b')], [0, 1]), {
    handlers: { actions: { a: no, b: ok } },
  });
  for (let i = 0; i < 20; i++) assert.equal(zero.tick(), 'success');
});

test('validateTree reports every problem with its path and fix', () => {
  const issues = validateTree(
    {
      format: 'margo-behavior',
      version: 2,
      root: {
        type: 'sequence',
        children: [
          { type: 'wait', seconds: -1 },
          { type: 'action' },
          { type: 'teleport' },
          { type: 'parallel', children: [{ type: 'action', name: 'a' }], success: 3 },
          { type: 'repeater', child: { type: 'action', name: 'a' }, count: 0, extra: 1 },
          { type: 'guard', condition: 'missing', child: { type: 'action', name: 'a' } },
        ],
      },
    },
    { actions: ['a'], conditions: {} },
  );
  assert.deepEqual(
    issues.map((issue) => issue.path),
    [
      'version',
      'root.children[0].seconds',
      'root.children[1].name',
      'root.children[2].type',
      'root.children[3].success',
      'root.children[4].extra',
      'root.children[4].count',
      'root.children[5].condition',
    ],
  );
  assert.match(issues[3].message, /use one of sequence, selector/);
  assert.throws(() => parseTree('{"type": "wait"'), /not valid JSON/);
  assert.throws(() => parseTree({ type: 'wait' }), /root.seconds: must be a finite number/);
  let deep = { type: 'action', name: 'a' };
  for (let i = 0; i < MAX_TREE_DEPTH + 5; i++) deep = { type: 'inverter', child: deep };
  assert.match(validateTree(deep)[0].message, /nested deeper than/);
});

test('fuzz: mutated and random JSON never crashes validateTree, and parseTree only throws TypeError', () => {
  const random = lcg(99);
  const junk = [null, undefined, 0, -1, 1.5, NaN, '', 'x', true, [], {}, [1], { type: 'action' }, { type: null }];
  const mutate = (value, depth = 0) => {
    if (value === null || typeof value !== 'object' || depth > 8)
      return random() < 0.5 ? junk[Math.floor(random() * junk.length)] : value;
    const copy = Array.isArray(value) ? [...value] : { ...value };
    const keys = Object.keys(copy);
    if (keys.length && random() < 0.6) {
      const key = keys[Math.floor(random() * keys.length)];
      copy[key] = random() < 0.3 ? junk[Math.floor(random() * junk.length)] : mutate(copy[key], depth + 1);
    }
    if (!Array.isArray(copy) && random() < 0.1)
      copy[['type', 'child', 'children', 'seconds', 'weights'][Math.floor(random() * 5)]] =
        junk[Math.floor(random() * junk.length)];
    return copy;
  };
  for (let i = 0; i < 2000; i++) {
    const input = mutate(treeDocument(randomTree(random)));
    const issues = validateTree(input, handlers());
    assert.ok(Array.isArray(issues));
    try {
      const document = parseTree(input, handlers());
      // Anything that parses must also build and tick without a crash.
      const tree = new BehaviorTree(document, { handlers: handlers() });
      for (let t = 0; t < 5; t++) tree.tick(0.05);
    } catch (error) {
      assert.ok(error instanceof TypeError, `only TypeError escapes, got ${error}`);
    }
  }
  for (let i = 0; i < 500; i++) {
    const text = Array.from({ length: Math.floor(random() * 40) }, () =>
      String.fromCharCode(32 + Math.floor(random() * 95)),
    ).join('');
    assert.ok(Array.isArray(validateTree(text)));
    assert.throws(() => parseTree(text), TypeError);
  }
});

test('utility helpers: response curves stay in [0, 1], considerations compensate, chooseBest picks the top score', () => {
  for (const curve of [
    curves.linear(),
    curves.power(2),
    curves.logistic(),
    curves.step(),
    curves.inverse(),
    curves.linear(-2, 1.5),
  ])
    for (const x of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
      const y = curve(x);
      assert.ok(y >= 0 && y <= 1, `${y} in [0, 1]`);
    }
  assert.equal(curves.power(2)(0.5), 0.25);
  assert.equal(curves.step(0.5)(0.49), 0);
  assert.equal(combineConsiderations([]), 1);
  assert.equal(combineConsiderations([0.9, 0]), 0);
  assert.ok(combineConsiderations([0.5, 0.5, 0.5]) > 0.5 ** 3, 'compensated product is above the raw product');
  assert.equal(combineConsiderations([0.5]), 0.5, 'one consideration is unchanged');
  assert.throws(() => combineConsiderations([1.2]), RangeError);
  assert.equal(
    chooseBest([
      { value: 'a', score: 0.2 },
      { value: 'b', score: 0.7 },
      { value: 'c', score: 0.7 },
    ]),
    'b',
  );
  assert.equal(chooseBest([{ value: 'a', score: 0 }]), undefined);
  assert.throws(() => chooseBest([{ value: 'a', score: Infinity }]), RangeError);
  assert.throws(() => curves.power(0), RangeError);
});
