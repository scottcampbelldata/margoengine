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

// A lane's renumbering once rewrote "(LIM-494)" on every line of docs/limits.md, so the shape queries row named the
// ground projected environment's claim (LIM-498). A row whose name ends in its claim number names that claim.
test('a docs/limits.md row tagged with a claim number names that claim', () => {
  const names = new Map([...claims.matchAll(/^\| LIM-(\d+) \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].toLowerCase()]));
  for (const line of limits.replace(/\r\n/g, '\n').split('\n')) {
    const cell = /^\| ([^|]+?) \|/.exec(line)?.[1],
      id = cell && /\(LIM-(\d+)\)\s*$/.exec(cell)?.[1];
    if (!id) continue;
    const name = cell
      .replace(/\s*\(LIM-\d+\)\s*$/, '')
      .replace(/\s*\([^()]*\)\s*$/, '')
      .trim();
    assert.ok(
      names.get(id)?.startsWith(name.toLowerCase()),
      `docs/limits.md "${name}" is tagged LIM-${id}, a claim about something else`,
    );
  }
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

// A lane's docs helper once looked for the last claim with a pattern that matched the empty string at the top of the
// page, so LIM-502 and S67 landed on line 2, above the page text and every table header; the next jobs put their rows
// after those, and the cell count above took the stray rows for a table of their own. A table is a header row, then its
// separator row, then body rows: rows before the header, rows with no header and separator, and a second separator
// are rows outside their table.
function strayRows(text) {
  const stray = [],
    isSeparator = (line) => /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
  let fence = false,
    block = [];
  const flush = () => {
    const first = block.findIndex(([, line]) => isSeparator(line)),
      header = first - 1;
    block.forEach(([n, line], k) => {
      if (first < 0 || k < header || (k > first && isSeparator(line)) || (first === 0 && k === 0))
        stray.push(`line ${n}: ${line.slice(0, 60)}`);
    });
    block = [];
  };
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (!fence && line.startsWith('|')) block.push([i + 1, line]);
      else flush();
    });
  flush();
  return stray;
}

test('the stray-row finder sees rows above a header and rows with no table', () => {
  assert.deepEqual(strayRows('| A | B |\n| --- | --- |\n| 1 | 2 |\n'), []);
  assert.deepEqual(strayRows('# T\n| 9 | x |\n\nText.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'), [
    'line 2: | 9 | x |',
  ]);
  assert.deepEqual(strayRows('| 9 | x |\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'), ['line 1: | 9 | x |']);
  assert.deepEqual(strayRows('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4 |\n'), ['line 5: | 3 | 4 |']);
  assert.deepEqual(strayRows('| A |\n| --- |\n| 1 |\n| --- |\n'), ['line 4: | --- |']);
  assert.deepEqual(strayRows('```\n| 1 |\n```\n'), []);
});

for (const file of ['docs/whitepaper/claims.md', 'docs/limits.md', 'docs/clean-room.md'])
  test(`every table row in ${file} sits in a table, under its header`, () => {
    assert.deepEqual(
      strayRows(readFileSync(file, 'utf8')),
      [],
      'a row sits outside its table: move it into the table it belongs to, in number order',
    );
  });

// A rebase helper once re-added a clean-room row beside main's row of the same id (two S70 rows in the sky table), and
// every check passed: the cell and stray-row checks see a well-formed row, and claims.md only numbers LIM ids. An id is
// the first cell of a body row (S70, SP3, EX12). Separate tables may reuse a prefix (the sprites and exporters tables
// each have their own SP and EX series), so an id must be unique within its table.
function repeatedIds(text) {
  const out = [];
  let fence = false,
    seen = null;
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence || !line.startsWith('|')) {
        seen = null;
        return;
      }
      seen ??= new Map();
      const id = /^\|\s*([A-Z]+\d+[a-z]?)\s*\|/.exec(line)?.[1];
      if (!id) return;
      if (seen.has(id)) out.push(`line ${i + 1}: ${id} again (first on line ${seen.get(id)})`);
      else seen.set(id, i + 1);
    });
  return out;
}

