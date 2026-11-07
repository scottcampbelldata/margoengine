// Goal planner: the papers' worked examples, the cheapest plan against an exhaustive forward search, and when the agent
// plans again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom } from '@margoengine/math/mathutils';
import { GoapAgent, planActions } from '../dist/goap.js';

const names = (plan) => plan.actions.map((action) => action.name);

const fight = [
  { name: 'Attack', preconditions: { Armed: true, At: 'target' }, effects: { TargetDead: true } },
  { name: 'DrawWeapon', preconditions: { Holstered: true }, effects: { Armed: true } },
  { name: 'PickupPipe', preconditions: { At: 'pipe' }, effects: { Armed: true } },
  { name: 'GotoPipe', effects: { At: 'pipe' } },
  { name: 'GotoTarget', effects: { At: 'target' } },
];

test('the empty-handed agent of the paper fetches the pipe and then attacks', () => {
  const plan = planActions({ Armed: false, Holstered: false, At: 'door' }, { TargetDead: true }, fight);
  assert.deepEqual(names(plan), ['GotoPipe', 'PickupPipe', 'GotoTarget', 'Attack']);
  assert.equal(plan.cost, 4);
});

test('a holstered weapon is cheaper than a walk, and the plan uses it', () => {
  const plan = planActions({ Armed: false, Holstered: true, At: 'door' }, { TargetDead: true }, fight);
  // Drawing and walking do not depend on each other, so both orders cost 3; only the choice of actions is fixed.
  assert.deepEqual(names(plan).sort(), ['Attack', 'DrawWeapon', 'GotoTarget']);
  assert.equal(names(plan).at(-1), 'Attack');
  assert.equal(plan.cost, 3);
});

test('a goal that already holds needs no actions', () => {
  const plan = planActions({ TargetDead: true }, { TargetDead: true }, fight);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.cost, 0);
});

test('costs choose between plans: one dear action loses to two cheap ones', () => {
  const actions = [
    { name: 'Teleport', cost: 5, effects: { At: 'b' } },
    { name: 'Open', cost: 1, effects: { Door: 'open' } },
    { name: 'Walk', cost: 1, preconditions: { Door: 'open' }, effects: { At: 'b' } },
  ];
  assert.deepEqual(names(planActions({ At: 'a', Door: 'shut' }, { At: 'b' }, actions)), ['Open', 'Walk']);
  assert.deepEqual(
    names(planActions({ At: 'a', Door: 'shut' }, { At: 'b' }, [...actions.slice(1), { ...actions[0], cost: 1.5 }])),
    ['Teleport'],
  );
});

test('no plan gives null: a symbol nothing sets, or a goal that needs a contradiction', () => {
  assert.equal(planActions({}, { Flying: true }, fight), null);
  const actions = [{ name: 'Sit', preconditions: { Standing: true }, effects: { Standing: false, Sitting: true } }];
  assert.equal(planActions({ Standing: true }, { Standing: true, Sitting: true }, actions), null);
});

test('a symbol that holds now can be undone and put back on the way', () => {
  // The goal wants the door shut and the box inside. The door is shut now, and carrying the box in needs it open, so
  // a planner that dropped symbols already true would stop at Carry and leave the door open.
  const actions = [
    { name: 'Open', effects: { Door: 'open' } },
    { name: 'Close', effects: { Door: 'shut' } },
    { name: 'Carry', preconditions: { Door: 'open' }, effects: { Box: 'in' } },
  ];
  const plan = planActions({ Door: 'shut', Box: 'out' }, { Door: 'shut', Box: 'in' }, actions);
  assert.deepEqual(names(plan), ['Open', 'Carry', 'Close']);
});

test('an unset symbol matches nothing, false included', () => {
  const actions = [{ name: 'Go', preconditions: { Blocked: false }, effects: { Done: true } }];
  assert.equal(planActions({}, { Done: true }, actions), null);
  assert.deepEqual(names(planActions({ Blocked: false }, { Done: true }, actions)), ['Go']);
});

test('available prunes an action for this plan, once per plan', () => {
  let calls = 0;
  const actions = [
    {
      name: 'Dive',
      available: (state) => {
        calls++;
        return state.Room === true;
      },
      effects: { Safe: true },
    },
    { name: 'Run', cost: 3, effects: { Safe: true } },
  ];
  assert.deepEqual(names(planActions({ Room: true }, { Safe: true }, actions)), ['Dive']);
  assert.deepEqual(names(planActions({ Room: false }, { Safe: true }, actions)), ['Run']);
  assert.equal(calls, 2);
});

