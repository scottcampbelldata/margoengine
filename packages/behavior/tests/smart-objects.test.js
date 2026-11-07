// Smart objects: offers against needs, the fade with distance, availability, slots and claims, and the routine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartObject, SmartObjects } from '../dist/smart-objects.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);
const world = (...objects) => {
  const all = new SmartObjects();
  for (const object of objects) all.add(new SmartObject(object));
  return all;
};
const chair = (id = 'chair', position = [0, 0, 0], extra = {}) => ({
  id,
  position,
  uses: [{ name: 'sit', advertises: { rest: 1 }, ...extra }],
});

test('an agent picks what meets its strongest need', () => {
  const all = world(chair(), { id: 'fridge', position: [0, 0, 0], uses: [{ name: 'eat', advertises: { hunger: 1 } }] });
  const agent = { position: [0, 0, 0], needs: { rest: 0.2, hunger: 0.9 } };
  assert.equal(all.best(agent).use.name, 'eat');
  agent.needs.rest = 1;
  assert.equal(all.best(agent).use.name, 'sit');
  near(all.best(agent).score, 1);
});

test('a need named after an inherited object key counts as unset', () => {
  const all = world({ id: 'x', position: [0, 0, 0], uses: [{ name: 'u', advertises: { toString: 1 } }] });
  assert.equal(all.best({ position: [0, 0, 0], needs: {} }), null);
  assert.throws(() => all.offers({ position: [0, 0, 0], needs: { toString: Number.NaN } }), /finite number/);
});

test('one use can meet several needs, and a function scales it by the agent', () => {
  const all = world({
    id: 'gym',
    position: [0, 0, 0],
    uses: [{ name: 'lift', advertises: { fun: (agent) => agent.active * 2, health: 1 } }],
  });
  near(all.best({ position: [0, 0, 0], needs: { fun: 1, health: 0.5 }, active: 3 }).score, 6.5);
});

test('offers fade with distance, and attenuation 0 never fades', () => {
  const all = world(
    chair('near', [2, 0, 0], { advertises: { rest: 0.5 } }),
    chair('far', [10, 0, 0], { advertises: { rest: 1 } }),
    chair('beacon', [100, 0, 0], { advertises: { rest: 0.1 }, attenuation: 0 }),
  );
  const offers = all.offers({ position: [0, 0, 0], needs: { rest: 1 } });
  near(offers.find((offer) => offer.object.id === 'near').score, 0.5 / 1.2);
  near(offers.find((offer) => offer.object.id === 'far').score, 1 / 2);
  near(offers.find((offer) => offer.object.id === 'beacon').score, 0.1);
  assert.deepEqual(
    offers.map((offer) => offer.object.id),
    ['far', 'near', 'beacon'],
  );
  assert.equal(all.offers({ position: [0, 0, 0], needs: { rest: 1 } }, { radius: 5 }).length, 1);
});

test('an agent with no matching need gets no offers, unless it asks for the use by name', () => {
  const all = world(chair('a', [5, 0, 0]), chair('b', [1, 0, 0]));
  const agent = { position: [0, 0, 0] };
  assert.deepEqual(all.offers(agent), []);
  const named = all.offers(agent, { use: 'sit' });
  assert.deepEqual(
    named.map((offer) => offer.object.id),
    ['b', 'a'],
  );
  assert.deepEqual(all.offers(agent, { use: 'fly' }), []);
});

test('a broken object hides the use until its state is fixed', () => {
  const all = world({
    id: 'door',
    position: [0, 0, 0],
    state: { broken: true },
    uses: [
      { name: 'open', advertises: { exit: 1 }, available: (object) => !object.state.broken },
      {
        name: 'repair',
        advertises: { work: 1 },
        available: (object) => object.state.broken === true,
        run: (_agent, object) => {
          object.state.broken = false;
          return 'success';
        },
      },
    ],
  });
  const agent = { position: [1, 0, 0], needs: { exit: 1, work: 1 } };
  assert.equal(all.best(agent).use.name, 'repair');
  const claim = all.claim(all.best(agent), agent);
  assert.equal(claim.update(0.1), 'success');
  assert.equal(all.best(agent).use.name, 'open');
});

test('slots hold one agent each, the nearest free one first, and a full object stops offering', () => {
  const all = world({
    id: 'bench',
    position: [10, 0, 0],
    uses: [
      {
        name: 'sit',
        advertises: { rest: 1 },
        slots: [{ offset: [-1, 0, 0], facing: [0, 0, 1] }, { offset: [1, 0, 0] }],
      },
    ],
  });
  const left = { position: [0, 0, 0], needs: { rest: 1 } };
  const right = { position: [20, 0, 0], needs: { rest: 1 } };
  const third = { position: [20, 0, 0], needs: { rest: 1 } };
  const offer = all.best(left);
  const first = all.claim(offer, left);
  assert.deepEqual(first.position(), [9, 0, 0]);
  assert.deepEqual(first.facing, [0, 0, 1]);
  const second = all.claim(all.best(right), right);
  assert.deepEqual(second.position(), [11, 0, 0]);
  assert.equal(second.facing, null);
  assert.equal(all.get('bench').users(), 2);
  assert.equal(all.best(third), null);
  assert.equal(all.claim(offer, third), null, 'an old offer cannot beat the slots');
  second.release();
  assert.equal(all.best(third).object.id, 'bench');
});

