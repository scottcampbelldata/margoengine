// KB-TEST-LCG1: `seed * 1103515245` passes 2^53, where a float drops the low bits that `>>> 0` or a mask keeps, so the
// generator repeats early and a test drawing many random cases from it checks the same few again. `Math.imul` keeps
// those bits. One check per file that holds the multiplier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)),
  self = 'tests/lcg-generators.test.js',
  multiplier = '1103515245',
  kinds = ['*.js', '*.mjs', '*.cjs', '*.ts', '*.mts', '*.html'],
  // The product kept in 32 bits: the multiplier is an argument of Math.imul.
  integerProduct = /Math\.imul\(\s*(?:[\w$.]+\s*,\s*)?$/;

const files = execFileSync('git', ['grep', '--untracked', '-l', '-F', multiplier, '--', ...kinds], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1 << 24,
})
  .split('\n')
  // Pages filed with browser vendors stay as they were filed.
  .filter((file) => file && file !== self && !file.startsWith('docs/') && !file.startsWith('site/'));

test('the float product repeats early and the integer product does not', () => {
  const period = (step) => {
    const seen = new Set();
    let seed = 3;
    for (let draw = 0; draw < 20000; draw++) {
      seed = step(seed);
      if (seen.has(seed)) return draw;
      seen.add(seed);
    }
    return Infinity;
  };
  assert.ok(period((seed) => (seed * 1103515245 + 12345) >>> 0) < 10000);
  assert.equal(
    period((seed) => (Math.imul(seed, 1103515245) + 12345) >>> 0),
    Infinity,
  );
  assert.equal(
    period((seed) => (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff),
    Infinity,
  );
});

test('the search finds the files that draw from this generator', () => assert.ok(files.length > 40));

for (const file of files)
  test(`${file} multiplies its generator state with Math.imul`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
      floats = [];
    for (let at = source.indexOf(multiplier); at >= 0; at = source.indexOf(multiplier, at + 1))
      if (!integerProduct.test(source.slice(Math.max(0, at - 80), at)))
        floats.push(source.slice(0, at).split('\n').length);
    assert.deepEqual(floats, [], `${file}: float product on line ${floats.join(', ')}`);
  });

// The low k bits of a generator modulo a power of two repeat every 2^k draws (the lowest one just alternates), so a
// draw shifts the state down before taking a remainder. An odd literal divisor mixes the high bits in by itself.
for (const file of files)
  test(`${file} takes remainders of the high bits of its generator`, () => {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/),
      low = [];
    lines.forEach((line, at) => {
      const state = /Math\.imul\(\s*([\w$.]+)\s*,\s*1103515245/.exec(line)?.[1];
      if (!state) return;
      // A remainder written straight after the state's mask, or taken of the state's own name in the next lines.
      const raw = new RegExp(
        String.raw`(?:(?:0x7fffffff|>>> ?0)\)\)?\s*|\b${state.replaceAll('.', '[.]')}\s*)%(?!=)(?!\s*\d*[13579]\b)`,
      );
      if (raw.test(lines.slice(at, at + 4).join('\n'))) low.push(at + 1);
    });
    assert.deepEqual(low, [], `${file}: remainder of the raw state near line ${low.join(', ')}`);
  });
