import assert from 'node:assert/strict';
import test from 'node:test';

const m = await import('../dist/fauld-tunnels.js');

test('fauld-tunnels: every state dresses with models, its lamps and one metered exposure', () => {
  assert.equal(m.FAULD_TUNNEL_STATES.length, 10);
  for (const state of m.FAULD_TUNNEL_STATES) {
    const d = m.dressState(state);
    assert.ok(d.pieces.size > 0, state);
    assert.ok(Number.isFinite(m.FAULD_STATE_EV[state]), state);
    for (const lamp of d.lamps) assert.ok(lamp.at.every(Number.isFinite), state);
  }
  // The mains states light the store with dozens of bulkheads; the day yard has none.
  assert.ok(m.dressState('working').lamps.length > 40);
  assert.equal(m.dressState('yard_day').lamps.length, 0);
});

test('fauld-tunnels: plan metres map to Margo (x, z, -y) and the tungsten colour has luminance 1', () => {
  assert.deepEqual(m.toWorld(10, 2, 3), [10, 3, -2]);
  const [r, g, b] = m.TUNGSTEN_2700;
  assert.ok(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1) < 0.01);
  assert.ok(r > g && g > b);
});

test('fauld-tunnels: attach rejects an unknown state before touching the engine', async () => {
  await assert.rejects(m.attach({}, { state: 'nowhere' }), RangeError);
});
