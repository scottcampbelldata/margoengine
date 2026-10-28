import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { BlockTypes, VoxelChunk, VoxelWorld } from '../dist/index.js';
import {
  applyBlockChanges,
  decodeBlockChanges,
  decodeChunk,
  EntityCodec,
  encodeBlockChanges,
  encodeChunk,
} from '../dist/codec.js';

const CELLS = 32768;
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const cell = (i) => [i & 31, i >> 10, (i >> 5) & 31]; // x, y, z of index x | z << 5 | y << 10
const sameChunk = (a, b, light = true) => {
  for (let i = 0; i < CELLS; i++) {
    if (a.get(...cell(i)) !== b.get(...cell(i))) return `state of cell ${i}`;
    if ((light ? a.getLight(...cell(i)) : 0) !== b.getLight(...cell(i))) return `light of cell ${i}`;
  }
  return '';
};
// Throws unless `run` throws a RangeError whose message starts with `subject` (never an engine error).
const clean = async (run, subject) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof RangeError && error.message.startsWith(subject)) return 'threw';
    throw error;
  }
  return 'ok';
};

// Test-side reader of the uncompressed layout, written from the format description, not from the decoder.
function parse(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const varint = () => {
    let v = 0,
      s = 0,
      b;
    do {
      b = bytes[at++];
      v += (b & 127) * 2 ** s;
      s += 7;
    } while (b & 128);
    return v;
  };
  const version = bytes[at++],
    flags = bytes[at++],
    n = varint(),
    palette = Array.from({ length: n }, varint),
    bits = bytes[at++],
    words = Array.from({ length: 1024 * bits }, (_, i) => view.getUint32(at + 4 * i, true));
  at += 4096 * bits;
  const light = flags & 2 ? bytes.subarray(at, (at += CELLS)) : flags & 1 ? bytes[at++] : 0;
  const state = (i) => palette[bits ? (words[(i * bits) >>> 5] >>> ((i * bits) & 31)) & ((1 << bits) - 1) : 0];
  return { version, flags, bits, palette, light, state, end: at === bytes.length };
}

function chunks() {
  const next = random(11),
    out = { air: new VoxelChunk(), stone: new VoxelChunk(7) };
  const sparse = new VoxelChunk();
  for (let n = 0; n < 12; n++) sparse.set(...cell(Math.floor(next() * CELLS)), 3);
  out.sparse = sparse;
  // k distinct states (spread over the u32 range): 1, 2, 4, 8 and 16-bit indices, the last with 32,768 states.
  for (const k of [2, 3, 5, 17, 257, CELLS]) {
    const chunk = new VoxelChunk();
    for (let i = 0; i < CELLS; i++) chunk.set(...cell(i), ((i % k) * 2654435761) >>> 0);
    out[`states${k}`] = chunk;
  }
  const dense = new VoxelChunk();
  for (let i = 0; i < CELLS; i++) dense.set(...cell(i), Math.floor(next() * 40));
  out.dense = dense;
  return out;
}
function lit(chunk, kind, next) {
  const copy = VoxelChunk.unpack(chunk.pack());
  if (kind === 'uniform') for (let i = 0; i < CELLS; i++) copy.setLight(...cell(i), 0x5a); // a dense array of one byte
  if (kind === 'dense') for (let i = 0; i < CELLS; i++) copy.setLight(...cell(i), Math.floor(next() * 256));
  return copy;
}