test('maxNodes stops a search that is too big', () => {
  const actions = Array.from({ length: 12 }, (_, i) => ({
    name: `a${i}`,
    preconditions: { [`s${i + 1}`]: true },
    effects: { [`s${i}`]: true },
  }));
  assert.equal(planActions({ s12: true }, { s0: true }, actions, { maxNodes: 3 }), null);
  assert.equal(planActions({ s12: true }, { s0: true }, actions).actions.length, 12);
});

// The exhaustive answer: uniform cost search forward from the state over every action.
const forward = (state, desired, actions) => {
  const key = (s) =>
    JSON.stringify(
      Object.keys(s)
        .sort()
        .map((k) => [k, s[k]]),
    );
  const holds = (s, w) => Object.keys(w).every((k) => k in s && s[k] === w[k]);
  const best = new Map([[key(state), 0]]);
  const open = [{ state, cost: 0 }];
  let answer = null;
  while (open.length > 0) {
    open.sort((a, b) => a.cost - b.cost);
    const node = open.shift();
    if (holds(node.state, desired)) {
      answer = node.cost;
      break;
    }
    for (const action of actions) {
      if (!holds(node.state, action.preconditions ?? {})) continue;
      const next = { ...node.state, ...action.effects };
      const cost = node.cost + (action.cost ?? 1);
      const k = key(next);
      if ((best.get(k) ?? Number.POSITIVE_INFINITY) <= cost) continue;
      best.set(k, cost);
      open.push({ state: next, cost });
    }
  }
  return answer;
};

test('property: on 500 random domains the plan runs, reaches the goal and costs what exhaustive search says', () => {
  const random = createRandom(3);
  const pick = (n) => Math.floor(random() * n);
  let solved = 0;
  for (let round = 0; round < 500; round++) {
    const symbols = ['a', 'b', 'c', 'd', 'e', 'f'];
    const value = () => pick(3);
    const someOf = (max) => {
      const out = {};
      for (let i = 0, n = pick(max + 1); i < n; i++) out[symbols[pick(symbols.length)]] = value();
      return out;
    };
    const actions = Array.from({ length: 2 + pick(8) }, (_, i) => {
      const effects = someOf(2);
      effects[symbols[pick(symbols.length)]] = value();
      return { name: `n${i}`, cost: 1 + pick(4), preconditions: someOf(2), effects };
    });
    const state = Object.fromEntries(symbols.map((symbol) => [symbol, value()]));
    const desired = someOf(3);
    const expected = forward(state, desired, actions);
    const plan = planActions(state, desired, actions, { maxNodes: 200000 });
    if (expected === null) {
      assert.equal(plan, null, `round ${round}`);
      continue;
    }
    solved++;
    assert.equal(plan.cost, expected, `round ${round}`);
    let now = state;
    for (const action of plan.actions) {
      for (const [symbol, wanted] of Object.entries(action.preconditions)) assert.equal(now[symbol], wanted);
      now = { ...now, ...action.effects };
    }
    for (const [symbol, wanted] of Object.entries(desired)) assert.equal(now[symbol], wanted);
  }
  assert.ok(solved > 100, `${solved} of the domains had plans`);
});

test('an agent runs its plan, writes effects and stops when the goal holds', () => {
  const agent = new GoapAgent([{ name: 'Kill', desired: { TargetDead: true } }], fight, {
    state: { Armed: false, Holstered: false, At: 'door' },
  });
  const ran = [];
  for (let i = 0; i < 6; i++) {
    const action = agent.update();
    ran.push(action?.name ?? null);
  }
  assert.equal(agent.state.TargetDead, true);
  assert.equal(agent.state.At, 'target');
  assert.equal(agent.plans, 1, 'it planned once');
  assert.deepEqual(ran, ['Kill', 'Kill', 'Kill', 'Kill', null, null]);
});

test('an agent keeps its plan while nothing changes, and plans again when its best goal changes', () => {
  let stopped = 0;
  const actions = [
    { name: 'Patrol', run: () => 'running', stop: () => stopped++, effects: { Patrolled: true } },
    { name: 'Flee', effects: { Safe: true } },
  ];
  const agent = new GoapAgent(
    [
      { name: 'Patrol', desired: { Patrolled: true }, relevance: 1 },
      { name: 'Survive', desired: { Safe: true }, relevance: (state) => (state.Danger ? 5 : 0) },
    ],
    actions,
  );
  for (let i = 0; i < 50; i++) agent.update();
  assert.equal(agent.plans, 1);
  assert.equal(agent.current.name, 'Patrol');
  agent.state.Danger = true;
  agent.update();
  assert.equal(stopped, 1, 'the running action was told to stop');
  assert.equal(agent.state.Safe, true);
  assert.equal(agent.plans, 2);
  agent.state.Danger = false;
  agent.update();
  assert.equal(agent.current.name, 'Patrol');
});

