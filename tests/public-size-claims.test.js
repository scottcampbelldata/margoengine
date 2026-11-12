// Bug (2026-11-10): README.md, docs/README.md, site/index.html, the umbrella README and docs/limits.md each stated a
// different core + stage size, and none matched `npm run measure:size`. Every current size statement in the public
// docs must equal what the build measures.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { documents } from '../scripts/docs-links.mjs';
import { measureCore, measureCoreStage } from '../scripts/measure-size.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ceiling = /const CORE_ONLY_CEILING = ([\d_]+);/.exec(read('scripts/build-modern.js'));
assert.ok(ceiling, 'scripts/build-modern.js still names CORE_ONLY_CEILING');
const CORE_ONLY_CEILING = Number(ceiling[1].replaceAll('_', ''));

const stagePhrase = /core\s*(?:\+|plus|and)\s*(?:the\s*)?stage|(?:starts|starting) at/gi;
const corePhrase = /core alone/gi;
const number = /\b\d{2},\d{3}\b|\b\d{5}\b/g;
const WINDOW = 110;

/** Five-digit sizes that follow `phrase` on its line (two at most), or precede it as "N B gzip", with file and line. */
function sizeClaims(text, file, phrase) {
  const found = [];
  // Markup reads as prose once tags are gone: "<dt>24,209 B gzip</dt><dd>Core plus" becomes one sentence.
  // Table cells too: "<td>61,345</td><td>24,848</td>" must not read as the one number 61,34524,848.
  const prose = (line = '') =>
    line.replace(/<\/(?:d[td]|t[dh])>\s*<(?:d[td]|t[dh])[^>]*>/g, ' ').replace(/<[^>]+>/g, '');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    // A wrapped paragraph puts the figure on the next line ("The core and the stage" / "together measure 24,630"), so
    // the window runs on into it; only a phrase that starts on this line counts, so no claim is found twice.
    const own = prose(line),
      plain = `${own} ${prose(lines[index + 1])}`;
    for (const match of plain.matchAll(phrase)) {
      if (match.index >= own.length) continue;
      const end = match.index + match[0].length;
      // The window stops where the phrase starts again: those figures are the next claim's.
      let window = plain.slice(end, end + WINDOW);
      const again = new RegExp(phrase.source, 'i').exec(window);
      if (again) window = window.slice(0, again.index);
      for (const hit of [...window.matchAll(number)].slice(0, 2)) found.push({ file, line: index + 1, value: hit[0] });
      const from = Math.max(0, match.index - 30);
      const before = [...plain.slice(from, match.index).matchAll(number)].pop();
      // Only within one sentence: "caves.wasm 11564 B gzip. Core plus stage 24432 B" is not the stage's figure.
      const between = before ? plain.slice(from + before.index + before[0].length, match.index) : '';
      if (before && /^\s*(?:B|bytes)\b/.test(between) && !/[.;:]\s/.test(between))
        found.push({ file, line: index + 1, value: before[0] });
    }
  });
  return found;
}

const digits = (value) => Number(value.replace(',', ''));

