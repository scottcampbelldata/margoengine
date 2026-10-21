import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockTableHash,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  Keys,
  moveIntent,
  quantizeYaw,
} from '../dist/index.js';
import { testBlocks } from './blocks.js';

const client = [
  { type: 'hello', version: 1, view: 6, name: 'Ada Ł' },
  {
    type: 'input',
    step: 1,
    acked: 0,
    runs: [
      { steps: 4, keys: Keys.forward | Keys.sprint, yaw: 40000, pitch: -100 },
      { steps: 2, keys: 0, yaw: 0, pitch: 127 },
    ],
    position: [1.25, -64.5, 1e6 + 0.125],
  },
  { type: 'edit', x: -5, y: 2 ** 31 - 1, z: -(2 ** 31), state: 2 ** 32 - 1 },
];
const server = [
  {
    type: 'welcome',
    version: 1,
    id: 7,
    tickRate: 20,
    view: 6,
    viewHeight: 3,
    simulation: 3,
    simulationHeight: 2,
    playerDistance: 96,
    blocks: 0xdeadbeef,
    flight: true,
  },
  { type: 'chunk', cx: -3, cy: 2 ** 26 - 1, cz: -(2 ** 26), data: new Uint8Array([1, 0, 1, 0, 0]) },
  { type: 'unload', cx: 1, cy: -1, cz: 0 },
  { type: 'state', spawn: true, step: 0, position: [0.5, 10, -0.5], velocity: [0, -2.5, 0], flying: false },
  { type: 'blocks', data: new Uint8Array([1, 2, 3]) },
  { type: 'players', tick: 123456, data: new Uint8Array([0]) },
  { type: 'loaded' },
];

test('every message round-trips', () => {
  for (const m of client) assert.deepEqual(decodeClientMessage(encodeClientMessage(m)), m);
  for (const m of server) assert.deepEqual(decodeServerMessage(encodeServerMessage(m)), m);
});

test('truncated, trailing and unknown bytes throw RangeError', () => {
  for (const m of client) {
    const bytes = encodeClientMessage(m);
    assert.throws(() => decodeClientMessage(bytes.subarray(0, bytes.length - 1)), RangeError);
    assert.throws(() => decodeClientMessage(Uint8Array.from([...bytes, 0])), RangeError);
  }
  for (const m of server.filter((m) => !['chunk', 'blocks', 'players'].includes(m.type))) {
    const bytes = encodeServerMessage(m);
    if (bytes.length > 1) assert.throws(() => decodeServerMessage(bytes.subarray(0, bytes.length - 1)), RangeError);
    assert.throws(() => decodeServerMessage(Uint8Array.from([...bytes, 0])), RangeError);
  }
  assert.throws(() => decodeClientMessage(new Uint8Array([99])), RangeError);
  assert.throws(() => decodeServerMessage(new Uint8Array([])), RangeError);
  assert.throws(() => decodeClientMessage([1, 2]), TypeError);
  // An input claiming more runs than it carries, a non-finite position, a name that is not UTF-8.
  assert.throws(() => decodeClientMessage(new Uint8Array([2, 1, 0, 200, 7])), RangeError);
  const input = encodeClientMessage(client[1]);
  new DataView(input.buffer).setFloat64(input.length - 8, Number.NaN, true);
  assert.throws(() => decodeClientMessage(input), /non-finite/);
  assert.throws(() => decodeClientMessage(new Uint8Array([1, 1, 6, 1, 0xff])), /UTF-8/);
});

test('encoders check their fields', () => {
  assert.throws(() => encodeClientMessage({ type: 'hello', version: 1, view: 6, name: 'x'.repeat(33) }), RangeError);
  assert.throws(() => encodeClientMessage({ ...client[1], runs: [] }), RangeError);
  assert.throws(() => encodeClientMessage({ ...client[1], position: [0, Number.POSITIVE_INFINITY, 0] }), RangeError);
  assert.throws(() => encodeClientMessage({ type: 'edit', x: 0.5, y: 0, z: 0, state: 1 }), RangeError);
  assert.throws(() => encodeClientMessage({ type: 'nope' }), TypeError);
  assert.throws(
    () => encodeServerMessage({ type: 'chunk', cx: 2 ** 26, cy: 0, cz: 0, data: new Uint8Array() }),
    RangeError,
  );
});

test('moveIntent turns the keys by the 16-bit yaw as the sandbox does', () => {
  const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-12, `${a} vs ${b}`));
  near(moveIntent(Keys.forward, 0).direction, [0, 0, -1]);
  near(moveIntent(Keys.forward, quantizeYaw(Math.PI / 2)).direction, [-1, 0, 0]);
  near(moveIntent(Keys.right, 0).direction, [1, 0, 0]);
  near(moveIntent(Keys.forward | Keys.back, 123).direction, [0, 0, 0]);
  const i = moveIntent(Keys.jump | Keys.sprint, 0);
  assert.equal(i.jump && i.sprint && !i.descend, true);
  assert.equal(quantizeYaw(-Math.PI / 2), 49152);
});

test('the block table hash follows names and the solid and liquid flags', () => {
  const a = testBlocks(),
    b = testBlocks();
  assert.equal(blockTableHash(a), blockTableHash(b));
  b.define('glass');
  assert.notEqual(blockTableHash(a), blockTableHash(b));
});
