import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

// The kernel ships under the engine's Apache-2.0 licence. Its tracked NOTICE starts with the root NOTICE and adds the
// Siemens JT notice (docs/jt-licensing.md), which every JT reader source file carries in its header too.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(read('../package.json'));
const jtNotice = [
  'This software reads the JT Data Format as described in the Siemens JT File Format Reference and ISO 14306.',
  'Siemens JT Data Format Reference Intellectual Property License Terms',
  'licensed royalty-free under the Siemens JT Data Format Reference Patent Clarification Notice',
  'This software is not endorsed by or affiliated with Siemens.',
];
const flat = (text) => text.replace(/\n(\/\/ ?)?/g, ' ').replace(/\s+/g, ' ');

test('the kernel package is published under Apache-2.0', () => {
  assert.equal(manifest.name, '@margoengine/brep');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.publishConfig, { access: 'public' });
  assert.ok(manifest.files.includes('NOTICE') && manifest.files.includes('LICENSE'));
  assert.match(read('../../../LICENSE'), /Apache License\s+Version 2\.0/);
});

test('the NOTICE starts with the root NOTICE and carries the Siemens JT notice', () => {
  const notice = read('../NOTICE');
  assert.ok(notice.startsWith(read('../../../NOTICE')));
  for (const line of jtNotice) assert.ok(flat(notice).includes(line), line);
});

test('every JT reader source file but the generic LZMA decoder carries the Siemens JT notice in its header', () => {
  const dir = new URL('../src/jt/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'lzma.ts');
  assert.ok(files.length >= 5, files.join());
  for (const file of files) {
    const header = flat(read(new URL(file, dir)).split('\nimport ')[0]);
    for (const line of jtNotice) assert.ok(header.includes(line), `${file}: ${line}`);
  }
});
