import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockTableHash,
  cleanPlayerName,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  Keys,
  MAX_NAME_BYTES,
  moveIntent,
  PROTOCOL_VERSION,
  quantizeYaw,
} from '../dist/index.js';
import { testBlocks } from './blocks.js';

const client = [
  { type: 'hello', version: 1, view: 6, name: 'Ada Ł' },
  {
    type: 'hello',
    version: 4,
    view: 6,
    name: 'Ada',
    resume: {
      token: Uint8Array.from({ length: 16 }, (_, i) => i * 7),
      chunks: 123456,
      stale: [
        [1, -2, 3],
        [-(2 ** 26), 2 ** 26 - 1, 0],
      ],
    },
  },
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
    resume: Uint8Array.from({ length: 16 }, (_, i) => 255 - i),
    resent: 300,
  },
  {
    type: 'welcome',
    version: 1,
    id: 8,
    tickRate: 20,
    view: 6,
    viewHeight: 3,
    simulation: 3,
    simulationHeight: 2,
    playerDistance: 96,
    blocks: 1,
    flight: false,
    resume: new Uint8Array(0),
    resent: 0,
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
  const input = encodeClientMessage(client[2]);
  new DataView(input.buffer).setFloat64(input.length - 8, Number.NaN, true);
  assert.throws(() => decodeClientMessage(input), /non-finite/);
  assert.throws(() => decodeClientMessage(new Uint8Array([1, 1, 6, 1, 0xff])), /UTF-8/);
});

test('encoders check their fields', () => {
  assert.throws(() => encodeClientMessage({ type: 'hello', version: 1, view: 6, name: 'x'.repeat(33) }), RangeError);
  assert.throws(() => encodeClientMessage({ ...client[2], runs: [] }), RangeError);
  assert.throws(() => encodeClientMessage({ ...client[2], position: [0, Number.POSITIVE_INFINITY, 0] }), RangeError);
  assert.throws(() => encodeClientMessage({ type: 'edit', x: 0.5, y: 0, z: 0, state: 1 }), RangeError);
  assert.throws(() => encodeClientMessage({ type: 'nope' }), TypeError);
  assert.throws(
    () => encodeServerMessage({ type: 'chunk', cx: 2 ** 26, cy: 0, cz: 0, data: new Uint8Array() }),
    RangeError,
  );
});

