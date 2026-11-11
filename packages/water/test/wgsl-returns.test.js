// Regression (KB-FF1, 2026-11-11): coastal.ts `root` ended in a `loop` whose only exit was a `return` inside it. The
// WGSL behavior analysis accepts that (a loop with no break never falls through), but Firefox's WGSL front end requires
// a value-returning function to end in a statement that returns on every path, so the biomes GPU suite failed in
// Firefox. Every value-returning WGSL function in this package's source must end in `return`, in an `if` with an `else`
// whose branches both do, or in a `switch` whose every clause does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const { parseWGSL } = await import('../../webgl2-compat/dist/wgsl.js');
const folder = new URL('../src/', import.meta.url);

// The functions `fn name(...) -> T { ... }` written out in the package source, cut at their matching brace. A function
// built from `${...}` pieces or JavaScript string pieces (WGSL has no quotes) is left to the GPU suites.
function functions(text) {
  const found = [];
  for (const match of text.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    let i = match.index + match[0].length,
      depth = 1;
    for (; i < text.length && depth; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    if (!/^\s*->\s*[^{;]+?\s*\{/.test(text.slice(i, i + 160))) continue;
    let j = text.indexOf('{', i) + 1;
    depth = 1;
    for (; j < text.length && depth; j++) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
    found.push({ name: match[1], source: text.slice(match.index, j) });
  }
  return found;
}

// Firefox's rule, over the parsed body.
function returns(statement) {
  if (!statement) return false;
  if (statement.kind === 'return' || statement.kind === 'discard') return true;
  if (statement.kind === 'compound') return returns(statement.body.at(-1));
  if (statement.kind === 'if') return !!statement.else && returns(statement.then) && returns(statement.else);
  if (statement.kind === 'switch') return statement.clauses.every((clause) => returns(clause.body));
  return false;
}

test('every value-returning WGSL function in water ends in a return on every path (Firefox, KB-FF1)', () => {
  const failures = [];
  let checked = 0;
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.ts'))) {
    for (const { name, source } of functions(readFileSync(new URL(file, folder), 'utf8'))) {
      if (/\$\{|['"`]/.test(source)) continue;
      const fn = parseWGSL(source).declarations.find((decl) => decl.kind === 'fn');
      checked++;
      if (!returns(fn.body)) failures.push(`${file} ${name}`);
    }
  }
  assert.ok(checked > 50, `checked ${checked} functions`);
  assert.deepEqual(failures, []);
});
