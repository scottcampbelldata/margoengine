// Task network planner: the chapter's troll domain step by step, backtracking against a plain recursive decomposition on
// random domains, expected effects, the method traversal record, and when the agent plans again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom } from '@margoengine/math/mathutils';
import { HtnAgent, compareRecords, planTasks } from '../dist/htn.js';

const names = (plan) => plan.tasks.map((task) => task.name);

const troll = [
  {
    name: 'BeTrunkThumper',
    methods: [
      { when: { CanSeeEnemy: true }, subtasks: ['AttackEnemy'] },
      { subtasks: ['ChooseBridge', 'NavigateToBridge', 'CheckBridge'] },
    ],
  },
  {
    name: 'AttackEnemy',
    methods: [
      { when: (state) => state.TrunkHealth > 0, subtasks: ['NavigateToEnemy', 'DoTrunkSlam'] },
      { subtasks: ['FindTrunk', 'NavigateToTrunk', 'UprootTrunk', 'AttackEnemy'] },
    ],
  },
  { name: 'NavigateToEnemy', effects: { Location: 'enemy' } },
  {
    name: 'DoTrunkSlam',
    effects: (state) => {
      state.TrunkHealth -= 1;
    },
  },
  { name: 'FindTrunk' },
  { name: 'NavigateToTrunk', effects: { Location: 'trunk' } },
  { name: 'UprootTrunk', effects: { TrunkHealth: 3 } },
  { name: 'ChooseBridge' },
  { name: 'NavigateToBridge', effects: { Location: 'bridge' } },
  { name: 'CheckBridge' },
];

test('the first valid method wins, in order', () => {
  assert.deepEqual(names(planTasks(troll, 'BeTrunkThumper', { CanSeeEnemy: false })), [
    'ChooseBridge',
    'NavigateToBridge',
    'CheckBridge',
  ]);
  const plan = planTasks(troll, 'BeTrunkThumper', { CanSeeEnemy: true, TrunkHealth: 2 });
  assert.deepEqual(names(plan), ['NavigateToEnemy', 'DoTrunkSlam']);
  assert.deepEqual(plan.record, [0, 0]);
});

test('recursion: a broken trunk plans the fetch and then the attack, as the chapter lists it', () => {
  const plan = planTasks(troll, 'BeTrunkThumper', { CanSeeEnemy: true, TrunkHealth: 0 });
  assert.deepEqual(names(plan), ['FindTrunk', 'NavigateToTrunk', 'UprootTrunk', 'NavigateToEnemy', 'DoTrunkSlam']);
  assert.deepEqual(plan.record, [0, 1, 0]);
});

test('planning leaves the given state alone', () => {
  const state = { CanSeeEnemy: true, TrunkHealth: 2 };
  planTasks(troll, 'BeTrunkThumper', state);
  assert.deepEqual(state, { CanSeeEnemy: true, TrunkHealth: 2 });
});

test('a failed primitive goes back to the last decomposition, undoing the state and the plan so far', () => {
  const tasks = [
    {
      name: 'Root',
      methods: [{ subtasks: ['Loud', 'Fail'] }, { subtasks: ['Quiet'] }],
    },
    { name: 'Loud', effects: { Noise: true } },
    { name: 'Fail', preconditions: { Never: true } },
    { name: 'Quiet', preconditions: (state) => state.Noise !== true },
  ];
  const plan = planTasks(tasks, 'Root', {});
  assert.deepEqual(names(plan), ['Quiet']);
  assert.deepEqual(plan.record, [1]);
});

test('backtracking reaches a choice made earlier than the task that failed', () => {
  // Pick is decided before Use fails; only the second pick lets Use pass.
  const tasks = [
    { name: 'Root', methods: [{ subtasks: ['Pick', 'Use'] }] },
    { name: 'Pick', methods: [{ subtasks: ['Red'] }, { subtasks: ['Blue'] }] },
    { name: 'Red', effects: { Key: 'red' } },
    { name: 'Blue', effects: { Key: 'blue' } },
    { name: 'Use', preconditions: { Key: 'blue' } },
  ];
  const plan = planTasks(tasks, 'Root', {});
  assert.deepEqual(names(plan), ['Blue', 'Use']);
  assert.deepEqual(plan.record, [0, 1]);
});

test('no method and no way back gives null, and an empty method is a plan of nothing', () => {
  const tasks = [
    { name: 'Root', methods: [{ when: { A: true }, subtasks: ['Go'] }] },
    { name: 'Go' },
    { name: 'Nothing', methods: [{ subtasks: [] }] },
  ];
  assert.equal(planTasks(tasks, 'Root', {}), null);
  assert.deepEqual(names(planTasks(tasks, 'Nothing', {})), []);
  assert.deepEqual(names(planTasks(tasks, 'Go', {})), ['Go'], 'a primitive can be the root');
});

