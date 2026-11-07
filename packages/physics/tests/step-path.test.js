// The determinism guarantee lives or dies on this rule: the TypeScript a step runs uses no `Math`, no clock and no random
// number. `Math.sin` differs between engines and `x ** y` is only approximated by the language, so a simulation that used
// them would part ways between browsers. Reading a mesh and writing it back (next/sync.ts) and reading a collider
// (next/collider.ts) cannot change a step, so they are the only files of the entry where `Math` is allowed.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const source = new URL('../src/', import.meta.url);
const offPath = new Set(['next/sync.ts', 'next/collider.ts']);
const banned = /(?:(?<![\w$.])|(?<=\bglobalThis\.))(Math|Date|performance|crypto)\b/g;

/** `text` with comments and the insides of strings blanked, newlines kept. The checked files hold no regular expressions. */
function codeOnly(text) {
  let out = '';
  const holes = []; // Brace depth of each `${` still open.
  let i = 0,
    depth = 0;
  const blank = (to) => {
    out += text.slice(i, to).replace(/[^\n]/g, ' ');
    i = to;
  };
  const template = () => {
    for (let at = i; at < text.length; at++) {
      if (text[at] === '\\') at++;
      else if (text[at] === '`') return blank(at + 1);
      else if (text[at] === '$' && text[at + 1] === '{') {
        blank(at + 2);
        holes.push(depth);
        return;
      }
    }
    blank(text.length);
  };
  while (i < text.length) {
    const c = text[i],
      next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      blank(end < 0 ? text.length : end);
    } else if (c === '/' && next === '*') blank(text.indexOf('*/', i) + 2);
    else if (c === "'" || c === '"') {
      let at = i + 1;
      while (text[at] !== c) at += text[at] === '\\' ? 2 : 1;
      blank(at + 1);
    } else if (c === '`') {
      blank(i + 1);
      template();
    } else if (c === '}' && holes.at(-1) === depth) {
      holes.pop();
      blank(i + 1);
      template();
    } else {
      if (c === '{') depth++;
      if (c === '}') depth--;
      out += c;
      i++;
    }
  }
  return out;
}

/** Every use of a banned global and of `**` in TypeScript source, ignoring comments, strings and object keys. */
function findings(text, name = 'source.ts') {
  const code = codeOnly(text),
    found = [];
  const report = (at, what) => found.push(`${name}:${code.slice(0, at).split('\n').length} ${what}`);
  for (const { 0: word, index } of code.matchAll(banned)) {
    const key = /^\s*:/.test(code.slice(index + word.length)) && /[{,]\s*$/.test(code.slice(0, index));
    if (!key) report(index, word);
  }
  for (const { index } of code.matchAll(/\*\*/g)) report(index, '**');
  return found;
}

test('the TypeScript on the step path uses no Math, clock or power operator', () => {
  const files = ['kernel.ts', ...readdirSync(new URL('next/', source)).map((name) => `next/${name}`)].filter(
    (name) => !offPath.has(name),
  );
  assert.ok(files.includes('next/physics.ts') && files.includes('next/body.ts') && files.includes('next/shapes.ts'));
  const found = files.flatMap((name) => findings(readFileSync(new URL(name, source), 'utf8'), name));
  assert.deepEqual(found, []);
});

test('the rule finds what it bans and leaves words in comments and names alone', () => {
  assert.equal(findings('const a = Math.sin(1);').length, 1);
  assert.equal(findings('const { sqrt } = Math;').length, 1);
  assert.equal(findings('const a = 2 ** 3;').length, 1);
  assert.equal(findings('const a = Date.now();').length, 1);
  assert.equal(findings('x **= 2;').length, 1);
  assert.equal(findings('const a = globalThis.Math.sin(1);').length, 1);
  assert.equal(findings('const a = `${Math.sin(1)}`;').length, 1);
  assert.equal(findings('const a = b ? Math : c;').length, 1);
  assert.equal(findings('// Math.sin\nconst a = "Math.sin", b = { Math: 1 }, c = b.Math, d = `Math ${c}`;').length, 0);
  assert.deepEqual(findings('/* a */\nconst a = 1;\nconst b = Math.abs(a);'), ['source.ts:3 Math']);
});
