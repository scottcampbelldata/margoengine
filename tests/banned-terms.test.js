// The banned-terms check catches CAD import and CAD tooling names in public text and in the text of tracked PDFs, and
// its list never holds them. The words are written here in base64 or character codes, because this file is scanned too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { hitsInLine, hitsInPath, scan, scanRepo } from '../scripts/check-banned-terms.mjs';
import { pdfText } from '../scripts/pdf-text.mjs';

const word = (...codes) => String.fromCharCode(...codes);
const b64 = (text) => Buffer.from(text, 'base64').toString('utf8');
const repo = `${word(109, 97, 114, 103, 111)}-${word(99, 97, 100)}-${word(107, 101, 114, 110, 101, 108)}`; // the private repo name
const pkg = `${word(109, 97, 114, 103, 111, 101, 110, 103, 105, 110, 101)}/${word(98, 114, 101, 112)}`;
const banned = [
  b64('QG1hcmdvZW5naW5lL21hY2hpbmVyeQ=='), // the removed package's specifier
  b64('Qi1SZXA='), // the boundary representation abbreviation, hyphenated
  b64('cGFydC5pZ3M='), // a file of one CAD exchange format
  b64('U1RFUCBhbmQgSUdFUw=='), // the two CAD exchange formats
  b64('bG9hZENBRA=='), // the removed loader function
  b64('U2VjdGlvblBsYW5lcw=='), // the removed section class
  b64('bWFyZ29lbmdpbmUvc3RhZ2UvY2Fk'), // the removed stage entry
  b64('T3BlbkNhc2NhZGU='), // the CAD kernel the removed importer used
];

test('the repo name, with or without hyphens, and the package path are reported', () => {
  assert.equal(hitsInLine(`see ${repo} for more`).length > 0, true);
  assert.equal(hitsInLine(repo.replaceAll('-', '')).length > 0, true);
  assert.equal(hitsInLine(`import x from '@${pkg}'`).length > 0, true);
  assert.equal(hitsInLine(`packages/${word(98, 114, 101, 112)}/src`).length > 0, true);
  assert.equal(hitsInLine(word(80, 97, 114, 97, 115, 111, 108, 105, 100)).length > 0, true);
});

test('every removed CAD name is reported', () => {
  for (const text of banned) assert.notDeepEqual(hitsInLine(`a line with ${text} in it`), [], text.length);
});

test('ordinary text, IFC files and the kept names pass; binary data is skipped', () => {
  assert.deepEqual(hitsInLine('CAD camera controls, a step function, section planes in prose, featureEdges'), []);
  assert.deepEqual(hitsInLine("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));"), []);
  assert.deepEqual(scan(Buffer.concat([Buffer.from([0]), Buffer.from(repo)])), []);
  assert.equal(scan(Buffer.from(`ok\n${repo}\n`)).at(0).line, 2);
});

test('a removed name in a file or folder name is reported; kept names that merely contain the letters pass', () => {
  const short = word(99, 97, 100); // the three-letter abbreviation the removed benchmark folder and fixtures used
  assert.notDeepEqual(hitsInPath(`examples/package-benchmarks/${short}/power.mjs`), []);
  assert.notDeepEqual(hitsInPath(`packages/blender/tests/fixtures/${short}-triangle.margo`), []);
  assert.notDeepEqual(hitsInPath(`tests/deep-ingestion-${short}-initialization.test.js`), []);
  assert.notDeepEqual(hitsInPath(`src/${short.toUpperCase()}CameraControls.ts`), []);
  assert.notDeepEqual(hitsInPath(`packages/${word(98, 114, 101, 112)}/src/index.ts`), []);
  for (const kept of [
    'tests/modern-facade-isolation.test.js',
    'packages/shadows/src/cascades.ts',
    'packages/decoders/tests/fixtures/Avocado.gltf',
    'examples/package-benchmarks/parts/power.mjs',
    'packages/kernel/src/lib.rs',
  ])
    assert.deepEqual(hitsInPath(kept), [], kept);
  // Text, unlike a path, may still name the camera controls preset.
  assert.deepEqual(hitsInLine(`${short.toUpperCase()} camera controls`), []);
});

test('the list file holds hashes only', () => {
  const text = readFileSync(new URL('../scripts/banned-terms.json', import.meta.url), 'utf8').toLowerCase();
  for (const plain of [repo, pkg, ...banned]) assert.equal(text.includes(plain.toLowerCase()), false);
});

/** A one-page PDF that shows `text` through a font with a ToUnicode map, written the way Chromium writes text. */
function pdf(text) {
  const glyphs = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) glyphs.writeUInt16BE(text.charCodeAt(i), i * 2);
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td <${glyphs.toString('hex')}> Tj ET`));
  const cmap = Buffer.from(
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> ' +
      'endcodespacerange 1 beginbfrange <0000> <00FF> <0000> endbfrange endcmap end end',
  );
  const parts = [
    '%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n',
    '2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n',
    '3 0 obj\n<</Type /Page /Parent 2 0 R /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>\nendobj\n',
    '4 0 obj\n<</Type /Font /Subtype /Type0 /BaseFont /Test /ToUnicode 6 0 R>>\nendobj\n',
  ];
  return Buffer.concat([
    Buffer.from(parts.join(''), 'latin1'),
    Buffer.from(`5 0 obj\n<</Filter /FlateDecode /Length ${content.length}>> stream\n`, 'latin1'),
    content,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from(`6 0 obj\n<</Length ${cmap.length}>> stream\n`, 'latin1'),
    cmap,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
}

test('the text a PDF shows is read through its fonts, so a banned name in a printed page is reported', () => {
  assert.equal(pdfText(pdf('Margo Engine whitepaper')), 'Margo Engine whitepaper\nMargo Engine whitepaper');
  assert.notDeepEqual(scan(Buffer.from(pdfText(pdf(`loads ${banned[3]} files`)))), []);
  assert.deepEqual(scan(Buffer.from(pdfText(pdf('loads glTF files')))), []);
  assert.equal(pdfText(Buffer.from('%PDF-1.4\n%%EOF\n')), null);
});

test('no tracked file, and no tracked PDF page, contains a banned term', () => {
  assert.deepEqual(scanRepo(), []);
});

test('the name of the block game is reported alone, possessive, and inside a hyphenated compound', () => {
  const game = word(77, 105, 110, 101, 99, 114, 97, 102, 116); // the block game the voxel docs once compared themselves to
  for (const text of [game, game.toLowerCase(), `${game}'s order`, `${game}-like worlds`, `${game}-style game`])
    assert.notDeepEqual(hitsInLine(`a line with ${text} in it`), [], text);
  assert.deepEqual(hitsInLine('a block-world game, a voxel-like grid, a mine-cart and a craft-fair'), []);
  assert.notDeepEqual(hitsInPath(`packages/voxel/${game}-notes.md`), []);
});