test('an unset symbol matches nothing, false included', () => {
  const tasks = [{ name: 'Go', preconditions: { Blocked: false } }];
  assert.equal(planTasks(tasks, 'Go', {}), null);
  assert.deepEqual(names(planTasks(tasks, 'Go', { Blocked: false })), ['Go']);
});

test('maxSteps ends a recursion that never finishes', () => {
  const tasks = [{ name: 'Loop', methods: [{ subtasks: ['Step', 'Loop'] }] }, { name: 'Step' }];
  assert.equal(planTasks(tasks, 'Loop', {}, { maxSteps: 500 }), null);
});

// The reference: plain recursion over every method, first success in order. Returns [names, state] or null.
const reference = (domain, list, state, plan, budget) => {
  if (list.length === 0) return plan;
  if (--budget.left < 0) throw new Error('reference ran out');
  const [head, ...rest] = list;
  const task = domain.get(head);
  if (task.methods) {
    for (const method of task.methods) {
      if (!Object.entries(method.when ?? {}).every(([k, v]) => state[k] === v)) continue;
      const found = reference(domain, [...method.subtasks, ...rest], state, plan, budget);
      if (found) return found;
    }
    return null;
  }
  if (!Object.entries(task.preconditions ?? {}).every(([k, v]) => state[k] === v)) return null;
  return reference(domain, rest, { ...state, ...task.effects }, [...plan, head], budget);
};

test('property: on 500 random domains the plan is the one plain recursive decomposition finds first', () => {
  const random = createRandom(6);
  const pick = (n) => Math.floor(random() * n);
  const symbols = ['a', 'b', 'c', 'd'];
  const some = (max) => {
    const out = {};
    for (let i = 0, n = pick(max + 1); i < n; i++) out[symbols[pick(symbols.length)]] = pick(2);
    return out;
  };
  let found = 0;
  let failed = 0;
  let backtracked = 0;
  for (let round = 0; round < 500; round++) {
    const primitives = Array.from({ length: 5 }, (_, i) => ({
      name: `p${i}`,
      preconditions: some(2),
      effects: some(2),
    }));
    // Compound task i names only later tasks, so nothing recurses and the reference ends.
    const compounds = Array.from({ length: 5 }, (_, i) => ({
      name: `c${i}`,
      methods: Array.from({ length: 1 + pick(3) }, () => ({
        when: some(1),
        subtasks: Array.from({ length: pick(4) }, () => {
          const later = 4 - i;
          const at = pick(later + 5);
          return at < later ? `c${i + 1 + at}` : `p${at - later}`;
        }),
      })),
    }));
    const tasks = [...compounds, ...primitives];
    const state = Object.fromEntries(symbols.map((symbol) => [symbol, pick(2)]));
    const expected = reference(new Map(tasks.map((task) => [task.name, task])), ['c0'], state, [], { left: 1e7 });
    const plan = planTasks(tasks, 'c0', state, { maxSteps: 1e7 });
    if (expected === null) {
      assert.equal(plan, null, `round ${round}`);
      failed++;
      continue;
    }
    assert.deepEqual(names(plan), expected, `round ${round}`);
    found++;
    if (plan.record.some((index) => index > 0)) backtracked++;
  }
  assert.ok(
    found > 50 && failed > 50 && backtracked > 20,
    `${found} found, ${failed} failed, ${backtracked} past a first method`,
  );
});

test('expected effects let a plan reach past what only a sensor can make true, and never touch the world', () => {
  const chase = (expected) => [
    { name: 'Root', methods: [{ when: { Seen: true }, subtasks: ['GoToLastSeen', 'Roar'] }] },
    { name: 'GoToLastSeen', effects: { At: 'last' }, ...(expected ? { expected: { CanSee: true } } : {}) },
    { name: 'Roar', preconditions: { CanSee: true } },
  ];
  assert.equal(planTasks(chase(false), 'Root', { Seen: true, CanSee: false }), null);
  assert.deepEqual(names(planTasks(chase(true), 'Root', { Seen: true, CanSee: false })), ['GoToLastSeen', 'Roar']);

  const agent = new HtnAgent(chase(true), 'Root', { state: { Seen: true, CanSee: false } });
  agent.update();
  assert.equal(agent.state.At, 'last');
  assert.equal(agent.state.CanSee, false, 'the expected effect stayed out of the world');
  agent.update();
  assert.equal(agent.plan.length, 0, 'no sensor said so, so the check drops the roar and the plan fails');
  assert.equal(agent.current, null);
});

