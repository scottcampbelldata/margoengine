import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleIds, readmeEntries } from '../scripts/support/readme-types.mjs';
import {
  askedElements,
  goneLine,
  judge,
  listenPort,
  namedFiles,
  nodeTurns,
  pickExamples,
  placeOf,
  runInNode,
  assetFile,
  claimScratch,
  sampleFiles,
} from '../scripts/run-readme-examples.mjs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const samples = { byName: new Map(), byExtension: new Map() };

test('an example that throws fails, with its error as the reason', async () => {
  const result = await runInNode({ id: 'runner-test/throws', code: "throw new RangeError('wrong size');" }, samples);
  assert.equal(result.result, 'fail');
  assert.match(result.reason, /RangeError: wrong size/);
});

test('a promise left rejected fails an example', async () => {
  const result = await runInNode({ id: 'runner-test/rejects', code: "Promise.reject(new Error('lost'));" }, samples);
  assert.equal(result.result, 'fail');
  assert.match(result.reason, /lost/);
});

test('TypeScript runs as a reader would paste it', async () => {
  const result = await runInNode({ id: 'runner-test/passes', code: 'const size: number = 2;\nconsole.log(size);' }, samples);
  assert.equal(result.result, 'pass');
});

test('a failure off the known list is fresh, and a known one is not', () => {
  const report = [
    { id: 'a/readme-0', result: 'fail', reason: 'x' },
    { id: 'b/readme-0', result: 'fail', reason: 'y' },
  ];
  assert.deepEqual(
    judge(report, { 'a/readme-0': 'sample: x' }, false).fresh.map(({ id }) => id),
    ['b/readme-0'],
  );
});

test('the known list only shrinks: an entry that passes is reported', () => {
  const report = [{ id: 'a/readme-0', result: 'pass' }];
  assert.deepEqual(judge(report, { 'a/readme-0': 'sample: x' }, false).gone, ['a/readme-0']);
});

test('a narrowed run says nothing of the entries it left out', () => {
  assert.deepEqual(judge([], { 'a/readme-0': 'sample: x' }, true).gone, []);
});

test('a known entry whose example is gone fails a whole run, and says so', () => {
  const report = [{ id: 'a/readme-0', result: 'pass' }],
    { gone } = judge(report, { 'a/readme-0': 'sample: x', 'a/readme-9': 'sample: y' }, false);
  assert.deepEqual(gone, ['a/readme-0', 'a/readme-9']);
  assert.match(goneLine('a/readme-0', report), /passes, still on the known list/);
  assert.match(goneLine('a/readme-9', report), /no such example, still on the known list/);
});

// Four voxel-net examples listen on 8787: side by side one got the port, the others failed in Node and then in a page.
test('examples on one port take turns, and the rest stay side by side', () => {
  assert.equal(listenPort("await server.listen(8787, '0.0.0.0');"), '8787');
  assert.equal(listenPort('const a = 8787;'), undefined);
  const example = (id, code) => ({ id, code }),
    turns = nodeTurns([
      example('a', 'await server.listen(8787);'),
      example('b', 'const x = 1;'),
      example('c', "server.listen( 8787, '0.0.0.0');"),
      example('d', 'const y = 2;'),
      example('e', 'server.listen(9000);'),
    ]);
  assert.deepEqual(
    turns.map((turn) => turn.map(({ id }) => id)),
    [['a', 'c'], ['b'], ['d'], ['e']],
  );
});

// Ids were file positions: a new example above a listed one moved every id under it, and the full check failed on all of them.
test('an example keeps its id when another is added above it, and across line endings', () => {
  const block = (code) => `\`\`\`ts\nimport '${code}';\n\`\`\`\n`,
    ids = (markdown) => exampleIds('sky', 'readme', readmeEntries(markdown)),
    before = `# Sky\n\n## Sun position\n\n${block('a')}\n## Fog\n\n${block('b')}`,
    after = `# Sky\n\n## New part\n\n${block('new')}\n## Sun position\n\n${block('new too')}\n${block('a')}\n## Fog\n\n${block('b')}`,
    [sun, fog] = ids(before);
  assert.match(sun, /^sky\/readme-sun-position-[0-9a-f]{6}$/);
  assert.match(fog, /^sky\/readme-fog-[0-9a-f]{6}$/);
  assert.ok(ids(after).includes(sun) && ids(after).includes(fog));
  assert.deepEqual(ids(before.replace(/\n/g, '\r\n')), [sun, fog]);
});

