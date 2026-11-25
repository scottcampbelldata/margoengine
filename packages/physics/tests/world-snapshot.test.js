// Snapshot, restore and the state hash of solvers on the physics framework: only named state counts, wherever it lies, in
// any order of the solvers; a restore puts it back bit for bit and the run goes on as if never stopped; anything that does
// not match is refused before a byte is written.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SNAPSHOT_VERSION, restoreSnapshot, stateHash, takeSnapshot } from '../dist/world.js';

/** A world memory and an allocator that starts at `start` bytes, so two worlds can lay the same solvers out differently. */
function world(start = 0) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let next = start;
  const host = {
    memory,
    gravity: [0, -9.81, 0],
    allocate(name, byteLength, type, layout) {
      const region = { name, byteOffset: next, byteLength, type, layout };
      next += Math.ceil(byteLength / 8) * 8;
      return region;
    },
    port: () => undefined,
  };
  return { memory, host };
}

/**
 * Particles falling and bouncing on a floor: positions and velocities as state, a step counter as extra state, and a
 * scratch buffer the solver writes every step and never names.
 */
function bouncer(id, count, layout = 1) {
  return {
    describe: () => ({ id, fields: [], rate: 0, stableRate: () => 0 }),
    init(host, { seed }) {
      this.host = host;
      this.state = host.allocate('particles', count * 16, 'f64', layout);
      this.history = host.allocate('steps', 4, 'u32', 1);
      this.scratch = host.allocate('scratch', 64, 'u8', 1);
      const s = this.words();
      for (let i = 0; i < count; i++) s[2 * i] = 1 + ((seed * (i + 1)) % 7) / 3;
    },
    words() {
      return new Float64Array(this.host.memory.buffer, this.state.byteOffset, count * 2);
    },
    step(_context, dt) {
      const s = this.words();
      for (let i = 0; i < count; i++) {
        s[2 * i + 1] += this.host.gravity[1] * dt;
        s[2 * i] += s[2 * i + 1] * dt;
        if (s[2 * i] < 0) {
          s[2 * i] = -s[2 * i];
          s[2 * i + 1] = -0.8 * s[2 * i + 1];
        }
      }
      new Uint32Array(this.host.memory.buffer, this.history.byteOffset, 1)[0]++;
      new Uint8Array(this.host.memory.buffer, this.scratch.byteOffset, 64).fill(this.scratchByte++ & 255);
    },
    scratchByte: 0,
    exportPorts: () => [],
    importPorts() {},
    stateRegions() {
      return [this.state];
    },
    extraState() {
      return [this.history];
    },
  };
}

function make(start = 0, order = ['balls', 'dust']) {
  const { memory, host } = world(start);
  const made = { balls: bouncer('balls', 5), dust: bouncer('dust', 3) };
  for (const id of order) made[id].init(host, { seed: id.length });
  return { memory, solvers: order.map((id) => made[id]) };
}
const run = ({ solvers }, steps) => {
  for (let t = 0; t < steps; t++)
    for (const s of solvers) s.step({ tick: t, level: 0, seed: 1, inputs: new Map(), cell: [0, 0, 0] }, 1 / 60);
};

test('the hash is a 64-bit fingerprint pinned on a known state, the same wherever the regions lie and in any order of the solvers', () => {
  const a = make(0, ['balls', 'dust']);
  const b = make(1000, ['dust', 'balls']);
  assert.match(stateHash(a.memory, a.solvers), /^[0-9a-f]{16}$/);
  assert.equal(
    stateHash(a.memory, a.solvers),
    stateHash(b.memory, b.solvers),
    'offsets and order are layout, not state',
  );
  // Pinned: the canonical stream and MurmurHash3 lanes give this on every platform; a change here changes every golden.
  assert.equal(stateHash(a.memory, a.solvers), 'bcca8b0ab9f8c00f');
  run(a, 30);
  run(b, 30);
  assert.equal(stateHash(a.memory, a.solvers), stateHash(b.memory, b.solvers));
});

test('scratch the solver does not name is not state; one changed bit of state or of the extra history is', () => {
  const a = make();
  const before = stateHash(a.memory, a.solvers);
  new Uint8Array(a.memory.buffer, a.solvers[0].scratch.byteOffset, 64).fill(99);
  assert.equal(stateHash(a.memory, a.solvers), before, 'scratch is left out');
  const state = new Uint8Array(a.memory.buffer, a.solvers[1].state.byteOffset, 1);
  state[0] ^= 1;
  assert.notEqual(stateHash(a.memory, a.solvers), before, 'a bit of state');
  state[0] ^= 1;
  new Uint32Array(a.memory.buffer, a.solvers[0].history.byteOffset, 1)[0] = 7;
  assert.notEqual(stateHash(a.memory, a.solvers), before, 'the extra history');
});

