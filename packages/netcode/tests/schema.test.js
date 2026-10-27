import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom } from '@margoengine/math/mathutils';
import { decodeEnvelope, defineSchema, dequantize, encodeEnvelope, fnv1a, quantize } from '../dist/index.js';
import { every, generator } from './values.js';

const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test('round trip: decode(encode(v)) re-encodes to the same bytes, and equals() agrees', () => {
  const random = createRandom(1),
    { struct } = generator(every, random);
  for (let n = 0; n < 500; n++) {
    const value = struct('All'),
      bytes = every.encode('All', value),
      back = every.decode('All', bytes);
    assert.ok(equalBytes(every.encode('All', back), bytes), `case ${n}`);
    assert.ok(every.equals('All', value, back));
    assert.ok(every.equals('All', every.clone('All', value), back));
  }
});

test('exact values survive: integers, f64, strings, bytes, enums, maps sorted by id', () => {
  const value = {
    a: 255,
    b: 65535,
    c: 2 ** 32 - 1,
    d: -128,
    e: -32768,
    f: -(2 ** 31),
    g: 2 ** 32 - 1,
    h: -(2 ** 31),
    i: Math.PI,
    j: new Uint8Array([0, 255, 7]),
    entities: new Map([
      [9, { position: { x: 0.5, y: -2 }, heading: 1, health: 50, kind: 'bullet', alive: true, items: [] }],
      [
        2,
        {
          position: { x: 1, y: 2 },
          heading: 0,
          health: 100,
          kind: 'player',
          alive: false,
          tag: 'Ada Ł',
          items: [{ name: 'key', count: 3 }],
        },
      ],
    ]),
    scores: new Map([[1, -5]]),
  };
  const back = every.decode('All', every.encode('All', value));
  assert.deepEqual({ ...back, entities: undefined }, { ...value, entities: undefined });
  assert.deepEqual([...back.entities.keys()], [2, 9]);
  assert.deepEqual(back.entities.get(2), value.entities.get(2));
  assert.equal('tag' in back.entities.get(9), false);
});

test('delta: decodeDelta(encodeDelta(v, base), base) equals decode(encode(v)), and is smaller when little changed', () => {
  const random = createRandom(2),
    { struct, mutate } = generator(every, random);
  let deltaBytes = 0,
    fullBytes = 0;
  for (let n = 0; n < 400; n++) {
    const base = every.decode('All', every.encode('All', struct('All'))),
      next = mutate('All', base),
      delta = every.encodeDelta('All', next, base),
      full = every.encode('All', next),
      back = every.decodeDelta('All', delta, base);
    assert.ok(equalBytes(every.encode('All', back), full), `case ${n}`);
    deltaBytes += delta.length;
    fullBytes += full.length;
  }
  assert.ok(deltaBytes < 0.8 * fullBytes, `deltas ${deltaBytes} B against ${fullBytes} B in full`);
  // No change at all: one mask byte per struct level that is walked (here just the top: 2 bytes for 12 fields).
  const base = every.decode('All', every.encode('All', struct('All')));
  assert.equal(every.encodeDelta('All', base, base).length, 2);
});

test('delta of an entity map sends only what changed', () => {
  const schema = defineSchema({
    types: {
      Box: { x: 'f32', y: 'f32', hp: 'u8' },
      State: { boxes: { type: 'map', of: 'Box', maxSize: 1000 } },
    },
  });
  const boxes = new Map(Array.from({ length: 500 }, (_, i) => [i, { x: i, y: -i, hp: 100 }]));
  const base = schema.decode('State', schema.encode('State', { boxes }));
  const next = structuredClone(base);
  next.boxes.get(10).x = 99;
  next.boxes.delete(20);
  next.boxes.set(700, { x: 1, y: 1, hp: 1 });
  const delta = schema.encodeDelta('State', next, base);
  assert.ok(delta.length < 30, `${delta.length} bytes`);
  const back = schema.decodeDelta('State', delta, base);
  assert.equal(back.boxes.size, 500);
  assert.equal(back.boxes.get(10).x, 99);
  assert.equal(back.boxes.has(20), false);
  assert.deepEqual(back.boxes.get(700), { x: 1, y: 1, hp: 1 });
  assert.deepEqual(
    [...back.boxes.keys()],
    [...back.boxes.keys()].sort((a, b) => a - b),
  );
});

