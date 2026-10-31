// The square in plaza=1 worlds: the exact sign, read back from generated chunks, and worlds without plaza=1 unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelChunk } from '@margoengine/voxel';
import { defineBlocks } from '../src/blocks.ts';
import { sandboxGenerator } from '../src/plants.ts';
import {
  isPlazaProtected,
  isPlazaSpawnClear,
  PLAZA_GLYPH_ROWS,
  PLAZA_GLYPHS,
  PLAZA_RADIUS,
  PLAZA_SIGN,
  PLAZA_SIGN_LINES,
  PLAZA_SIGN_SCALE,
  PLAZA_SIGN_STEP,
  PLAZA_WALL_HALF,
  PLAZA_WALL_TOP,
  PLAZA_WALL_Z,
  plazaFloor,
  plazaGenerator,
  plazaSignBase,
  plazaSignLeft,
  plazaSpawnRing,
} from '../src/plaza.ts';

const { blocks } = defineBlocks(),
  context = { blocks: blocks.table },
  SEED = 12345,
  floor = plazaFloor(SEED, blocks.table),
  generate = plazaGenerator(sandboxGenerator(SEED), SEED);

// Generates the chunks a cell falls in, once each.
function worldReader(generator) {
  const chunks = new Map();
  return async (x, y, z) => {
    const cx = x >> 5,
      cy = y >> 5,
      cz = z >> 5,
      key = `${cx},${cy},${cz}`;
    if (!chunks.has(key)) {
      const chunk = new VoxelChunk();
      await generator(chunk, cx, cy, cz, context);
      chunks.set(key, chunk);
    }
    return chunks.get(key).get(x & 31, y & 31, z & 31) & 0xffff;
  };
}

test('the sign is the exact dedication, heart and variation selector included', () => {
  assert.equal(PLAZA_SIGN, 'Margo engine ❤️ made for Margie');
  assert.equal(PLAZA_SIGN_LINES.join(' '), PLAZA_SIGN);
});

// A glyph padded to the full row count, as the sign stamps it.
const padded = (glyph) => [...glyph, ...Array(PLAZA_GLYPH_ROWS - glyph.length).fill('00000')];

test('generated chunks spell the sign, in glowstone letters and a red heart, in order', async () => {
  const read = worldReader(generate),
    FACE = PLAZA_WALL_Z + 1,
    glowstone = blocks.id('glowstone'),
    heart = blocks.id('heart_red'),
    S = PLAZA_SIGN_SCALE,
    text = [];
  for (const [row, line] of PLAZA_SIGN_LINES.entries()) {
    const chars = [...line].filter((c) => c !== '️'),
      left = plazaSignLeft(chars.length),
      base = plazaSignBase(row);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const rows = [];
      let hearts = 0;
      for (let y = 0; y < PLAZA_GLYPH_ROWS; y++) {
        let bits = '';
        for (let x = 0; x < 5; x++) {
          // The pixel's lower-left block; every block of a scaled pixel must agree.
          const first = await read(left + i * PLAZA_SIGN_STEP + x * S, floor + base + (6 - y) * S, FACE),
            last = await read(left + i * PLAZA_SIGN_STEP + x * S + S - 1, floor + base + (6 - y) * S + S - 1, FACE);
          assert.equal(first, last);
          if (first === heart) hearts++;
          bits += first === glowstone || first === heart ? '1' : '0';
        }
        rows.push(bits);
      }
      const found = Object.entries(PLAZA_GLYPHS).find(([, glyph]) => padded(glyph).join() === rows.join());
      if (rows.every((bits) => bits === '00000')) out += ' ';
      else {
        assert.ok(found, `line ${row} character ${i} is no glyph: ${rows.join('/')}`);
        assert.equal(hearts > 0, found[0] === '❤', 'only the heart is red');
        out += found[0] === '❤' ? '❤️' : found[0];
      }
    }
    text.push(out);
  }
  assert.equal(text.join(' '), PLAZA_SIGN);
  assert.equal(text[0], 'Margo engine');
  assert.equal(text[2], 'Margie');
});