test('the repeated-id finder sees two rows with one id in a table, and allows one id in two tables', () => {
  const table = (...rows) => `| id | formula |\n| --- | --- |\n${rows.map((r) => `| ${r} | x |`).join('\n')}\n`;
  assert.deepEqual(repeatedIds(table('S69', 'S70', 'S71')), []);
  assert.deepEqual(repeatedIds(table('S69', 'S70', 'S70')), ['line 5: S70 again (first on line 4)']);
  assert.deepEqual(repeatedIds(`${table('SP1')}\n### other\n\n${table('SP1')}`), []);
  assert.deepEqual(repeatedIds('```\n| S1 | a |\n| S1 | b |\n```\n'), []);
});

test('no table in docs/clean-room.md holds two rows with one id', () => {
  assert.deepEqual(
    repeatedIds(readFileSync('docs/clean-room.md', 'utf8')),
    [],
    "two clean-room rows share an id: keep main's row and give the added row the next free id in its table",
  );
});

test('every limit claim row sits in the design envelope table of claims.md', () => {
  const section = claims.split(/^## /m).find((s) => s.startsWith('Design envelope'));
  assert.equal((section.match(/^\| LIM-\d+ \|/gm) ?? []).length, ids.length, 'a LIM row sits outside its section');
});

// Lane renumbering helpers once rewrote "(LIM-n)" inside rows of docs/limits.md that other jobs had written, so the
// WebGL2 compatibility layer's terrain row cited the dynamic GI claim (LIM-504) and the anti-aliased splats row cited
// mesh to terrain blending (LIM-502). A row names its subject in its first cell, by package (`@margoengine/terrain`)
// or else by API (`Splats.antialias`); every claim it cites names that package (or a file under packages/<name>/) or
// that API too. A row that names neither is not checked, and two claims of one package can still be swapped unseen.
function subjects(text, apis) {
  const packages = new Set(
    [...text.matchAll(/@margoengine\/([a-z0-9-]+)|\bpackages\/([a-z0-9-]+)\//g)].map(
      (m) => `@margoengine/${m[1] ?? m[2]}`,
    ),
  );
  if (packages.size || !apis) return packages;
  return new Set([...text.matchAll(/`([A-Za-z_]\w*)/g)].map((m) => m[1]));
}

function wrongCitations(limitsText, claimsText) {
  const rows = new Map(
    [...claimsText.replace(/\r\n/g, '\n').matchAll(/^\| LIM-(\d+) \|(.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  const wrong = [];
  for (const line of limitsText.replace(/\r\n/g, '\n').split('\n')) {
    const cell = /^\| ([^|]+?) \|/.exec(line)?.[1];
    if (!cell) continue;
    const want = subjects(cell, true);
    if (!want.size) continue;
    for (const [, id] of line.replace(/LIM-001 to LIM-\d+/g, '').matchAll(/LIM-(\d+)/g)) {
      const claim = rows.get(id) ?? '',
        have = [...want][0].startsWith('@') ? subjects(claim) : new Set(claim.match(/\w+/g));
      if (![...want].some((s) => have.has(s))) wrong.push(`"${cell.slice(0, 50)}" cites LIM-${id}`);
    }
  }
  return wrong;
}

test('the citation check sees a limits row citing another subject', () => {
  const c =
    '| LIM-001 | Blend: `Blend` in `@margoengine/terrain/blend` |\n| LIM-002 | GI: `GI` in `@margoengine/environment` |\n';
  assert.deepEqual(wrongCitations('| Terrain blend (`@margoengine/terrain/blend`) | x (LIM-001). |\n', c), []);
  assert.deepEqual(wrongCitations('| Terrain blend (`@margoengine/terrain`) | x (LIM-002). |\n', c), [
    '"Terrain blend (`@margoengine/terrain`)" cites LIM-002',
  ]);
  assert.deepEqual(wrongCitations('| Blending (`Blend.attach`) | x (LIM-002). |\n', c), [
    '"Blending (`Blend.attach`)" cites LIM-002',
  ]);
  assert.deepEqual(wrongCitations('| Browsers | x (LIM-002). |\n', c), []);
});

test('every claim a docs/limits.md row cites is about its subject', () => {
  assert.deepEqual(
    wrongCitations(limits, claims),
    [],
    'a limits row cites a claim about something else: cite the claim of its own package or API',
  );
});