test('chunks round-trip at every index width, with uniform, dense or no light, deflated or not', async () => {
  const next = random(3);
  for (const [name, base] of Object.entries(chunks()))
    for (const light of ['none', 'uniform', 'dense']) {
      const chunk = lit(base, light, next),
        raw = await encodeChunk(chunk, { compress: false }),
        deflated = await encodeChunk(chunk),
        p = parse(raw),
        what = `${name}, ${light} light`;
      // The independent reader sees the documented layout.
      assert.equal(p.version, 1, what);
      assert.equal(p.flags, light === 'dense' ? 3 : 1, what);
      assert.ok(p.end, what);
      assert.equal(p.bits, chunk.pack().bits, what);
      for (let i = 0; i < CELLS; i += 7) assert.equal(p.state(i), chunk.get(...cell(i)), `${what}: cell ${i}`);
      assert.equal(typeof p.light === 'number' ? p.light : p.light[100], chunk.getLight(...cell(100)), what);
      // Deflated = flag 4 + deflate-raw (node:zlib, an independent inflater) of the same body.
      assert.equal(deflated[1], p.flags | 4, what);
      assert.deepEqual(new Uint8Array(inflateRawSync(deflated.subarray(2))), raw.subarray(2), what);
      for (const bytes of [raw, deflated]) assert.equal(sameChunk(chunk, await decodeChunk(bytes)), '', what);
      const bare = await encodeChunk(chunk, { light: false, compress: false });
      assert.equal(bare[1], 0, what);
      assert.equal(sameChunk(chunk, await decodeChunk(bare), false), '', `${what} without light`);
    }
  // Sizes: uniform chunks are a few bytes; a uniform light array is stored as its one byte.
  assert.deepEqual(await encodeChunk(new VoxelChunk(), { compress: false }), Uint8Array.of(1, 1, 1, 0, 0, 0));
  assert.equal((await encodeChunk(lit(new VoxelChunk(), 'uniform'), { compress: false })).length, 6);
});

test('a chunk fixture written by hand from the format decodes', async () => {
  // Version 1, flags 1 (one light byte), palette [0, 300] (300 = varint ac 02), 1-bit indices with cells 0 and
  // 33 (x 1, z 1) set: word 0 bit 0, word 1 bit 1; light 0x2f.
  const words = new Uint8Array(4096);
  words[0] = 1;
  words[4] = 2;
  const chunk = await decodeChunk(Uint8Array.of(1, 1, 2, 0, 0xac, 0x02, 1, ...words, 0x2f));
  assert.equal(chunk.get(0, 0, 0), 300);
  assert.equal(chunk.get(1, 0, 1), 300);
  assert.equal(chunk.get(1, 0, 0), 0);
  assert.equal(chunk.getLight(31, 31, 31), 0x2f);
  assert.equal(chunk.pack().bits, 1);
});

test('encodeChunk reads the chunk before it returns', async () => {
  const chunk = new VoxelChunk(5),
    pending = encodeChunk(chunk);
  chunk.fill(6);
  assert.equal((await decodeChunk(await pending)).get(0, 0, 0), 5);
});