test('compareRecords: the first different index decides, as in the chapter figure', () => {
  assert.ok(compareRecords([0, 0], [0, 1]) < 0);
  assert.ok(compareRecords([0, 1], [1]) < 0);
  assert.ok(compareRecords([1], [0, 0]) > 0);
  assert.equal(compareRecords([0, 1], [0, 1]), 0);
});

test('an agent runs its plan in order, writes effects, and plans again when done', () => {
  const agent = new HtnAgent(troll, 'BeTrunkThumper', { state: { CanSeeEnemy: true, TrunkHealth: 1 } });
  assert.equal(agent.update().name, 'NavigateToEnemy');
  assert.equal(agent.state.Location, 'enemy');
  assert.equal(agent.update().name, 'DoTrunkSlam');
  assert.equal(agent.state.TrunkHealth, 0);
  assert.equal(agent.plans, 1);
  assert.equal(agent.update().name, 'FindTrunk');
  assert.equal(agent.plans, 2);
});

test('the recovery roar is not cut short: a sensor change finds only a lower priority plan', () => {
  let stopped = 0;
  const tasks = [
    {
      name: 'AttackEnemy',
      methods: [
        { when: { AttackedRecently: false }, subtasks: ['DoTrunkSlam', 'RecoveryRoar'] },
        { subtasks: ['ThrowBoulder'] },
      ],
    },
    { name: 'DoTrunkSlam', effects: { AttackedRecently: true } },
    { name: 'RecoveryRoar', run: () => 'running', stop: () => stopped++ },
    { name: 'ThrowBoulder' },
  ];
  const agent = new HtnAgent(tasks, 'AttackEnemy', { state: { AttackedRecently: false } });
  agent.update();
  assert.equal(agent.update().name, 'RecoveryRoar');
  agent.state.EnemyMoved = true; // a sensor
  assert.equal(agent.update().name, 'RecoveryRoar');
  assert.equal(agent.plans, 2, 'it did look');
  assert.equal(stopped, 0);
});

test('a higher priority plan does replace the running one, and stops its task', () => {
  let stopped = 0;
  const tasks = [
    {
      name: 'Root',
      methods: [{ when: { Danger: true }, subtasks: ['Flee'] }, { subtasks: ['Patrol'] }],
    },
    { name: 'Flee', run: () => 'running' },
    { name: 'Patrol', run: () => 'running', stop: () => stopped++ },
  ];
  const agent = new HtnAgent(tasks, 'Root');
  assert.equal(agent.update().name, 'Patrol');
  agent.state.Danger = true;
  assert.equal(agent.update().name, 'Flee');
  assert.equal(stopped, 1);
});

test('a task that succeeds does not trigger a plan: the third slam still gets its recovery', () => {
  const tasks = [
    {
      name: 'Attack',
      methods: [{ when: { PowerUp: 3 }, subtasks: ['Whirlwind', 'Recover'] }, { subtasks: ['Slam', 'Recover'] }],
    },
    { name: 'Whirlwind', effects: { PowerUp: 0 } },
    {
      name: 'Slam',
      effects: (state) => {
        state.PowerUp += 1;
      },
    },
    { name: 'Recover' },
  ];
  const agent = new HtnAgent(tasks, 'Attack', { state: { PowerUp: 2 } });
  assert.equal(agent.update().name, 'Slam');
  assert.equal(agent.state.PowerUp, 3);
  assert.equal(agent.update().name, 'Recover', 'the whirlwind waits');
  assert.equal(agent.update().name, 'Whirlwind');
});

test('a sensor change that breaks a later task fails the plan at once, before that task is reached', () => {
  let stopped = 0;
  const tasks = [
    { name: 'Root', methods: [{ subtasks: ['Walk', 'Open'] }] },
    { name: 'Walk', run: () => 'running', stop: () => stopped++ },
    { name: 'Open', preconditions: { HasKey: true } },
  ];
  const agent = new HtnAgent(tasks, 'Root', { state: { HasKey: true } });
  agent.update();
  agent.state.HasKey = false;
  assert.equal(agent.update(), null);
  assert.equal(stopped, 1);
  assert.equal(agent.current, null);
});

test('a later task may rely on the effect of an earlier one when the plan is checked', () => {
  const tasks = [
    { name: 'Root', methods: [{ subtasks: ['Walk', 'Grab', 'Open'] }] },
    { name: 'Walk', run: () => 'running' },
    { name: 'Grab', effects: { HasKey: true } },
    { name: 'Open', preconditions: { HasKey: true } },
  ];
  const agent = new HtnAgent(tasks, 'Root');
  agent.update();
  agent.state.Noise = 1;
  assert.equal(agent.update().name, 'Walk');
  assert.equal(agent.plan.length, 3);
});

