// The banned-terms check catches hashed names in public text and in the text of tracked PDFs, and
// its list never holds them. The words are written here in base64 or character codes, because this file is scanned too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { hitsInLine, hitsInPath, main, scan, scanRepo } from '../scripts/check-banned-terms.mjs';
import { pdfText } from '../scripts/pdf-text.mjs';

const word = (...codes) => String.fromCharCode(...codes);
const b64 = (text) => Buffer.from(text, 'base64').toString('utf8');
const repo = `${word(109, 97, 114, 103, 111)}-${word(99, 97, 100)}-${word(107, 101, 114, 110, 101, 108)}`; // the private repo name
const banned = [
  b64('bWFyZ29lbmdpbmUvc3RhZ2UvY2Fk'), // the removed stage entry
  b64('T3BlbkNhc2NhZGU='), // the CAD kernel the removed importer used
];

test('the repo name, with or without hyphens, is reported', () => {
  assert.equal(hitsInLine(`see ${repo} for more`).length > 0, true);
  assert.equal(hitsInLine(repo.replaceAll('-', '')).length > 0, true);
});

// Scott, 2026-11-13: the kernel and the CAD import package are public again (packages/brep, packages/cad), so their
// names, paths, formats and API pass; the kernel repository's name, the importer's third-party kernel, the package
// that stays out and the removed stage entry and section class are still reported.
test('the public kernel and CAD import names pass', () => {
  const kernel = word(98, 114, 101, 112),
    short = word(99, 97, 100);
  for (const text of [
    `import x from '@margoengine/${kernel}'`,
    `import x from '@margoengine/${short}/stage'`,
    `packages/${kernel}/src`,
    'B-Rep',
    'part.igs',
    'STEP and IGES',
    'Parasolid XT',
    'AP203, AP214 and AP242',
    'loadCAD, parseCAD, parseCADAsync, addCAD, PartInstancer, deduplicateParts and CADImporter',
    'dist/workers/cad-runtime.js and the cad-worker',
  ])
    assert.deepEqual(hitsInLine(text), [], text);
  for (const path of [`packages/${kernel}/src/index.ts`, `packages/${short}/test/pack.test.js`])
    assert.deepEqual(hitsInPath(path), [], path);
});

// Scott, 2026-11-13: "Just put machinery and everything back In public" and "there should be no private packages at
// all now". Machinery and its API, the building-model package and its runtime, the robot planning entries and the CAD
// converter's name pass; the kernel repository's name, the earlier importer's third-party kernel and the removed stage
// entry are still reported.
test('the packages that came back from the kernel repository pass, with their API and runtime names', () => {
  const name = word(105, 102, 99),
    engine = word(109, 97, 114, 103, 111, 101, 110, 103, 105, 110, 101),
    pkg = `${word(107, 105, 110, 101, 109, 97, 116, 105, 99, 115)}-${word(99, 111, 110, 115, 116, 114, 97, 105, 110, 116, 115)}`;
  for (const text of [
    `import x from '@${engine}/machinery/section'`,
    'SectionPlanes, SectionPlanesProps, ExplodedView, AssemblyBVH, AssemblyIndex, TelemetryChannel',
    'industrialMaterial, industrialMaterials, SurfacePhysics, boxSection, measureDistance, measureClearance',
    'EngineeringAnnotations, WorldAnchor, projectAnnotation, VertexAnchor, EdgeAnchor, FaceAnchor, HoleAnchor, snapFeature',
    `@${engine}/${name}`,
    `${engine}/${name}/worker`,
    `web-${name} and web${name}`,
    `margoengine/${pkg}/robot`,
    'cad-cli',
  ])
    assert.deepEqual(hitsInLine(text), [], text);
  assert.deepEqual(hitsInPath('packages/machinery/kernel/src/lib.rs'), []);
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
  assert.notDeepEqual(hitsInPath(`packages/${repo}/src/index.ts`), []);
  assert.notDeepEqual(hitsInPath(`examples/${b64('T3BlbkNhc2NhZGU=')}-demo/index.html`), []);
  for (const kept of [
    'tests/modern-facade-isolation.test.js',
    'packages/shadows/src/cascades.ts',
    'packages/decoders/tests/fixtures/Avocado.gltf',
    'examples/package-benchmarks/parts/power.mjs',
    'packages/kernel/src/lib.rs',
  ])
    assert.deepEqual(hitsInPath(kept), [], kept);
});

test('the list file holds hashes only', () => {
  const text = readFileSync(new URL('../scripts/banned-terms.json', import.meta.url), 'utf8').toLowerCase();
  for (const plain of [repo, ...banned]) assert.equal(text.includes(plain.toLowerCase()), false);
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
  assert.notDeepEqual(scan(Buffer.from(pdfText(pdf(`loads ${banned[1]} files`)))), []);
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

// KB-BT1 (2026-11-11): an L3b gate saw `check:banned-terms` exit 1 with no output, then pass on a rerun. Problems went
// to stderr only, an error that stopped the scan had no line of the check's own, and a tracked file that could not be
// read (another process writing it) was skipped unscanned. Every non-zero exit now names its reason on both streams.
test('every failure of the check names its reason on stdout and stderr; an unreadable file fails, a deleted one is skipped', () => {
  const run = (scanAll) => {
    const log = [],
      error = [];
    const code = main({ scanAll, log: (line) => log.push(line), error: (line) => error.push(line) });
    return { code, log: log.join('\n'), error: error.join('\n') };
  };
  const clean = run(() => []);
  assert.deepEqual([clean.code, clean.error], [0, '']);
  assert.match(clean.log, /none in tracked files/);
  const hits = run(() => ['a.md:3: banned term 0123; remove it']);
  assert.equal(hits.code, 1);
  assert.match(hits.error, /a\.md:3: banned term 0123/);
  assert.match(hits.log, /1 problem\(s\)/);
  const stopped = run(() => {
    throw Object.assign(new Error('git ls-files: index.lock exists'), { code: 'EGIT' });
  });
  assert.equal(stopped.code, 1);
  assert.match(stopped.log, /could not finish the scan: Error: git ls-files: index\.lock exists/);
  assert.match(stopped.error, /could not finish the scan/);
  const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }),
    gone = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const found = scanRepo(
    (path) => {
      if (/README\.md$/.test(path)) throw busy;
      if (/LICENSE$/.test(path)) throw gone;
      return readFileSync(path);
    },
    ['README.md', 'LICENSE', 'AGENTS.md'],
  );
  assert.deepEqual(found, ['README.md: could not be read (EBUSY); rerun once the process writing it has finished']);
});