test('malformed chunks throw RangeErrors: truncation at every byte, bad headers, bombs, seeded corruption', async () => {
  const subject = 'Chunk data',
    small = new VoxelChunk();
  for (let i = 0; i < 2000; i++) small.set(...cell(i * 13), (i % 3) + 1); // 2-bit indices, one light byte
  const all = chunks(),
    big = lit(all.states32768, 'dense', random(5)),
    encodings = [
      await encodeChunk(small, { compress: false }),
      await encodeChunk(small),
      await encodeChunk(all.dense),
      await encodeChunk(big),
    ];
  // Every cut of the small chunk (raw and deflated); of the larger ones every 97th (997th past 100 KB) and the last 64.
  const huge = await encodeChunk(big, { compress: false });
  for (const [i, bytes] of [...encodings, huge].entries())
    for (let n = 0; n < bytes.length; n += i < 2 || n > bytes.length - 64 ? 1 : bytes.length > 1e5 ? 997 : 97)
      assert.equal(await clean(() => decodeChunk(bytes.subarray(0, n)), subject), 'threw', `${i}: cut at ${n}`);
  assert.equal(sameChunk(big, await decodeChunk(huge)), '');

  const raw = encodings[0],
    edit = (at, ...values) => {
      const b = raw.slice();
      b.set(values, at);
      return b;
    },
    longer = new Uint8Array(raw.length + 1);
  longer.set(raw);
  const bad = {
    version: edit(0, 2),
    flags: edit(1, 9),
    'dense flag without light': edit(1, 2),
    'empty palette': Uint8Array.of(1, 0, 0, 0),
    'palette too big for the width': Uint8Array.of(1, 0, 3, 1, 2, 3, 1, ...new Uint8Array(4096)),
    'odd width': Uint8Array.of(1, 0, 1, 0, 3),
    'varint past 32 bits': Uint8Array.of(1, 0, 1, 0xff, 0xff, 0xff, 0xff, 0x7f, 0),
    'index past the palette': Uint8Array.of(1, 0, 3, 1, 2, 3, 2, 0xff, ...new Uint8Array(8191)),
    'trailing byte': longer,
    oversized: new Uint8Array(300000).fill(1),
    'deflate garbage': Uint8Array.of(1, 4, 0xff, 0xff, 0xff),
    'deflate cut short': encodings[1].subarray(0, encodings[1].length - 3),
    // Node 22's DecompressionStream accepts data after the stream's end; the codec must reject it there too (bug 39).
    'deflate with data after its end': Uint8Array.of(...encodings[1], 0),
  };
  for (const [what, bytes] of Object.entries(bad))
    assert.equal(await clean(() => decodeChunk(bytes), subject), 'threw', what);
  // A deflate bomb: 64 MiB of zeros in 64 KB stops at the largest chunk (262,148 bytes), in little memory.
  const zeros = deflateRawSync(new Uint8Array(64 * 2 ** 20)),
    bomb = new Uint8Array(2 + zeros.length);
  bomb.set([1, 4]);
  bomb.set(zeros, 2);
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(decodeChunk(bomb), /inflates past 262148 bytes/);
  assert.ok(process.memoryUsage().arrayBuffers - before < 32 * 2 ** 20);
  await assert.rejects(decodeChunk([1, 0]), TypeError);

  // Seeded corruption: 1-4 flipped or replaced bytes; every input decodes to a chunk or throws a clean RangeError.
  const next = random(9),
    seen = { ok: 0, threw: 0 };
  for (let n = 0; n < 1500; n++) {
    const source = encodings[n % 3],
      bytes = source.slice();
    for (let k = 1 + Math.floor(next() * 4); k--; ) {
      const at = Math.floor(next() * bytes.length);
      bytes[at] = next() < 0.5 ? bytes[at] ^ (1 << Math.floor(next() * 8)) : Math.floor(next() * 256);
    }
    seen[await clean(() => decodeChunk(bytes), subject)]++;
  }
  assert.ok(seen.threw > 500 && seen.ok > 50, JSON.stringify(seen));
});

test('block changes round-trip sorted, deduplicated (last wins) and compact', () => {
  const next = random(21),
    list = [],
    last = new Map();
  for (let n = 0; n < 5000; n++) {
    // Clustered cells (an explosion, a paste) across chunk borders and negative coordinates, some repeated.
    const x = Math.floor(next() * 96) - 48,
      y = Math.floor(next() * 64) - 32,
      z = Math.floor(next() * 96) - 48,
      state = next() < 0.1 ? (Math.floor(next() * 2 ** 32) >>> 0) | 0 : Math.floor(next() * 20);
    list.push(x, y, z, state);
    last.set(`${x},${y},${z}`, [x, y, z, state | 0]);
  }
  const key = ([x, y, z]) => [x >> 5, y >> 5, z >> 5, (x & 31) | ((z & 31) << 5) | ((y & 31) << 10)],
    expected = [...last.values()]
      .sort((a, b) => {
        const p = key(a),
          q = key(b);
        return p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3];
      })
      .flat(),
    bytes = encodeBlockChanges(list);
  assert.deepEqual([...decodeBlockChanges(bytes)], expected);
  assert.deepEqual(encodeBlockChanges(new Int32Array(list)), bytes);
  assert.ok(bytes.length < 4 * last.size, `${bytes.length} bytes for ${last.size} changes`);
  assert.deepEqual(decodeBlockChanges(encodeBlockChanges([])), new Int32Array(0));
  // Extreme cells: the 32-bit corners.
  const corners = [-(2 ** 31), -32768, 2 ** 31 - 1, 0x80000000, 2 ** 31 - 1, 32767, -(2 ** 31), 1];
  assert.deepEqual([...decodeBlockChanges(encodeBlockChanges(corners))], [...new Int32Array(corners)]);
});