test('two agents racing for one chair: only one gets it', () => {
  const all = world(chair());
  const a = { position: [1, 0, 0], needs: { rest: 1 } };
  const b = { position: [2, 0, 0], needs: { rest: 1 } };
  const offerA = all.best(a);
  const offerB = all.best(b);
  assert.ok(all.claim(offerA, a));
  assert.equal(all.claim(offerB, b), null);
});

test('an exclusive use waits for the object to empty and blocks everything while held', () => {
  const all = world({
    id: 'machine',
    position: [0, 0, 0],
    uses: [
      { name: 'operate', advertises: { work: 1 }, slots: [{}, {}] },
      { name: 'service', advertises: { repair: 1 }, exclusive: true },
    ],
  });
  const worker = { position: [0, 0, 0], needs: { work: 1, repair: 0.5 } };
  const mechanic = { position: [0, 0, 0], needs: { repair: 1 } };
  const held = all.claim(all.best(worker), worker);
  assert.equal(all.best(mechanic), null, 'someone is on the machine');
  held.release();
  const service = all.claim(all.best(mechanic), mechanic);
  assert.ok(service);
  assert.equal(all.best({ position: [0, 0, 0], needs: { work: 1 } }), null);
  assert.equal(all.best({ position: [0, 0, 0], needs: { repair: 1 } }), null, 'one exclusive user at a time');
});

test('a claim follows its object, runs the routine, lowers needs and frees the slot', () => {
  let ticks = 0;
  const position = [0, 0, 0];
  const all = world({
    id: 'bed',
    position,
    uses: [
      {
        name: 'sleep',
        advertises: { energy: 0.7, sleep: (agent) => agent.tired },
        slots: [{ offset: [0, 1, 0] }],
        run: () => (++ticks < 3 ? 'running' : 'success'),
      },
    ],
  });
  const agent = { position: [1, 0, 0], needs: { energy: 0.9, sleep: 0.5 }, tired: 2 };
  const claim = all.claim(all.best(agent), agent);
  position[0] = 5;
  assert.deepEqual(claim.position(), [5, 1, 0]);
  assert.equal(claim.update(1), 'running');
  assert.equal(claim.update(1), 'running');
  assert.equal(all.get('bed').users('sleep'), 1);
  assert.equal(claim.update(1), 'success');
  near(agent.needs.energy, 0.2);
  assert.equal(agent.needs.sleep, 0);
  assert.equal(claim.active, false);
  assert.equal(all.get('bed').users(), 0);
  assert.throws(() => claim.update(1), { code: 'state' });
});

test('a failed use leaves needs alone and frees the slot', () => {
  const all = world(chair('c', [0, 0, 0], { run: () => 'failure' }));
  const agent = { position: [0, 0, 0], needs: { rest: 1 } };
  const claim = all.claim(all.best(agent), agent);
  assert.equal(claim.update(1), 'failure');
  assert.equal(agent.needs.rest, 1);
  assert.equal(claim.active, false);
});

test('using releases at the end of the scope, and release twice is safe', () => {
  const all = world(chair());
  const agent = { position: [0, 0, 0], needs: { rest: 1 } };
  const claim = all.claim(all.best(agent), agent);
  claim[Symbol.dispose]();
  claim.release();
  assert.equal(all.get('chair').users(), 0);
});

test('removing an object ends its claims', () => {
  const all = world(chair());
  const agent = { position: [0, 0, 0], needs: { rest: 1 } };
  const offer = all.best(agent);
  const claim = all.claim(offer, agent);
  assert.equal(all.remove('chair'), true);
  assert.equal(claim.active, false);
  assert.equal(all.remove('chair'), false);
  assert.equal(all.size, 0);
  assert.equal(all.claim(offer, agent), null, 'a stale offer holds nothing');
});

test('malformed input is refused with a message that names the fix', () => {
  const uses = [{ name: 'sit' }];
  assert.throws(() => new SmartObject(null), /must be \{id/);
  assert.throws(() => new SmartObject({ id: '', position: [0, 0, 0], uses }), /non-empty id/);
  assert.throws(() => new SmartObject({ id: 'a', position: [0], uses }), /Smart object position/);
  assert.throws(() => new SmartObject({ id: 'a', position: [0, 0, 0], uses: 'x' }), /in an array/);
  assert.throws(() => new SmartObject({ id: 'a', position: [0, 0, 0], uses: [{}] }), /non-empty name/);
  assert.throws(() => new SmartObject({ id: 'a', position: [0, 0, 0], uses: [...uses, ...uses] }), /unique/);
  assert.throws(
    () => new SmartObject({ id: 'a', position: [0, 0, 0], uses: [{ name: 's', slots: [] }] }),
    /at least one/,
  );
  assert.throws(
    () => new SmartObject({ id: 'a', position: [0, 0, 0], uses: [{ name: 's', attenuation: -1 }] }),
    /attenuation/,
  );
  const all = new SmartObjects();
  assert.throws(() => all.add({}), /new SmartObject/);
  all.add(new SmartObject({ id: 'a', position: [0, 0, 0], uses }));
  assert.throws(() => all.add(new SmartObject({ id: 'a', position: [0, 0, 0], uses })), /ids must be unique/);
  assert.throws(() => all.offers(null), /must be \{position/);
  assert.throws(() => all.offers({ position: [0] }), /Agent position/);
  assert.throws(() => all.offers({ position: [0, 0, 0] }, { radius: -1 }), /radius/);
  const bad = world({ id: 'b', position: [0, 0, 0], uses: [{ name: 's', advertises: { n: () => Number.NaN } }] });
  assert.throws(() => bad.offers({ position: [0, 0, 0], needs: { n: 1 } }), /finite amount/);
});
