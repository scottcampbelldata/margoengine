// KB1942: where an authored specializes arc ranks against the copies it implies upstream. The specification is silent, so
// the rule was pinned black-box: each stage below was composed by OpenUSD 26.11 (usd-core from PyPI, run where it lives,
// its source never read) and the expected value is the one OpenUSD printed. The stages are ours.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
async function valueAt(files, path) {
  const { specs } = await composeUSDFiles('root.usda', (id) => (id in files ? encoder.encode(files[id]) : undefined));
  return specs[path + '.v']?.fields.default;
}
/** Nested `def` prims along `path`; `meta` goes on the last one and `body` inside it. */
function nest(path, meta = '', body = '') {
  const names = path.split('/').filter(Boolean);
  let text = body;
  for (let i = names.length - 1; i >= 0; i--)
    text = `def "${names[i]}"${i === names.length - 1 && meta ? ` (\n${meta}\n)` : ''} {\n${text}\n}`;
  return text;
}
const classWith = (value) => `class "C" {\n  def "a" {\n    custom double v = ${value}\n  }\n}`;

// Two references in a row: root `holder` references l2.usda</M>, l2's `inner` references l0.usda</M>, and l0's /M
// specializes /C/a. OpenUSD gives l0's own opinion only while the root holder sits deeper than l2's holder.
const chain = [
  // [root holder depth, l2 holder depth, root has a /C/a opinion, OpenUSD's value]
  [1, 1, 0, 2], [1, 1, 1, 1], [1, 2, 0, 2], [1, 2, 1, 1], [1, 3, 0, 2], [1, 3, 1, 1], [1, 4, 0, 2], [1, 4, 1, 1],
  [2, 1, 0, 0], [2, 1, 1, 0], [2, 2, 0, 2], [2, 2, 1, 1], [2, 3, 0, 2], [2, 3, 1, 1], [2, 4, 0, 2], [2, 4, 1, 1],
  [3, 1, 0, 0], [3, 1, 1, 0], [3, 2, 0, 0], [3, 2, 1, 0], [3, 3, 0, 2], [3, 3, 1, 1], [3, 4, 0, 2], [3, 4, 1, 1],
  [4, 1, 0, 0], [4, 1, 1, 0], [4, 2, 0, 0], [4, 2, 1, 0], [4, 3, 0, 0], [4, 3, 1, 0], [4, 4, 0, 2], [4, 4, 1, 1],
];
const ROOT = ['/P', '/P/a', '/P/a/c', '/P/a/c/d'],
  INNER = ['/M', '/M/b', '/M/b/e', '/M/b/e/f'];
test('an authored specializes arc behind two references ranks against its implied copies as OpenUSD ranks it', async () => {
  for (const [h1, h2, rootOpinion, want] of chain) {
    const holder = ROOT[h1 - 1],
      inner = INNER[h2 - 1];
    const files = {
      'root.usda': `#usda 1.0\n${rootOpinion ? classWith(1) : ''}\n${nest(holder, '  references = @./l2.usda@</M>')}\n`,
      'l2.usda': `#usda 1.0\n${classWith(2)}\n${nest(inner, '  references = @./l0.usda@</M>')}\n`,
      'l0.usda': `#usda 1.0\n${classWith(0)}\n${nest('/M', '  specializes = </C/a>')}\n`,
    };
    assert.equal(await valueAt(files, holder + inner.slice(2)), want, `holder ${holder}, l2 holder ${inner}`);
  }
});

// One reference to l2's `target`, whose own variant authors the specializes arc. OpenUSD gives l2's opinion once the
// root holder sits deeper than the referenced prim; a plain arc (no variant) always loses to the root's implied copy.
const variant = [
  // [root holder, l2 target, arc in a variant, specializes or inherits, OpenUSD's value]
  ['/R', '/M', 1, 'specializes', 1], ['/R/b', '/M', 0, 'specializes', 1], ['/R/b', '/M', 1, 'specializes', 2],
  ['/R/b', '/X/M', 1, 'specializes', 1], ['/R/b/d', '/M', 1, 'specializes', 2], ['/R/b/d', '/X/M', 1, 'specializes', 2],
  ['/R/b/d', '/X/Y/M', 1, 'specializes', 1], ['/R/b/d', '/X/M', 0, 'specializes', 1],
  ['/R/b', '/M', 1, 'inherits', 1], ['/R/b/d', '/X/M', 1, 'inherits', 1],
];
test('a specializes arc in a variant of the referenced prim ranks against its implied copy as OpenUSD ranks it', async () => {
  for (const [holder, target, inVariant, arc, want] of variant) {
    const own = inVariant
      ? nest(
          target,
          '  variantSets = "vs"\n  variants = { string vs = "x" }',
          `variantSet "vs" = {\n  "x" (\n    ${arc} = </C/a>\n  ) {\n  }\n}`,
        )
      : nest(target, `  ${arc} = </C/a>`);
    const files = {
      'root.usda': `#usda 1.0\n${classWith(1)}\n${nest(holder, `  references = @./l2.usda@<${target}>`)}\n`,
      'l2.usda': `#usda 1.0\n${classWith(2)}\n${own}\n`,
    };
    assert.equal(await valueAt(files, holder), want, `${arc} ${holder} -> ${target}, variant ${inVariant}`);
  }
});