test('a block-change fixture written by hand from the format decodes and re-encodes identically', () => {
  // (-1, 0, 0) = 1 in chunk (-1, 0, 0) cell 31; (1, 2, 3) = 5 and (2, 2, 3) = 6 in chunk (0, 0, 0) cells 2145, 2146.
  // count 3 | step 31*2+1 = 63, chunk +(-1, 0, 0) zigzag 1 0 0, state 1 | step 2145*2+1 = 4291 (c3 21), chunk
  // +(1, 0, 0) zigzag 2 0 0, state 5 | step (2146-2145)*2 = 2, state 6.
  const fixture = Uint8Array.of(3, 63, 1, 0, 0, 1, 0xc3, 0x21, 2, 0, 0, 5, 2, 6);
  assert.deepEqual([...decodeBlockChanges(fixture)], [-1, 0, 0, 1, 1, 2, 3, 5, 2, 2, 3, 6]);
  assert.deepEqual(encodeBlockChanges([2, 2, 3, 6, 1, 2, 3, 5, -1, 0, 0, 1]), fixture);
});

test('applyBlockChanges matches setBlocks on a world, all or nothing', () => {
  const blocks = new BlockTypes();
  for (let i = 1; i < 8; i++) blocks.define(`b${i}`);
  const next = random(4),
    list = [],
    used = new Set(); // distinct cells, so both worlds count the same changes
  for (let n = 0; n < 3000; n++) {
    const x = Math.floor(next() * 80) - 40,
      y = Math.floor(next() * 40),
      z = Math.floor(next() * 80) - 40;
    if (used.has(`${x},${y},${z}`)) continue;
    used.add(`${x},${y},${z}`);
    list.push(x, y, z, Math.floor(next() * 8));
  }
  const a = new VoxelWorld({ blocks }),
    b = new VoxelWorld({ blocks }),
    events = [];
  b.onChange((...args) => events.push(args));
  const changed = a.setBlocks(list);
  assert.equal(applyBlockChanges(b, encodeBlockChanges(list)), changed);
  assert.equal(events.length, changed);
  for (let x = -40; x < 40; x++)
    for (let y = 0; y < 40; y++) for (let z = -40; z < 40; z++) assert.equal(b.getBlock(x, y, z), a.getBlock(x, y, z));
  assert.deepEqual([...b.dirty].sort(), [...a.dirty].sort());
  // An undefined block id fails before any cell changes.
  const before = b.getBlock(0, 0, 0);
  assert.throws(() => applyBlockChanges(b, encodeBlockChanges([0, 0, 0, before ? 0 : 1, 5, 5, 5, 99])), RangeError);
  assert.equal(b.getBlock(0, 0, 0), before);
  assert.throws(() => applyBlockChanges({}, encodeBlockChanges([])), TypeError);
  assert.throws(() => encodeBlockChanges([1, 2, 3]), TypeError);
  assert.throws(() => encodeBlockChanges([0.5, 0, 0, 1]), RangeError);
  assert.throws(() => encodeBlockChanges([0, 0, 0, -0.5]), RangeError);
  assert.throws(() => encodeBlockChanges([0, '1', 0, 1]), TypeError);
});