test('names round-trip, and hostile names messages throw', () => {
  const names = [
      { id: 7, name: 'Ada Ł' },
      { id: 2 ** 32 - 1, name: '' },
      { id: 0, name: 'é'.repeat(16) },
    ],
    bytes = encodeServerMessage({ type: 'names', names });
  assert.deepEqual(decodeServerMessage(bytes), { type: 'names', names });
  assert.equal(bytes[0], 23);
  assert.equal(PROTOCOL_VERSION, 4);
  assert.equal(MAX_NAME_BYTES, 32);
  // No entries, more entries than it carries, a name over 32 bytes, past the end, not UTF-8, trailing bytes.
  for (const hostile of [
    [23, 0],
    [23, 200, 1, 1, 0],
    [23, 1, 1, 33, ...new Uint8Array(33).fill(97)],
    [23, 1, 1, 200, 1, 97],
    [23, 1, 1, 5, 97],
    [23, 1, 1, 2, 0xc0, 0xaf],
    [23, 1, 1, 1, 97, 0],
    [23, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  ])
    assert.throws(() => decodeServerMessage(Uint8Array.from(hostile)), RangeError, String(hostile));
  // A hello with the same faults.
  assert.throws(() => decodeClientMessage(Uint8Array.from([1, 2, 6, 33, ...new Uint8Array(33)])), /over 32/);
  for (const [names, error] of [
    [undefined, TypeError],
    ['Ada', TypeError],
    [[], RangeError],
    [[{ id: 1, name: 'x'.repeat(33) }], RangeError],
    [[{ id: -1, name: 'x' }], RangeError],
    [[{ id: 1.5, name: 'x' }], RangeError],
    [[{ id: 1, name: 7 }], TypeError],
    [[null], TypeError],
    [new Array(65536).fill({ id: 1, name: '' }), RangeError],
  ])
    assert.throws(() => encodeServerMessage({ type: 'names', names }), error);
});

test('cleanPlayerName leaves names people can read and nothing else', () => {
  for (const [hostile, clean] of [
    ['Ada', 'Ada'],
    ['  quiet   otter\t', 'quiet otter'],
    ['Zoë', 'Zoë'],
    ['Zoë', 'Zoë'], // NFC
    ['李小龙', '李小龙'],
    ['‮evil‬', 'evil'], // bidi override
    ['a​‍﻿b', 'ab'], // zero widths, byte order mark
    ['a\u0000b\u0007\u001b[31m', 'ab[31m'], // controls, terminal colours
    ['line\nbreak\r\nthree four', 'line break three four'],
    [' 　nbsp ', 'nbsp'],
    ['<img src=x onerror=alert(1)>', 'img src=x onerror=alert(1)'],
    ['ㅤ⠀ᅟﾠ', ''], // blank letters
    ['á̂̃̄̅', 'á̂̃'], // stacked marks: NFC takes the first in, then 2
    ['\ud800lone', 'lone'], // lone surrogate
    ['private', 'private'],
    ['\u{10ffff}none', 'none'],
    ['x'.repeat(100), 'x'.repeat(32)],
    [`${'x'.repeat(31)}é`, 'x'.repeat(31)], // never cuts a character in two
    [`${'é'.repeat(16)}é`, 'é'.repeat(16)],
    [`${'x'.repeat(31)} y`, 'x'.repeat(31)], // and leaves no trailing space
    ['', ''],
  ])
    assert.equal(cleanPlayerName(hostile), clean, JSON.stringify(hostile));
  for (const value of [undefined, null, 7, {}, ['Ada'], Symbol.iterator]) assert.equal(cleanPlayerName(value), '');
  // The result always fits the wire.
  for (const name of ['é'.repeat(40), '😀'.repeat(20), 'á'.repeat(40)])
    encodeServerMessage({ type: 'names', names: [{ id: 1, name: cleanPlayerName(name) }] });
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

test('protocol 4: a hello without resume is the bytes protocol 3 sent, so an old page still hears its version refused', () => {
  const name = new TextEncoder().encode('Ada'),
    bytes = Uint8Array.from([1, 3, 6, name.length, ...name]);
  assert.deepEqual(decodeClientMessage(bytes), { type: 'hello', version: 3, view: 6, name: 'Ada' });
  assert.deepEqual(encodeClientMessage({ type: 'hello', version: 3, view: 6, name: 'Ada' }), bytes);
});

test('protocol 4: the resume fields are range checked both ways', () => {
  const resume = (over) => ({
      type: 'hello',
      version: 4,
      view: 6,
      name: '',
      resume: { token: new Uint8Array(16), chunks: 0, stale: [], ...over },
    }),
    welcome = (over) => ({
      type: 'welcome',
      version: 4,
      id: 1,
      tickRate: 20,
      view: 6,
      viewHeight: 3,
      simulation: 3,
      simulationHeight: 2,
      playerDistance: 96,
      blocks: 1,
      flight: false,
      resume: new Uint8Array(16),
      resent: 0,
      ...over,
    });
  assert.throws(() => encodeClientMessage(resume({ token: new Uint8Array(15) })), RangeError);
  assert.throws(() => encodeClientMessage(resume({ token: 'x' })), TypeError);
  assert.throws(() => encodeClientMessage(resume({ chunks: -1 })), RangeError);
  const many = Array.from({ length: 65 }, () => [0, 0, 0]);
  assert.throws(() => encodeClientMessage(resume({ stale: many })), RangeError);
  assert.throws(() => encodeClientMessage(resume({ stale: [[2 ** 26, 0, 0]] })), RangeError);
  assert.throws(() => encodeServerMessage(welcome({ resume: new Uint8Array(8) })), RangeError);
  assert.throws(() => encodeServerMessage(welcome({ resent: -1 })), RangeError);
  // On the wire: a token cut short, too many stale chunks, a stale chunk out of range, a token of the wrong length.
  const good = encodeClientMessage(resume({ stale: [[1, 2, 3]] })),
    start = good.length - 16 - 2 - 3; // past the name: where the resume fields begin
  for (let end = start + 1; end < good.length; end++)
    assert.throws(() => decodeClientMessage(good.subarray(0, end)), RangeError, `hello cut at ${end}`);
  const head = [...good.subarray(0, start + 16)];
  assert.throws(() => decodeClientMessage(Uint8Array.from([...head, 0, 65, ...new Array(195).fill(0)])), RangeError);
  assert.throws(() => decodeClientMessage(Uint8Array.from([...head, 0, 1, 128, 128, 128, 128, 2, 0, 0])), RangeError);
  const bytes = encodeServerMessage(welcome({ resume: new Uint8Array(0) })),
    at = bytes.length - 2; // the token's length, then resent
  const wrong = Uint8Array.from([...bytes.subarray(0, at), 8, ...new Uint8Array(8), 0]);
  assert.throws(() => decodeServerMessage(wrong), RangeError);
  // Bytes the decoder hands out are a plain copy: a Node Buffer's slice would share the socket's memory.
  const token = decodeClientMessage(Buffer.from(encodeClientMessage(resume({ token: new Uint8Array(16).fill(9) }))))
    .resume.token;
  assert.equal(token.constructor, Uint8Array);
});
