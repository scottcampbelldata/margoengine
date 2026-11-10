// Bug (2026-11-10): README.md, docs/README.md, site/index.html, the umbrella README and docs/limits.md each stated a
// different core + stage size, and none matched `npm run measure:size`. Every current size statement in the public
// docs must equal what the build measures.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
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
  text.split('\n').forEach((line, index) => {
    // Markup reads as prose once tags are gone: "<dt>24,209 B gzip</dt><dd>Core plus" becomes one sentence.
    const plain = line.replace(/<\/d[td]><d[td][^>]*>/g, ' ').replace(/<[^>]+>/g, '');
    for (const match of plain.matchAll(phrase)) {
      const end = match.index + match[0].length;
      for (const hit of [...plain.slice(end, end + WINDOW).matchAll(number)].slice(0, 2))
        found.push({ file, line: index + 1, value: hit[0] });
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

  const files = ['README.md', 'docs/README.md', 'site/index.html'];
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
  assert.deepEqual(hit("| core + stage (`import { createStage } from 'x'`) | 24,209 B | 59,802 B |"), ['24,209', '59,802']);
  assert.deepEqual(hit('<dt>23,626 B gzip</dt><dd>Core plus the stage facade, with</dd>'), ['23,626']);
  assert.deepEqual(hit('<h1>starts at 24,209 bytes gzipped.</h1>'), ['24,209']);
  assert.deepEqual(hit('core alone is 21,584 B of its cap', corePhrase), ['21,584']);
  assert.deepEqual(hit('The stage needs core and 1,024 entity slots.'), []);
});