test('malformed block changes throw RangeErrors: truncation at every byte, bad order, seeded corruption', async () => {
  const next = random(8),
    list = [];
  for (let n = 0; n < 300; n++)
    list.push(Math.floor(next() * 200) - 100, Math.floor(next() * 100), Math.floor(next() * 200) - 100, n);
  const bytes = encodeBlockChanges(list),
    subject = 'Block changes';
  for (let n = 0; n < bytes.length; n++)
    assert.equal(await clean(() => decodeBlockChanges(bytes.subarray(0, n)), subject), 'threw', `cut at ${n}`);
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  for (const [what, b] of Object.entries({
    'trailing byte': longer,
    'count past the bytes': Uint8Array.of(100, 1, 0, 0, 0, 1),
    'no first chunk': Uint8Array.of(1, 2, 1),
    'repeated cell': Uint8Array.of(2, 1, 0, 0, 0, 1, 0, 1),
    'chunks out of order': Uint8Array.of(2, 1, 2, 0, 0, 1, 1, 0, 0, 0, 1),
    'cell index past 32767': Uint8Array.of(1, 0x81, 0x80, 0x04, 0, 0, 0, 1),
    'chunk past the 32-bit cells': Uint8Array.of(1, 1, 0x80, 0x80, 0x80, 0x40, 0, 0, 1),
  }))
    assert.equal(await clean(() => decodeBlockChanges(b), subject), 'threw', what);
  assert.throws(() => decodeBlockChanges([1]), TypeError);
  const seen = { ok: 0, threw: 0 };
  for (let n = 0; n < 3000; n++) {
    const b = bytes.slice();
    for (let k = 1 + Math.floor(next() * 3); k--; ) b[Math.floor(next() * b.length)] = Math.floor(next() * 256);
    seen[await clean(() => decodeBlockChanges(b), subject)]++;
  }
  assert.ok(seen.threw > 1000, JSON.stringify(seen));
});

// Uniform random unit quaternion (Shoemake).
const randomQuat = (next) => {
  const u = next(),
    v = next() * 2 * Math.PI,
    w = next() * 2 * Math.PI,
    a = Math.sqrt(1 - u),
    b = Math.sqrt(u);
  return [a * Math.sin(v), a * Math.cos(v), b * Math.sin(w), b * Math.cos(w)];
};
const angle = (p, q) => 2 * Math.acos(Math.min(1, Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3])));

test('entity positions stay within half a 1/512 step and rotations within the smallest-three bound', () => {
  const codec = new EntityCodec({ position: 'position', rotation: 'rotation' }),
    next = random(17),
    entities = new Map();
  for (let id = 0; id < 20000; id++)
    entities.set(id * 3, {
      position: [(next() - 0.5) * 4e6, (next() - 0.5) * 6e4, (next() - 0.5) * 2],
      rotation: next() < 0.5 ? randomQuat(next) : randomQuat(next).map((c) => -3 * c), // any length or sign
    });
  const decoded = codec.decode(codec.encode(entities));
  let worstPosition = 0,
    worstAngle = 0,
    sumAngle = 0;
  for (const [id, e] of entities) {
    const d = decoded.get(id);
    for (let i = 0; i < 3; i++) worstPosition = Math.max(worstPosition, Math.abs(d.position[i] - e.position[i]));
    const a = angle(
      d.rotation,
      e.rotation.map((c) => c / Math.hypot(...e.rotation)),
    );
    worstAngle = Math.max(worstAngle, a);
    sumAngle += a;
    assert.ok(Math.abs(Math.hypot(...d.rotation) - 1) < 1e-12);
  }
  assert.ok(worstPosition <= 1 / 1024 + 1e-9, `position error ${worstPosition}`);
  // Each of the three small components is within half a step (1 / 511 / sqrt 2 / 2 = 0.00069); the largest, rebuilt
  // from them, adds at most 3x that: |q - q'| <= 2 sqrt(3) * 0.00069, an angle <= 0.0048 rad (0.28 degrees).
  assert.ok(worstAngle < 0.0048, `rotation error ${worstAngle} rad`);
  assert.ok(sumAngle / entities.size < 0.002, `mean rotation error ${sumAngle / entities.size} rad`);
  // Exact cases: the identity, axis rotations, and q and -q as one rotation.
  const exact = new Map([
    [1, { position: [0.5, -2, 1 / 512], rotation: [0, 0, 0, 1] }],
    [2, { position: [0, 0, 0], rotation: [0, 0, 0, -1] }],
    [3, { position: [0, 0, 0], rotation: [1, 0, 0, 0] }],
  ]);
  const back = codec.decode(codec.encode(exact));
  assert.deepEqual(back.get(1), { position: [0.5, -2, 1 / 512], rotation: [0, 0, 0, 1] });
  assert.deepEqual(back.get(2).rotation, [0, 0, 0, 1]);
  assert.deepEqual(back.get(3).rotation, [1, 0, 0, 0]);
});

