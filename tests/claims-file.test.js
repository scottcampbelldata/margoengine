import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// docs/whitepaper/claims.md is edited by every lane and merged often. A rebase once left two rows with one number and the
// page's title below the table, and nothing noticed.
const claims = readFileSync('docs/whitepaper/claims.md', 'utf8').replace(/\r\n/g, '\n'),
  limits = readFileSync('docs/limits.md', 'utf8'),
  ids = [...claims.matchAll(/^\| LIM-(\d+) \|/gm)].map((m) => Number(m[1]));

test('claims.md opens with its title and has only that one', () => {
  assert.ok(claims.startsWith('# Claims and evidence\n'), 'the title leads the page');
  assert.equal(claims.match(/^# /gm).length, 1);
});

test('no two limit claims share a number', () => {
  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(id), `LIM-${id} is used twice`);
    seen.add(id);
  }
});

test('no two limit claims say the same thing', () => {
  const seen = new Map();
  for (const [, id, text] of claims.matchAll(/^\| LIM-(\d+) \| ([^|]+) \|/gm)) {
    assert.ok(!seen.has(text), `LIM-${id} repeats LIM-${seen.get(text)}`);
    seen.set(text, id);
  }
});

// A keep-both in a rebase once brought back two rows under new numbers with their old figures, so the text differed.
test('no two limit claims open with the same name', () => {
  const seen = new Map();
  for (const [, id, text] of claims.matchAll(/^\| LIM-(\d+) \| ([^|:]{1,60}): /gm)) {
    assert.ok(!seen.has(text), `LIM-${id} repeats the name of LIM-${seen.get(text)}: ${text}`);
    seen.set(text, id);
  }
});

// A keep-both in a rebase once dropped the voxel block ticks row (LIM-457) and the next lane took over its neighbour's
// number; seven other numbers had gone the same quiet way. A claim that ends stays as a retired row, so every number from
// LIM-001 to the last one is present and a dropped row shows up as a gap.
test('limit claims run from LIM-001 to the last with no number missing', () => {
  const have = new Set(ids),
    missing = [];
  for (let id = 1; id <= Math.max(...ids); id++) if (!have.has(id)) missing.push(`LIM-${String(id).padStart(3, '0')}`);
  assert.deepEqual(missing, [], 'a row was dropped: put it back, or keep its number as a retired row');
});

test('docs/limits.md names the last limit claim', () => {
  const [, last] = /LIM-001 to LIM-(\d+)/.exec(limits);
  assert.equal(Number(last), Math.max(...ids));
});

// docs/limits.md is merged as often. A keep-both in a rebase once left two copies of each of 14 rows ("WebGPU first",
// the FBX, OBJ and exporter rows among them), one copy with a stale size or without another lane's sentence.
test('no table in docs/limits.md holds two rows for one limit', () => {
  const seen = new Map();
  let section = '';
  for (const line of limits.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('#')) section = line;
    const name = /^\| ([^|]+?) \|/.exec(line)?.[1];
    if (!name || name === 'Limit' || /^-+$/.test(name)) continue;
    const key = `${section}\0${name}`;
    assert.ok(!seen.has(key), `docs/limits.md "${section}" has two rows named ${name}`);
    seen.set(key, true);
  }
});

// Rebases that settle a clash in these tables have dropped cells from the end of rows and swallowed a separator into
// a formula, and nothing noticed: a row with the wrong number of cells shows its columns shifted or empty. A separator is
// a pipe that is not escaped (\|) and not inside a code span.
function splitCells(line) {
  const out = [];
  let cell = '',
    code = false;
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cell += '\\|';
      i++;
    } else if (c === '|' && !code) {
      out.push(cell);
      cell = '';
    } else {
      if (c === '`') code = !code;
      cell += c;
    }
  }
  out.push(cell);
  return out.slice(1, -1);
}

function badRows(text) {
  const bad = [];
  let header = 0,
    inTable = false,
    fence = false;
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence || !line.startsWith('|')) {
        inTable = false;
        return;
      }
      const n = splitCells(line).length;
      if (!inTable) {
        inTable = true;
        header = n;
      } else if (n !== header) bad.push(`line ${i + 1}: ${n} cells, header has ${header}: ${line.slice(0, 60)}`);
    });
  return bad;
}

test('the cell counter reads escaped pipes and code spans', () => {
  assert.deepEqual(splitCells('| a | `b | c` | d \\| e |'), [' a ', ' `b | c` ', ' d \\| e ']);
  assert.deepEqual(badRows('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 |\n\n| X |\n| 1 | 2 |\n'), [
    'line 4: 1 cells, header has 2: | 3 |',
    'line 7: 2 cells, header has 1: | 1 | 2 |',
  ]);
});

for (const file of ['docs/whitepaper/claims.md', 'docs/limits.md', 'docs/clean-room.md'])
  test(`every table row in ${file} has as many cells as its header`, () => {
    assert.deepEqual(
      badRows(readFileSync(file, 'utf8')),
      [],
      'a cell was dropped or a pipe in a formula was left bare: restore the cells, never pad',
    );
  });