test('a failed action writes why, and the next plan goes another way: the blocked door and the window', () => {
  const actions = [
    {
      name: 'KickDoor',
      preconditions: { DoorBlocked: false },
      effects: { In: true },
      run: (state) => {
        state.DoorBlocked = true;
        return 'failure';
      },
    },
    { name: 'DiveThroughWindow', cost: 3, effects: { In: true } },
  ];
  const agent = new GoapAgent([{ name: 'Reach', desired: { In: true } }], actions, { state: { DoorBlocked: false } });
  agent.update();
  assert.equal(agent.state.In, undefined);
  agent.update();
  assert.equal(agent.state.In, true);
  assert.equal(agent.plans, 2);
});

test('a broken precondition sends the agent back to the planner before the action starts', () => {
  const actions = [
    { name: 'Draw', effects: { Armed: true } },
    { name: 'Shoot', preconditions: { Armed: true, Ammo: true }, effects: { Dead: true } },
    { name: 'Reload', effects: { Ammo: true } },
  ];
  const agent = new GoapAgent([{ name: 'Kill', desired: { Dead: true } }], actions, { state: { Ammo: true } });
  agent.update();
  assert.equal(agent.state.Armed, true);
  agent.state.Ammo = false;
  agent.update();
  assert.equal(agent.state.Dead, undefined);
  assert.equal(agent.plans, 2);
  assert.deepEqual(
    agent.plan.map((action) => action.name),
    ['Reload', 'Shoot'],
  );
});

test('a goal with no plan falls through to the next, and is not planned again until the state changes', () => {
  const agent = new GoapAgent(
    [
      { name: 'Fly', desired: { Flying: true }, relevance: 9 },
      { name: 'Wait', desired: { Rested: true }, relevance: 1 },
    ],
    [{ name: 'Rest', run: () => 'running', effects: { Rested: true } }],
  );
  agent.update();
  assert.equal(agent.goal.name, 'Wait');
  const { plans } = agent;
  for (let i = 0; i < 20; i++) agent.update();
  assert.equal(agent.plans, plans);
  agent.state.Wind = true;
  agent.update();
  assert.equal(agent.plans, plans + 1);
});

test('a goal the world satisfies by itself ends the plan and stops the running action', () => {
  let stopped = 0;
  const agent = new GoapAgent(
    [{ name: 'Reach', desired: { In: true } }],
    [{ name: 'Walk', run: () => 'running', stop: () => stopped++, effects: { In: true } }],
  );
  agent.update();
  assert.equal(agent.current.name, 'Walk');
  agent.state.In = true; // a sensor: something carried the agent in
  assert.equal(agent.update(), null);
  assert.equal(agent.current, null);
  assert.equal(stopped, 1);
});

test('halt stops the running action and clears the plan', () => {
  let stopped = 0;
  const agent = new GoapAgent(
    [{ name: 'g', desired: { d: true } }],
    [{ name: 'a', run: () => 'running', stop: () => stopped++, effects: { d: true } }],
  );
  agent.update();
  agent.halt();
  assert.equal(stopped, 1);
  assert.equal(agent.current, null);
  assert.equal(agent.goal, null);
});

test('malformed input is refused with a message that names the fix', () => {
  assert.throws(() => planActions(null, {}, []), /World state/);
  assert.throws(() => planActions({}, { a: Number.NaN }, []), /symbol 'a'/);
  assert.throws(() => planActions(JSON.parse('{"__proto__": true}'), {}, []), /__proto__/);
  assert.throws(() => planActions({}, {}, 'x'), /must be an array/);
  assert.throws(() => planActions({}, {}, [{ effects: { a: true } }]), /non-empty name/);
  assert.throws(() => planActions({}, {}, [{ name: 'a', effects: {} }]), /at least one effect/);
  assert.throws(() => planActions({}, {}, [{ name: 'a', cost: 0, effects: { a: true } }]), /cost/);
  assert.throws(
    () =>
      planActions({}, {}, [
        { name: 'a', effects: { a: true } },
        { name: 'a', effects: { b: true } },
      ]),
    /unique/,
  );
  assert.throws(() => planActions({}, {}, [], { maxNodes: 0 }), /maxNodes/);
  assert.throws(() => new GoapAgent('x', []), /must be an array/);
  assert.throws(() => new GoapAgent([{ desired: {} }], []), /non-empty name/);
});