test('identical examples under one heading get their own ids, and a # line in a code block is no heading', () => {
  const block = '```ts\nimport \'a\';\n```\n',
    markdown = `## Real\n\n\`\`\`sh\n# not a heading\n\`\`\`\n\n${block}\n${block}`,
    ids = exampleIds('sky', 'readme', readmeEntries(markdown));
  assert.match(ids[0], /^sky\/readme-real-[0-9a-f]{6}$/);
  assert.equal(ids[1], `${ids[0]}-2`);
});

test('an example with no heading above it still has an id, and a long heading is cut', () => {
  const markdown = `\`\`\`ts\nimport 'a';\n\`\`\`\n\n# ${'long words '.repeat(20)}\n\n\`\`\`ts\nimport 'b';\n\`\`\`\n`,
    [first, second] = exampleIds('sky', 'readme', readmeEntries(markdown));
  assert.match(first, /^sky\/readme-[0-9a-f]{6}$/);
  assert.ok(second.length < 'sky/readme-'.length + 32 + 8);
});

test('--packages takes whole package names, and adds to --only', () => {
  const examples = [
      { id: 'sky/readme-0', name: 'sky' },
      { id: 'sky/readme-1', name: 'sky' },
      { id: 'sky-extra/readme-0', name: 'sky-extra' },
    ],
    ids = (options) => pickExamples(examples, options).map(({ id }) => id);
  assert.equal(ids({}).length, 3);
  assert.deepEqual(ids({ packages: ['sky'] }), ['sky/readme-0', 'sky/readme-1']);
  assert.deepEqual(ids({ packages: ['sky'], only: 'readme-1' }), ['sky/readme-1']);
  assert.deepEqual(ids({ ids: new Set(['sky-extra/readme-0']) }), ['sky-extra/readme-0']);
});

test('an example goes where its code can run', () => {
  assert.equal(placeOf("import { readFile } from 'node:fs/promises';"), 'node');
  assert.equal(placeOf("const c = document.querySelector('canvas');"), 'page');
  assert.equal(placeOf('const a = 1;'), undefined);
});

test('the files and elements an example asks for are found', () => {
  assert.deepEqual(namedFiles("await load('/models/crate.glb');"), ['/models/crate.glb']);
  assert.ok(askedElements("document.querySelector('#viewport');").length > 0);
});