test('the g has a descender and an x-height bowl, so it does not read as a 9', () => {
  const NINE = ['01110', '10001', '10001', '01111', '00001', '10001', '01110'],
    g = padded(PLAZA_GLYPHS.g),
    o = padded(PLAZA_GLYPHS.o);
  assert.notDeepEqual(g, padded(NINE));
  assert.notDeepEqual(g.slice(0, 7), NINE, 'not a 9 even above the baseline');
  assert.ok(
    g.slice(7).some((bits) => bits.includes('1')),
    'pixels under the baseline',
  );
  assert.ok(g.slice(7).filter((bits) => bits.includes('1')).length >= 2, 'a real tail, two rows');
  assert.deepEqual(g.slice(0, 3), o.slice(0, 3), 'the bowl starts at the x-height of an o');
  // Nothing clips: the lowest pixel row stays above the floor, for every line.
  assert.ok(plazaSignBase(PLAZA_SIGN_LINES.length - 1) - (PLAZA_GLYPH_ROWS - 7) * PLAZA_SIGN_SCALE >= 1);
  // The tail of a line's g stays clear of the line under it.
  assert.ok(plazaSignBase(0) - (PLAZA_GLYPH_ROWS - 7) * PLAZA_SIGN_SCALE > plazaSignBase(1) + 6 * PLAZA_SIGN_SCALE);
});

test('no solid block hides any sign cell from the far side of the disc, whatever the seed', async () => {
  const solid = new Set(blocks.table.filter((b) => b.solid).map((b) => b.id));
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const f = plazaFloor(seed, blocks.table),
      read = worldReader(plazaGenerator(sandboxGenerator(seed), seed)),
      // Every column of the footprint, once, so the reader has the chunks.
      cells = [];
    for (let line = 0; line < PLAZA_SIGN_LINES.length; line++)
      for (let up = plazaSignBase(line); up < plazaSignBase(line) + 7 * PLAZA_SIGN_SCALE; up += 3)
        for (let x = -PLAZA_WALL_HALF; x <= PLAZA_WALL_HALF; x += 4) cells.push([x, up]);
    const eyes = [];
    for (let a = 0; a <= 6; a++) {
      const angle = (a / 6) * Math.PI; // the far half of the rim, +z
      eyes.push([Math.cos(angle) * (PLAZA_RADIUS - 0.5), Math.sin(angle) * (PLAZA_RADIUS - 0.5)]);
    }
    const front = PLAZA_WALL_Z + 2; // the letters' face towards the disc
    for (const [ex, ez] of eyes)
      for (const [x, up] of cells) {
        const from = [ex, f + 2.6, ez],
          to = [x + 0.5, f + up + 0.5, front],
          steps = Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) * 2);
        for (let i = 0; i < steps; i++) {
          const t = i / steps,
            px = Math.floor(from[0] + (to[0] - from[0]) * t),
            py = Math.floor(from[1] + (to[1] - from[1]) * t),
            pz = Math.floor(from[2] + (to[2] - from[2]) * t);
          if (pz <= PLAZA_WALL_Z + 1) break; // the sign's own plane
          assert.ok(
            !solid.has(await read(px, py, pz)),
            `seed ${seed}: ${px},${py - f},${pz} hides sign cell ${x},${up} from ${ex.toFixed(1)},${ez.toFixed(1)}`,
          );
        }
      }
  }
});

test('the disc is stone with open air above, and its foundation has no holes', async () => {
  const read = worldReader(generate),
    stone = blocks.id('stone');
  for (const [x, z] of [
    [0, 0],
    [PLAZA_RADIUS, 0],
    [-PLAZA_RADIUS, 0],
    [0, PLAZA_RADIUS],
    [17, 16],
  ]) {
    assert.equal(await read(x, floor, z), stone, `floor at ${x},${z}`);
    assert.equal(await read(x, floor - 20, z), stone, `foundation at ${x},${z}`);
    for (const up of [1, 2, 12, 40]) assert.equal(await read(x, floor + up, z), 0, `air ${up} over ${x},${z}`);
  }
});