test('fuzz: random, truncated and bit-flipped bytes throw only RangeError, never crash or hang', () => {
  const random = createRandom(3),
    { struct, mutate } = generator(every, random),
    int = (n) => Math.floor(random() * n);
  let decoded = 0,
    refused = 0;
  const attempt = (decode) => {
    try {
      decode();
      decoded++;
    } catch (error) {
      assert.ok(error instanceof RangeError, `${error.name}: ${error.message}`);
      refused++;
    }
  };
  for (let n = 0; n < 2000; n++) {
    const base = every.decode('All', every.encode('All', struct('All'))),
      valid = n % 2 ? every.encode('All', base) : every.encodeDelta('All', mutate('All', base), base),
      bytes = valid.slice();
    switch (n % 4) {
      case 0:
        for (let i = 0; i < bytes.length; i++) bytes[i] = int(256);
        break;
      case 1:
        attempt(() => every.decode('All', bytes.subarray(0, int(bytes.length))));
        bytes[int(bytes.length)] ^= 1 << int(8);
        break;
      case 2:
        bytes[int(bytes.length)] = 255;
        break;
      case 3:
        attempt(() => every.decodeDelta('All', bytes.subarray(0, int(bytes.length)), base));
        break;
    }
    attempt(() => every.decode('All', bytes));
    attempt(() => every.decodeDelta('All', bytes, base));
    attempt(() => decodeEnvelope(bytes));
  }
  assert.ok(refused > 3000 && decoded > 50, `decoded ${decoded}, refused ${refused}`);
  // A count that claims more items than bytes left fails at once instead of allocating.
  attempt(() => every.decode('Item', new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f])));
});

test('encode checks every value against its field and names the fix', () => {
  const base = {
    a: 0,
    b: 0,
    c: 0,
    d: 0,
    e: 0,
    f: 0,
    g: 0,
    h: 0,
    i: 0,
    j: new Uint8Array(),
    entities: new Map(),
    scores: new Map(),
  };
  const bad = [
    [{ a: 256 }, RangeError, /All.a is 256, not an integer from 0 to 255/],
    [{ d: 1.5 }, RangeError, /All.d/],
    [{ g: -1 }, RangeError, /All.g/],
    [{ i: Number.NaN }, RangeError, /finite/],
    [{ i: '1' }, TypeError, /All.i must be a number/],
    [{ j: [1] }, TypeError, /Uint8Array/],
    [{ scores: new Map([[1.5, 1]]) }, RangeError, /id/],
    [{ scores: { 1: 2 } }, TypeError, /Map/],
    [
      {
        entities: new Map([
          [1, { position: { x: 0, y: 0 }, heading: 0, health: 101, kind: 'player', alive: true, items: [] }],
        ]),
      },
      RangeError,
      /outside its quantized range 0..100; widen the range/,
    ],
    [
      {
        entities: new Map([
          [1, { position: { x: 0, y: 0 }, heading: 0, health: 1, kind: 'ghost', alive: true, items: [] }],
        ]),
      },
      RangeError,
      /use one of player, crate, bullet/,
    ],
    [{ scores: new Map(Array.from({ length: 33 }, (_, i) => [i, 0])) }, RangeError, /over its limit of 32/],
  ];
  for (const [change, type, message] of bad)
    assert.throws(
      () => every.encode('All', { ...base, ...change }),
      (e) => e instanceof type && message.test(e.message),
    );
  assert.throws(() => every.encode('Nope', {}), /Schema has no type 'Nope'/);
  assert.throws(() => every.encode('Vec', { x: 3.5e38 * 10, y: 0 }), RangeError);
});

test('defineSchema refuses broken definitions with the fix in the message', () => {
  const cases = [
    [{ types: { box: { x: 'f32' } } }, /capital letter/],
    [{ types: { Box: { X: 'f32' } } }, /lower-case letter/],
    [{ types: { Box: { x: 'float' } } }, /unknown type 'float'/],
    [{ types: { Box: {} } }, /at least one field/],
    [{ types: { Box: { self: 'Box' } } }, /contains itself directly; wrap the reference/],
    [{ types: { Box: { q: { type: 'quantized', min: 1, max: 1, bits: 8 } } } }, /max greater than min/],
    [{ types: { Box: { q: { type: 'quantized', min: 0, max: 1, bits: 1 } } } }, /bits must be an integer from 2 to 32/],
    [{ types: { Box: { e: { type: 'enum', values: ['a', 'a'] } } } }, /twice/],
    [{ types: { Box: { n: { type: 'u8', interpolate: 'linear' } } } }, /integer, which only steps/],
    [{ types: { Box: { s: { type: 'string', maxLength: -1 } } } }, /maxLength must be an integer/],
  ];
  for (const [definition, message] of cases) assert.throws(() => defineSchema(definition), message);
});