test('entity deltas send only changed fields and rebuild the sender state tick after tick', () => {
  const schema = { position: 'position', rotation: 'rotation', health: 'u8', anim: 'u16', speed: 'f32' },
    codec = new EntityCodec(schema),
    next = random(29),
    q = (v) => Math.round(v * 512) / 512;
  let sender = new Map(),
    acked = new Map(), // sender's raw copy of what the receiver has
    receiver = new Map(),
    nextId = 0;
  for (let tick = 0; tick < 60; tick++) {
    const now = new Map();
    for (const [id, e] of sender) {
      if (next() < 0.03) continue; // removed
      const moved = next() < 0.5;
      now.set(id, {
        position: moved ? e.position.map((c) => c + (next() - 0.5) * 0.3) : e.position,
        rotation: next() < 0.3 ? randomQuat(next) : e.rotation,
        health: next() < 0.1 ? Math.floor(next() * 256) : e.health,
        anim: next() < 0.1 ? Math.floor(next() * 65536) : e.anim,
        speed: next() < 0.1 ? next() * 10 : e.speed,
      });
    }
    for (let n = Math.floor(next() * 6); n--; )
      now.set((nextId += 1 + Math.floor(next() * 1000)), {
        position: [next() * 1e4, next() * 100, -next() * 1e4],
        rotation: randomQuat(next),
        health: 100,
        anim: 0,
        speed: 0,
      });
    sender = now;
    const bytes = codec.encode(sender, acked),
      decoded = codec.decode(bytes, receiver);
    // Encoding against the receiver's quantized copy instead of the raw one rebuilds the same state.
    assert.deepEqual(codec.decode(codec.encode(sender, receiver), receiver), decoded, `tick ${tick}`);
    receiver = decoded;
    acked = sender;
    assert.deepEqual(
      [...receiver.keys()].sort((a, b) => a - b),
      [...sender.keys()].sort((a, b) => a - b),
    );
    for (const [id, e] of sender) {
      const r = receiver.get(id);
      assert.deepEqual(r.position, e.position.map(q), `tick ${tick} entity ${id}`);
      assert.ok(angle(r.rotation, e.rotation) < 0.0048);
      assert.equal(r.health, e.health);
      assert.equal(r.anim, e.anim);
      assert.equal(r.speed, Math.fround(e.speed));
    }
  }
  // An unchanged snapshot is one byte; one changed u8 is count, id, mask and the byte.
  assert.deepEqual(codec.encode(sender, acked), Uint8Array.of(0));
  const [id, e] = [...sender][0],
    changed = new Map(sender).set(id, { ...e, health: (e.health + 1) & 255 }),
    bytes = codec.encode(changed, sender);
  let idBytes = 1;
  for (let v = id; v > 127; v >>>= 7) idBytes++;
  assert.equal(bytes.length, 3 + idBytes); // count, id varint, mask, value
  assert.equal(codec.decode(bytes, receiver).get(id).health, (e.health + 1) & 255);
});