// Regression: files under 200 bytes were dropped as LFS pointers, so a real 60-byte .bin (Cameras.bin) was replaced by
// another model's buffer. A pointer is told by its first line; a small real file stays a sample of its own name.
test('a small real file is a sample, and an LFS pointer of any size is not', () => {
  const folder = mkdtempSync(join(tmpdir(), 'readme-samples-'));
  try {
    writeFileSync(join(folder, 'Cameras.bin'), Buffer.alloc(60, 7));
    writeFileSync(
      join(folder, 'Big.bin'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123456\n`,
    );
    writeFileSync(join(folder, 'empty.png'), '');
    const { byName, byExtension } = sampleFiles(['Cameras.bin', 'Big.bin', 'empty.png'], folder);
    assert.equal(byName.get('cameras.bin')?.size, 60);
    assert.equal(byName.has('big.bin'), false);
    assert.equal(byExtension.get('.bin')?.path, join(folder, 'Cameras.bin'));
    assert.equal(byExtension.has('.png'), false);
    // A smaller .bin of another model must not stand in for the chosen .gltf's own buffer.
    writeFileSync(join(folder, 'Other.bin'), Buffer.alloc(20, 1));
    writeFileSync(join(folder, 'Cameras.gltf'), JSON.stringify({ buffers: [{ uri: 'Cameras.bin', byteLength: 60 }] }));
    const paired = sampleFiles(['Cameras.bin', 'Other.bin', 'Cameras.gltf'], folder).byExtension;
    assert.equal(paired.get('.gltf')?.path, join(folder, 'Cameras.gltf'));
    assert.equal(paired.get('.bin')?.path, join(folder, 'Cameras.bin'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Regression: the fixtures were listed by the pathspec packages/*/test, which git matches against whole paths, so no
// fixture was ever a sample and an example naming one (sky's catalog.gz, points' fullwave.laz) got a 404. A fixture now
// answers to its own name, and never stands in for an extension: some are odd files kept for their oddity.
test('a package test fixture answers to its own name only', () => {
  const folder = mkdtempSync(join(tmpdir(), 'readme-fixtures-'));
  try {
    writeFileSync(join(folder, 'screen.png'), Buffer.alloc(90, 3));
    writeFileSync(join(folder, 'odd.png'), Buffer.alloc(10, 1));
    writeFileSync(join(folder, 'catalog.gz'), Buffer.alloc(30, 2));
    const { byName, byExtension } = sampleFiles(['screen.png'], folder, ['odd.png', 'catalog.gz', 'screen.png']);
    assert.equal(byName.get('catalog.gz')?.path, join(folder, 'catalog.gz'));
    assert.equal(byName.get('odd.png')?.path, join(folder, 'odd.png'));
    assert.equal(byExtension.get('.png')?.path, join(folder, 'screen.png'));
    assert.equal(byExtension.has('.gz'), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  // The repository's own listing holds the fixtures.
  const listed = sampleFiles();
  assert.match(listed.byName.get('fullwave.laz')?.path ?? '', /packages[\\/]points[\\/]tests/);
});

// Regression: a tileset (JSON that links its tiles by relative path) was never served, so every tiles example failed
// with "Failed to fetch". A page now gets a file under examples/assets by its path there, links included.
test('a page gets a sample of several files by its path under examples/assets', () => {
  const folder = mkdtempSync(join(tmpdir(), 'readme-assets-'));
  try {
    mkdirSync(join(folder, 'city', 'tiles'), { recursive: true });
    writeFileSync(join(folder, 'city', 'tileset.json'), '{"root":{"content":{"uri":"tiles/a.b3dm"}}}');
    writeFileSync(join(folder, 'city', 'tiles', 'a.b3dm'), 'b3dm');
    assert.equal(assetFile('/city/tileset.json', folder)?.path, join(folder, 'city', 'tileset.json'));
    assert.equal(assetFile('/city/tiles/a.b3dm', folder)?.path, join(folder, 'city', 'tiles', 'a.b3dm'));
    assert.equal(assetFile('/city', folder), undefined);
    assert.equal(assetFile('/city/missing.json', folder), undefined);
    assert.equal(assetFile('/../outside.json', folder), undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a run starting never deletes the files of a run still going in the same checkout', () => {
  // Two runs in one worktree (2026-11-07): the second cleared the shared scratch folder, so the first one's page failed
  // to import water/readme-margoengine-water-aac7d3.tsx ("Failed to fetch dynamically imported module").
  const base = mkdtempSync(join(tmpdir(), 'readme-scratch-'));
  try {
    const live = join(base, 'run-111', 'page', 'water');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'example.tsx'), 'export {};');
    mkdirSync(join(base, 'run-222', 'page'), { recursive: true });
    mkdirSync(join(base, 'page'), { recursive: true });
    writeFileSync(join(base, 'static.glb'), '');
    const folder = claimScratch(base, 333, (pid) => pid === 111);
    assert.equal(folder, join(base, 'run-333'));
    assert.ok(existsSync(join(live, 'example.tsx')), 'the live run keeps its example');
    assert.deepEqual(readdirSync(base).sort(), ['run-111', 'run-333'], 'what gone runs and the old shared layout left is removed');
    assert.deepEqual(readdirSync(folder), ['page']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
