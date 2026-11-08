// Every Markdown table in the docs has a header row right above its separator, with as many cells. A script that
// inserted a batch's rows once replaced another batch's table and left its own separator without a header or rows
// (build-record.md, batches 100 and the grading batch before it); this catches that class of slip in any doc.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const separator = /^\|( *:?-+:? *\|)+ *$/;
const cells = (line) => line.replace(/\\\|/g, '').split('|').length - 2;

export function tableSlips(text) {
  const lines = text.split(/\r?\n/),
    slips = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) fence = !fence;
    if (fence || !separator.test(lines[i])) continue;
    const header = i ? lines[i - 1] : '';
    if (!header.startsWith('|') || separator.test(header)) slips.push(`line ${i + 1}: separator without a header row`);
    else if (cells(header) !== cells(lines[i]))
      slips.push(`line ${i + 1}: header has ${cells(header)} cells, separator ${cells(lines[i])}`);
  }
  return slips;
}

const docs = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? docs(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );

test('tableSlips finds a separator without a header and a header of the wrong width', () => {
  assert.deepEqual(tableSlips('| a | b |\n| --- | --- |\n| 1 | 2 |'), []);
  assert.deepEqual(tableSlips('text\n\n| --- | --- |\n'), ['line 3: separator without a header row']);
  assert.deepEqual(tableSlips('| a | b | c |\n| --- | --- |'), ['line 2: header has 3 cells, separator 2']);
  assert.deepEqual(tableSlips('```\n| --- |\n```'), []);
});

test('every table in docs/ and README.md has a header row as wide as its separator', () => {
  const slips = [];
  for (const file of [...docs(join(root, 'docs')), join(root, 'README.md')])
    for (const slip of tableSlips(readFileSync(file, 'utf8'))) slips.push(`${file.slice(root.length)} ${slip}`);
  assert.deepEqual(slips, []);
});