test('the ceiling a chunk returns covers the wall, and columns away from the square keep the terrain', async () => {
  const plain = sandboxGenerator(SEED),
    chunk = new VoxelChunk();
  const ceiling = await generate(chunk, 0, 10, -1, context);
  assert.ok(ceiling >= floor + PLAZA_WALL_TOP, `ceiling ${ceiling}, wall top ${floor + PLAZA_WALL_TOP}`);
  const a = new VoxelChunk(),
    b = new VoxelChunk(),
    [ca, cb] = [await generate(a, 9, 0, 9, context), await plain(b, 9, 0, 9, context)];
  assert.equal(ca, cb);
  assert.deepEqual(a.pack().words, b.pack().words);
});

test('protected cells: the disc to 12 up, the wall to its top, not past them', () => {
  assert.ok(isPlazaProtected(0, floor, 0, floor), 'floor');
  assert.ok(isPlazaProtected(0, floor + 12, 23, floor), 'edge of the disc, 12 up');
  assert.ok(!isPlazaProtected(0, floor + 13, 23, floor), '13 up');
  assert.ok(isPlazaProtected(30, floor + 13, -5, floor), 'before the wall, outside the disc, up to the wall top');
  assert.ok(!isPlazaProtected(45, floor + 1, 0, floor), '45 blocks out');
  assert.ok(!isPlazaProtected(0, floor + 1, 30, floor), '30 blocks out, other side');
  assert.ok(isPlazaProtected(PLAZA_WALL_HALF, floor + PLAZA_WALL_TOP, PLAZA_WALL_Z, floor), 'the wall, far corner');
  assert.ok(isPlazaProtected(0, floor + PLAZA_WALL_TOP, PLAZA_WALL_Z + 2, floor), 'before the letters');
  assert.ok(isPlazaProtected(0, floor + 5, PLAZA_WALL_Z - 1, floor), 'behind the wall');
});

test('nobody spawns on the disc or in the wall', () => {
  assert.equal(isPlazaSpawnClear(0, 0), false);
  assert.equal(isPlazaSpawnClear(PLAZA_WALL_HALF, PLAZA_WALL_Z), false);
  assert.equal(isPlazaSpawnClear(0, 50), true);
});

test('the spawn ring is 40 to 60 blocks out, clear of the sign, dry, and the same for a seed', () => {
  let dry = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const ring = plazaSpawnRing(seed, blocks.table);
    assert.deepEqual(ring, plazaSpawnRing(seed, blocks.table));
    dry += ring.length;
    for (const [x, z] of ring) {
      const radius = Math.hypot(x, z);
      assert.ok(radius >= 39 && radius <= 61, `radius ${radius}`);
      assert.ok(isPlazaSpawnClear(x, z), `${x},${z}`);
    }
  }
  assert.ok(dry > 0);
  // A dry column has rock above the sea at its highest point, which is where the server puts a player.
  const seed = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => plazaSpawnRing(s, blocks.table).length),
    plain = sandboxGenerator(seed),
    water = blocks.id('water');
  const [x, z] = plazaSpawnRing(seed, blocks.table)[0];
  return (async () => {
    const read = worldReader(plain);
    for (let y = 1; y < 8; y++) assert.notEqual(await read(x, y, z), water, `no water at ${x},${y},${z}`);
  })();
});

test('a world always gets the same floor, above the sea', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const y = plazaFloor(seed, blocks.table);
    assert.equal(y, plazaFloor(seed, blocks.table));
    assert.ok(y >= 2 && y < 96, `seed ${seed}: floor ${y}`);
  }
});