test('an entity fixture written by hand from the format decodes and re-encodes identically', () => {
  const codec = new EntityCodec({ p: 'position', r: 'rotation', h: 'u8', s: 'u16', f: 'f32' });
  // count 1 | id offset 5 | mask 31 | p (1, -0.5, 2.25) = steps 512, -256, 1152 -> zigzag 1024 (80 08), 511 (ff 03),
  // 2304 (80 12) | r identity: largest w (3 << 30), the others 511: 0xdff7fdff LE | h 7 | s 0x1234 LE | f 1.5 LE.
  const fixture = Uint8Array.of(1, 5, 31, 0x80, 8, 0xff, 3, 0x80, 0x12, 0xff, 0xfd, 0xf7, 0xdf, 7, 0x34, 0x12);
  const f32 = new Uint8Array(new Float32Array([1.5]).buffer),
    bytes = Uint8Array.of(...fixture, ...f32),
    state = { p: [1, -0.5, 2.25], r: [0, 0, 0, 1], h: 7, s: 0x1234, f: 1.5 };
  assert.deepEqual(codec.decode(bytes), new Map([[5, state]]));
  assert.deepEqual(codec.encode(new Map([[5, state]])), bytes);
  // Removal against a baseline: count 1, id offset 5, mask 0.
  assert.deepEqual(codec.encode(new Map(), new Map([[5, state]])), Uint8Array.of(1, 5, 0));
  assert.deepEqual(codec.decode(Uint8Array.of(1, 5, 0), new Map([[5, state]])), new Map());
});

test('entity codec validation and malformed entity data', async () => {
  assert.throws(() => new EntityCodec(), TypeError);
  assert.throws(() => new EntityCodec({}), RangeError);
  assert.throws(() => new EntityCodec({ a: 'vec3' }), TypeError);
  assert.throws(
    () => new EntityCodec(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, 'u8']))),
    RangeError,
  );
  const codec = new EntityCodec({ p: 'position', r: 'rotation', h: 'u8', s: 'u16', f: 'f32' }),
    good = { p: [0, 0, 0], r: [0, 0, 0, 1], h: 0, s: 0, f: 0 },
    one =
      (e, id = 1) =>
      () =>
        codec.encode(new Map([[id, { ...good, ...e }]]));
  assert.throws(() => codec.encode([]), TypeError);
  assert.throws(one({}, -1), RangeError);
  assert.throws(one({}, 2 ** 32), RangeError);
  assert.throws(one({ h: 256 }), RangeError);
  assert.throws(one({ s: 1.5 }), RangeError);
  assert.throws(one({ f: Number.NaN }), RangeError);
  assert.throws(one({ f: 1e39 }), RangeError);
  assert.throws(one({ p: [2 ** 21, 0, 0] }), RangeError);
  assert.throws(one({ p: [0, 0] }), TypeError);
  assert.throws(one({ r: [0, 0, 0, 0] }), RangeError);
  assert.throws(one({ h: '1' }), TypeError);
  assert.throws(() => codec.encode(new Map([[1, null]])), TypeError);
  // Wrong baselines: an update or removal of an entity the baseline lacks.
  const base = new Map([[1, good]]),
    update = codec.encode(new Map([[1, { ...good, h: 9 }]]), base);
  assert.throws(() => codec.decode(update), /baseline lacks/);
  assert.throws(() => codec.decode(codec.encode(new Map(), base)), /baseline lacks/);
  assert.throws(() => codec.decode([1]), TypeError);
  assert.throws(() => codec.decode(Uint8Array.of(0), {}), TypeError);

  const next = random(31),
    world = new Map(),
    later = new Map();
  for (let id = 0; id < 60; id++) {
    world.set(id * 7, {
      p: [next() * 100, next() * 10, next() * 100],
      r: randomQuat(next),
      h: id,
      s: id * 99,
      f: id / 3,
    });
    if (id % 4) later.set(id * 7, { ...world.get(id * 7), h: (id * 3) & 255, p: [id, id, id] });
  }
  const full = codec.encode(world),
    delta = codec.encode(later, world),
    subject = 'Entity data';
  for (const [bytes, baseline] of [
    [full, undefined],
    [delta, world],
  ]) {
    for (let n = 0; n < bytes.length; n++)
      assert.equal(await clean(() => codec.decode(bytes.subarray(0, n), baseline), subject), 'threw', `cut at ${n}`);
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    assert.equal(await clean(() => codec.decode(longer, baseline), subject), 'threw');
  }
  // Against a baseline holding entity 0: each input fails for its own reason.
  for (const [b, reason] of [
    [Uint8Array.of(50, 0, 31), /lists 50 entities/],
    [Uint8Array.of(2, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x0f, 0), /entity id 4294967296/], // removes 0, then id 2^32
    [Uint8Array.of(1, 0, 0x20), /past the schema/],
    [Uint8Array.of(1, 0, 16, 0, 0, 0xc0, 0x7f), /non-finite f/], // f = NaN
    [Uint8Array.of(1, 0, 1, 0xfe, 0xff, 0xff, 0xff, 0x0f, 0, 0), /out of range/], // x + 2^31 - 1 steps
  ])
    assert.throws(
      () => codec.decode(b, new Map([[0, good]])),
      (e) => e instanceof RangeError && e.message.startsWith(subject) && reason.test(e.message),
    );
  const seen = { ok: 0, threw: 0 };
  for (let n = 0; n < 3000; n++) {
    const source = n % 2 ? delta : full,
      b = source.slice();
    for (let k = 1 + Math.floor(next() * 3); k--; ) b[Math.floor(next() * b.length)] = Math.floor(next() * 256);
    seen[await clean(() => codec.decode(b, n % 2 ? world : undefined), subject)]++;
  }
  assert.ok(seen.threw > 1000 && seen.ok > 50, JSON.stringify(seen));
});