test('quantized: min, max and the midpoint are exact; decode refuses steps past the top', () => {
  for (const [min, max, bits] of [
    [-1, 1, 8],
    [-32, 32, 20],
    [0, 100, 10],
    [-1e6, 1e6, 32],
  ])
    for (const v of [min, max, (min + max) / 2])
      assert.equal(dequantize(quantize(v, min, max, bits), min, max, bits), v);
  const schema = defineSchema({ types: { Q: { q: { type: 'quantized', min: -1, max: 1, bits: 8 } } } });
  assert.equal(schema.decode('Q', schema.encode('Q', { q: 0 })).q, 0);
  assert.equal(schema.decode('Q', new Uint8Array([254])).q, 1);
  assert.throws(() => schema.decode('Q', new Uint8Array([255])), /over its top step 254/);
});

test('interpolate blends floats, turns angles the short way and steps everything else', () => {
  const a = {
      position: { x: 0, y: 10 },
      heading: 3,
      health: 0,
      kind: 'player',
      alive: true,
      items: [],
    },
    b = { ...a, position: { x: 10, y: 0 }, heading: -3, health: 100, kind: 'crate', alive: false };
  const mid = every.interpolate('Entity', a, b, 0.5);
  assert.deepEqual(mid.position, { x: 5, y: 5 });
  assert.equal(mid.health, 50);
  assert.ok(Math.abs(Math.abs(mid.heading) - Math.PI) < 1e-12, `heading ${mid.heading}`);
  assert.equal(mid.kind, 'player');
  assert.equal(every.interpolate('Entity', a, b, 1).kind, 'crate');
  const maps = every.interpolate(
    'All',
    {
      scores: new Map([
        [1, 0],
        [2, 0],
      ]),
      entities: new Map(),
    },
    {
      scores: new Map([
        [2, 4],
        [3, 9],
      ]),
      entities: new Map(),
    },
    0.5,
  );
  assert.deepEqual(
    [...maps.scores],
    [
      [2, 0],
      [3, 9],
    ],
  );
  assert.throws(() => every.interpolate('Vec', { x: 0, y: 0 }, { x: 1, y: 1 }, Number.NaN), RangeError);
});

test('hash: the normalized JSON names the format; shorthand and long form agree, any change differs', () => {
  const short = defineSchema({ types: { A: { x: 'f32', n: 'uint' } } }),
    long = defineSchema({ types: { A: { x: { type: 'f32', interpolate: 'linear' }, n: { type: 'uint' } } } }),
    other = defineSchema({ types: { A: { n: 'uint', x: 'f32' } } });
  assert.equal(short.hash, long.hash);
  assert.notEqual(short.hash, other.hash);
  assert.equal(short.hash, fnv1a(JSON.stringify(short.json)));
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.deepEqual(short.json, {
    version: 1,
    types: { A: { x: { type: 'f32', interpolate: 'linear' }, n: { type: 'uint', interpolate: 'none' } } },
  });
});

test('envelope messages round trip and refuse out-of-range fields', () => {
  const messages = [
    { kind: 'hello', version: 1, schema: 2 ** 32 - 1 },
    { kind: 'welcome', player: 7, tickRate: 30, tick: 123456, snapshotEvery: 2 },
    { kind: 'inputs', ack: 5, first: 9, inputs: [new Uint8Array([1]), new Uint8Array([])] },
    { kind: 'snapshot', tick: 10, baseline: 8, input: 12, missed: 3, data: new Uint8Array([4, 5]) },
    { kind: 'ping', time: 1234.5 },
    { kind: 'pong', time: 1234.5, tick: 99, fraction: 0.5 },
    { kind: 'message', type: 2, data: new Uint8Array([1, 2, 3]) },
  ];
  for (const message of messages) assert.deepEqual(decodeEnvelope(encodeEnvelope(message)), message);
  assert.throws(
    () => encodeEnvelope({ kind: 'welcome', player: -1, tickRate: 1, tick: 0, snapshotEvery: 1 }),
    RangeError,
  );
  assert.throws(
    () =>
      encodeEnvelope({ kind: 'inputs', ack: 0, first: 1, inputs: Array.from({ length: 33 }, () => new Uint8Array()) }),
    /at most 32/,
  );
  assert.throws(() => decodeEnvelope(new Uint8Array([99])), /unknown kind 99/);
  assert.throws(() => decodeEnvelope(new Uint8Array([])), RangeError);
});