test('a running task can change what its own preconditions read without failing the plan', () => {
  const tasks = [
    { name: 'Root', methods: [{ subtasks: ['Burn'] }] },
    {
      name: 'Burn',
      preconditions: (state) => state.Fuel > 5,
      run: (state) => {
        state.Fuel -= 1;
        return state.Fuel > 0 ? 'running' : 'success';
      },
    },
  ];
  const agent = new HtnAgent(tasks, 'Root', { state: { Fuel: 6 } });
  for (let i = 0; i < 3; i++) agent.update();
  agent.state.Wind = 1;
  assert.equal(agent.update().name, 'Burn');
  assert.equal(agent.state.Fuel, 2);
});

test('a task that fails plans again on the next update, and its effects stay unwritten', () => {
  const tasks = [
    { name: 'Root', methods: [{ when: { DoorBlocked: false }, subtasks: ['Kick'] }, { subtasks: ['Window'] }] },
    {
      name: 'Kick',
      effects: { In: true },
      run: (state) => {
        state.DoorBlocked = true;
        return 'failure';
      },
    },
    { name: 'Window', effects: { In: true } },
  ];
  const agent = new HtnAgent(tasks, 'Root', { state: { DoorBlocked: false } });
  assert.equal(agent.update().name, 'Kick');
  assert.equal(agent.state.In, undefined);
  assert.equal(agent.update().name, 'Window');
  assert.equal(agent.state.In, true);
  assert.equal(agent.plans, 2);
});

test('with nothing to do the agent does not plan again until the state changes', () => {
  const tasks = [{ name: 'Root', methods: [{ when: { Enemy: true }, subtasks: ['Go'] }] }, { name: 'Go' }];
  const agent = new HtnAgent(tasks, 'Root');
  for (let i = 0; i < 20; i++) assert.equal(agent.update(), null);
  assert.equal(agent.plans, 1);
  agent.state.Enemy = true;
  assert.equal(agent.update().name, 'Go');
  assert.equal(agent.plans, 2);
});

test('a partial plan written into the domain: walk first, plan the slam on arrival', () => {
  const tasks = [
    {
      name: 'Root',
      methods: [
        { when: { Range: 'far' }, subtasks: ['Walk'] },
        { when: { Range: 'melee' }, subtasks: ['Slam'] },
      ],
    },
    { name: 'Walk', effects: { Range: 'melee' } },
    { name: 'Slam' },
  ];
  const agent = new HtnAgent(tasks, 'Root', { state: { Range: 'far' } });
  assert.equal(agent.update().name, 'Walk');
  assert.equal(agent.update().name, 'Slam');
  assert.equal(agent.plans, 2);
});

test('halt stops the running task and clears the plan', () => {
  let stopped = 0;
  const agent = new HtnAgent([{ name: 'a', run: () => 'running', stop: () => stopped++ }], 'a');
  agent.update();
  agent.halt();
  assert.equal(stopped, 1);
  assert.equal(agent.current, null);
  assert.deepEqual(agent.record, []);
});

test('malformed input is refused with a message that names the fix', () => {
  assert.throws(() => planTasks('x', 'a', {}), /array of tasks/);
  assert.throws(() => planTasks([{}], 'a', {}), /non-empty name/);
  assert.throws(() => planTasks([{ name: 'a' }, { name: 'a' }], 'a', {}), /unique/);
  assert.throws(() => planTasks([{ name: 'a', methods: [] }], 'a', {}), /at least one method/);
  assert.throws(() => planTasks([{ name: 'a', methods: [{}] }], 'a', {}), /list their subtasks/);
  assert.throws(() => planTasks([{ name: 'a', methods: [{ subtasks: ['b'] }] }], 'a', {}), /add a task of that name/);
  assert.throws(() => planTasks([{ name: 'a', preconditions: 3 }], 'a', {}), /function/);
  assert.throws(() => planTasks([{ name: 'a', effects: { b: Number.NaN } }], 'a', {}), /symbol 'b'/);
  assert.throws(() => planTasks([{ name: 'a', effects: JSON.parse('{"__proto__": 1}') }], 'a', {}), /__proto__/);
  assert.throws(() => planTasks([{ name: 'a' }], 'b', {}), /root 'b'/);
  assert.throws(() => planTasks([{ name: 'a' }], 'a', null), /World state/);
  assert.throws(() => planTasks([{ name: 'a' }], 'a', {}, { maxSteps: 0 }), /maxSteps/);
  assert.throws(() => new HtnAgent([{ name: 'a' }], 'b'), /root 'b'/);
  assert.throws(() => new HtnAgent([{ name: 'a' }], 'a', { maxSteps: 0 }), /maxSteps/);
});
