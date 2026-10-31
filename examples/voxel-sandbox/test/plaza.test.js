// The square in plaza=1 worlds: the exact sign, read back from generated chunks, and worlds without plaza=1 unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelChunk } from '@margoengine/voxel';
import { defineBlocks } from '../src/blocks.ts';
import { sandboxGenerator } from '../src/plants.ts';
import {
  isPlazaProtected,
  isPlazaSpawnClear,
  PLAZA_GLYPHS,
  PLAZA_RADIUS,
  PLAZA_SIGN,
  PLAZA_SIGN_LINES,
  PLAZA_WALL_HALF,
  PLAZA_WALL_TOP,
  PLAZA_WALL_Z,
  plazaFloor,
  plazaGenerator,
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

test('generated chunks spell the sign, in glowstone letters and a red heart', async () => {
  const read = worldReader(generate),
    FACE = PLAZA_WALL_Z + 1,
    glowstone = blocks.id('glowstone'),
    heart = blocks.id('heart_red'),
    text = [];
  for (const [row, line] of PLAZA_SIGN_LINES.entries()) {
    const chars = [...line].filter((c) => c !== '️'),
      left = -Math.floor((chars.length * 6 - 1) / 2),
      base = 2 + (PLAZA_SIGN_LINES.length - 1 - row) * 8;
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const rows = [];
      let hearts = 0;
      for (let y = 0; y < 7; y++) {
        let bits = '';
        for (let x = 0; x < 5; x++) {
          const cell = await read(left + i * 6 + x, floor + base + 6 - y, FACE);
          if (cell === heart) hearts++;
          bits += cell === glowstone || cell === heart ? '1' : '0';
        }
        rows.push(bits);
      }
      const found = Object.entries(PLAZA_GLYPHS).find(([, glyph]) => glyph.join() === rows.join());
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
  assert.ok(isPlazaProtected(23, floor + 12, 0, floor), 'edge of the disc, 12 up');
  assert.ok(!isPlazaProtected(23, floor + 13, 0, floor), '13 up');
  assert.ok(!isPlazaProtected(30, floor + 1, 0, floor), '30 blocks out');
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