test('every core + stage size in the public docs equals what measure:size prints', async () => {
  const { raw, gzip } = await measureCoreStage();
  const core = await measureCore();
  const allowed = new Set([raw, gzip, 25_000, core.raw, core.gzip, CORE_ONLY_CEILING]);

  const files = ['README.md', 'docs/README.md', 'docs/start-here.md', 'docs/api-overview.md', 'site/index.html'];
  // Bug (2026-11-12): the engine whitepaper page said 21,974 B in six places while the build measured 24,848 B.
  files.push('site/whitepaper/engine.html');
  for (const entry of readdirSync(new URL('../docs/guides/', import.meta.url)))
    if (entry.endsWith('.md')) files.push(`docs/guides/${entry}`);
  for (const entry of readdirSync(new URL('../packages/', import.meta.url), { withFileTypes: true }))
    if (entry.isDirectory()) files.push(`packages/${entry.name}/README.md`);

  const claims = [];
  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
      continue; // a package without a README
    }
    claims.push(...sizeClaims(text, file, stagePhrase), ...sizeClaims(text, file, corePhrase));
  }
  // docs/limits.md and the claims table keep dated history; only the lines that state the current figure are held to it.
  for (const [file, pattern] of [
    ['docs/limits.md', /^Margo is a small WebGPU engine/],
    ['docs/whitepaper/claims.md', /^\| LIM-001 \|/],
    ['docs/whitepaper/claims.md', /^\| Core \+ stage is /],
    ['docs/whitepaper/claims.md', /^\| Core \+ stage is /],
  ]) {
    const lines = read(file).split('\n');
    const at = lines.findIndex((line) => pattern.test(line));
    assert.ok(at >= 0, `${file} still has its current-size line`);
    // Only the lead is current; a bracketed "(2026-11-09: ...)" note after it is dated history.
    const lead = lines[at].split(/ ?\(2026-/)[0];
    for (const phrase of [stagePhrase, corePhrase])
      claims.push(...sizeClaims(lead, file, phrase).map((claim) => ({ ...claim, line: at + 1 })));
  }
  assert.ok(claims.length >= 8, `the scan found ${claims.length} size claims`);

  // Bug (2026-11-12): the engine comparison table's Margo row stayed at 24,204 B (and "1.0.0") after core grew. Its
  // whole-package column (b) is the umbrella's main entry, which bundles to the core + stage figure.
  const row = read('docs/whitepaper/claims.md')
    .split('\n')
    .find((line) => line.startsWith('| Margo (`createStage` + box) |'));
  assert.ok(row, 'claims.md still has the Margo row of the engine size comparison');
  const cells = row.split('|').map((cell) => cell.trim());
  claims.push({ file: 'docs/whitepaper/claims.md', line: 0, value: cells[4] });
  assert.match(cells[2], /^main at [0-9a-f]{7,}/, 'the Margo row names the commit it was measured at');

  const stale = claims.filter((claim) => !allowed.has(digits(claim.value)));
  assert.deepEqual(
    stale.map((claim) => `${claim.file}:${claim.line} says ${claim.value}`),
    [],
    `measured: core + stage ${gzip} B gzip / ${raw} B raw, core ${core.gzip} B gzip / ${core.raw} B raw`,
  );

  const record = JSON.parse(read('examples/package-benchmarks/results/entry-sizes.json'));
  assert.deepEqual([record.coreStage.raw, record.coreStage.gzip], [raw, gzip], 'entry-sizes.json coreStage');
});

test('the size scan reads prose, tables and tag soup, and ignores unrelated numbers', () => {
  const hit = (text, phrase = stagePhrase) => sizeClaims(text, 'f', phrase).map((claim) => claim.value);
  assert.deepEqual(hit('The core and the stage together are 24,209 bytes gzip, Wasm.'), ['24,209']);
  assert.deepEqual(hit("| core + stage (`import { createStage } from 'x'`) | 24,209 B | 59,802 B |"), [
    '24,209',
    '59,802',
  ]);
  assert.deepEqual(hit('<dt>23,626 B gzip</dt><dd>Core plus the stage facade, with</dd>'), ['23,626']);
  assert.deepEqual(hit('<h1>starts at 24,209 bytes gzipped.</h1>'), ['24,209']);
  assert.deepEqual(hit('core alone is 21,584 B of its cap', corePhrase), ['21,584']);
  assert.deepEqual(hit('The stage needs core and 1,024 entity slots.'), []);
  // Bug (2026-11-12): docs/README.md wrapped "The core and the stage" and its figures onto two lines, so the per-line
  // scan never saw the stale 24,630; docs/start-here.md was not scanned at all and said 23,626.
  assert.deepEqual(hit('The core and the stage\ntogether measure **60,792 bytes raw / 24,630 bytes gzip**.'), [
    '60,792',
    '24,630',
  ]);
  assert.deepEqual(hit('core + stage 24,209 B\nand core + stage 24,848 B'), ['24,209', '24,848']);
});

// Bug (2026-11-12): docs/demo-loading.md, docs/desktop-frame-rate.md, MODERN-ENGINE.md and benchmarks/README.md each
// said "the current build measures core at ... and core plus stage at ...", with figures from weeks before. A page that
// calls a size current states the measured one, or points at `npm run measure:size` instead of a number.
test('a reader page that calls a core size current states the measured figure', async () => {
  const { raw, gzip } = await measureCoreStage();
  const core = await measureCore();
  const allowed = new Set([raw, gzip, 25_000, core.raw, core.gzip, CORE_ONLY_CEILING]);
  const current = /\b(?:the current (?:consolidated )?build measures|currently measures)\b/i;
  const stale = [];
  for (const file of [...documents(), 'benchmarks/README.md']) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      if (!current.test(line)) return;
      const text = `${line}\n${lines[index + 1] ?? ''}`;
      for (const claim of [...sizeClaims(text, file, stagePhrase), ...sizeClaims(text, file, corePhrase)])
        if (claim.line === 1 && !allowed.has(digits(claim.value)))
          stale.push(`${file}:${index + 1} says ${claim.value}`);
    });
  }
  assert.deepEqual(stale, [], `measured: core + stage ${gzip} B gzip, core ${core.gzip} B gzip`);
});