test('a snapshot restored into another layout goes on bit for bit as the run that was never stopped', () => {
  const straight = make();
  run(straight, 120);
  const first = make();
  run(first, 50);
  const snapshot = takeSnapshot(first.memory, first.solvers);
  assert.equal(snapshot.hash, stateHash(first.memory, first.solvers));
  const second = make(4096, ['dust', 'balls']);
  restoreSnapshot(second.memory, second.solvers, snapshot.bytes);
  assert.equal(stateHash(second.memory, second.solvers), snapshot.hash);
  run(second, 70);
  assert.equal(stateHash(second.memory, second.solvers), stateHash(straight.memory, straight.solvers));
  // And back in the same world, after it ran on.
  run(first, 10);
  restoreSnapshot(first.memory, first.solvers, snapshot.bytes);
  assert.equal(stateHash(first.memory, first.solvers), snapshot.hash);
});

test('a snapshot that does not match is refused before anything is written', () => {
  const a = make();
  run(a, 20);
  const { bytes } = takeSnapshot(a.memory, a.solvers);
  run(a, 5);
  const now = stateHash(a.memory, a.solvers);
  const refused = (solvers, data, code) => {
    assert.throws(
      () => restoreSnapshot(a.memory, solvers, data),
      (error) => error.name === 'MargoError' && error.code === code,
    );
    assert.equal(stateHash(a.memory, a.solvers), now, `left as it was (${code})`);
  };
  // A bit of the last region's data (the 16 bytes after it are the hash).
  const changed = bytes.slice();
  changed[bytes.length - 17] ^= 4;
  refused(a.solvers, changed, 'failed');
  refused(a.solvers, bytes.subarray(0, bytes.length - 3), 'failed');
  refused(a.solvers, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'failed');
  const later = bytes.slice();
  new DataView(later.buffer).setUint32(4, SNAPSHOT_VERSION + 1, true);
  refused(a.solvers, later, 'version');
  refused([a.solvers[0]], bytes, 'state');
  // The same solver at a new layout version of its particles.
  const { host } = world(8192);
  const relaid = bouncer('balls', 5, 2);
  relaid.init({ ...host, memory: a.memory }, { seed: 5 });
  refused([relaid, a.solvers[1]], bytes, 'version');
  const fewer = bouncer('balls', 4);
  fewer.init({ ...host, memory: a.memory }, { seed: 5 });
  refused([fewer, a.solvers[1]], bytes, 'state');
});

test('solvers with one id, or a solver with two regions of one name, are refused', () => {
  const a = make();
  const twin = bouncer('balls', 2);
  twin.init(world().host, { seed: 1 });
  assert.throws(
    () => stateHash(a.memory, [a.solvers[0], { ...twin, describe: () => ({ id: 'balls' }) }]),
    /share the id/,
  );
  const doubled = {
    ...a.solvers[0],
    stateRegions: () => [a.solvers[0].state, a.solvers[0].state],
    extraState: () => [],
  };
  assert.throws(() => takeSnapshot(a.memory, [doubled]), /two regions/);
});

test("a region's own memory is not recorded: the same state hashes and snapshots the same in the world's memory or its own", () => {
  // Transitional: a solver whose module still owns its memory names it on its regions until the framework's solvers share one.
  const shared = make();
  run(shared, 25);
  const own = make();
  run(own, 25);
  const elsewhere = new WebAssembly.Memory({ initial: 1 });
  const moved = own.solvers.map((solver) => {
    const relocate = (region) => {
      new Uint8Array(elsewhere.buffer, region.byteOffset, region.byteLength).set(
        new Uint8Array(own.memory.buffer, region.byteOffset, region.byteLength),
      );
      return { ...region, memory: elsewhere };
    };
    const state = solver.stateRegions().map(relocate),
      extra = solver.extraState().map(relocate);
    return { describe: solver.describe, stateRegions: () => state, extraState: () => extra };
  });
  const worldMemory = new WebAssembly.Memory({ initial: 1 }); // holds nothing of theirs
  assert.equal(stateHash(worldMemory, moved), stateHash(shared.memory, shared.solvers));
  const fromOwn = takeSnapshot(worldMemory, moved),
    fromShared = takeSnapshot(shared.memory, shared.solvers);
  assert.deepEqual(fromOwn.bytes, fromShared.bytes, 'the stream says nothing of where a region lies');
  run(shared, 10);
  restoreSnapshot(shared.memory, shared.solvers, fromOwn.bytes);
  assert.equal(stateHash(shared.memory, shared.solvers), fromOwn.hash);
});
