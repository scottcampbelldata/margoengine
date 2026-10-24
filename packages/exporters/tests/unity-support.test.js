import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactCSharp } from '../scripts/compact-csharp.js';
import { UNITY_SUPPORT_PAYLOADS } from '../dist/unity-support.generated.js';

const sample = [
  '#pragma warning disable 0649 // trailing note',
  '/// <summary>Doc comment.</summary>',
  'class A { // line comment',
  '    /* block',
  '       comment */ string s = "keep // this /* too */  spaced\\" quote";',
  '    string v = @"C:\\path ""quoted"" // not a comment',
  'second line";',
  "    char q = '\"', slash = '/', esc = '\\'';",
  '    int d = a - -b + +c, e = x / /* gap */ y;',
  '    bool f = p < -1 && q >= 0;',
  '}',
  '#pragma warning restore 0649',
  '',
].join('\n');

test('compactCSharp drops comments and layout but keeps every literal byte for byte', () => {
  const out = compactCSharp(sample);
  for (const literal of [
    '"keep // this /* too */  spaced\\" quote"',
    '@"C:\\path ""quoted"" // not a comment\nsecond line"',
    "'\"'",
    "'/'",
    "'\\''",
  ])
    assert.ok(out.includes(literal), `literal survives: ${literal}`);
  assert.doesNotMatch(out.replace(/"(?:[^"\\]|\\.)*"|@"(?:[^"]|"")*"/g, ''), /\/\/|\/\*|<summary>|line comment/);
  assert.match(out, /^#pragma warning disable 0649\n/);
  assert.match(out, /\n#pragma warning restore 0649\n$/);
  assert.ok(out.includes('a- -b+ +c'), 'operators that would merge keep one space');
  assert.ok(out.includes('x/y'), 'a removed comment leaves no gap between unrelated tokens');
  assert.ok(out.includes('class A{'));
});

test('compactCSharp is deterministic and idempotent, and rejects what it cannot parse', () => {
  assert.equal(compactCSharp(sample), compactCSharp(sample));
  assert.equal(compactCSharp(compactCSharp(sample)), compactCSharp(sample));
  for (const bad of ['var s = $"{x}";', 'var s = "open', '/* open', 'var s = @"open'])
    assert.throws(() => compactCSharp(bad), TypeError);
  assert.throws(() => compactCSharp(null), TypeError);
});

test('embedded Unity support is the compacted C# and the unchanged other files', async () => {
  const root = fileURLToPath(new URL('../src/unity/', import.meta.url));
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  assert.deepEqual(UNITY_SUPPORT_PAYLOADS.map((file) => file.name).sort(), files.sort());
  for (const { name, text } of UNITY_SUPPORT_PAYLOADS) {
    const source = await readFile(join(root, name), 'utf8');
    assert.equal(text, name.endsWith('.cs') ? compactCSharp(source) : source, name);
    if (name.endsWith('.cs')) assert.ok(text.length < source.length, `${name} is smaller embedded`);
  }
});