test('prepared entities encode to the same bytes as their states, for any receiver', () => {
  const codec = new EntityCodec({ p: 'position', r: 'rotation', h: 'u8', s: 'u16', f: 'f32' }),
    state = (id, t) => {
      const i = id % 1000;
      return {
        p: [i * 1.5 + t * 0.21, 64 - i / 7, -i * 3 + t],
        r: [0, Math.sin(i + t), 0, Math.cos(i + t)],
        h: (i * 13 + t) & 255,
        s: i * 50,
        f: i / 3,
      };
    },
    states = (t, ids) => new Map(ids.map((i) => [i, state(i, t)])),
    prepare = (map) => new Map([...map].map(([id, s]) => [id, codec.prepare(s, id)]));
  for (const [before, after] of [
    [[], [1, 2, 3]],
    [
      [1, 2, 3],
      [2, 3, 900, 4294967295],
    ],
    [
      [5, 6],
      [5, 6],
    ],
  ]) {
    const a = states(0, before),
      b = states(1, after),
      expected = codec.encode(b, before.length ? a : undefined);
    assert.deepEqual(codec.encode(prepare(b), before.length ? prepare(a) : undefined), expected);
    assert.deepEqual(codec.encode(prepare(b), before.length ? a : undefined), expected);
    assert.deepEqual(codec.decode(expected, before.length ? a : undefined).size, after.length);
  }
  // A prepared entity holds the values it had; it belongs to its codec; it checks like encode.
  const s = state(1, 0),
    p = codec.prepare(s, 1);
  s.h = 99;
  assert.deepEqual(codec.encode(new Map([[1, p]])), codec.encode(new Map([[1, state(1, 0)]])));
  const other = new EntityCodec({ p: 'position', r: 'rotation', h: 'u8', s: 'u16', f: 'f32' });
  assert.throws(() => other.encode(new Map([[1, p]])), TypeError);
  assert.throws(() => codec.prepare({ ...state(1, 0), h: 256 }), RangeError);
  assert.throws(() => codec.prepare(null), TypeError);
});
