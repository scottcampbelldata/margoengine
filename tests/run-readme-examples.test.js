import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleIds, readmeEntries } from '../scripts/support/readme-types.mjs';
import {
  askedElements,
  eachPage,
  goneLine,
  judge,
  listenPort,
  namedFiles,
  nodeTurns,
  pickExamples,
  placeOf,
  runInNode,
  runInPage,
  assetFile,
  claimScratch,
  sampleFiles,
  collectExamples,
  companionFiles,
  usesMinimalGLTF,
  writePageExample,
} from '../scripts/run-readme-examples.mjs';
import { workspacePackages } from '../scripts/check-readme-types.mjs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const samples = { byName: new Map(), byExtension: new Map() };

test('one GPU slot runs every complete page lifecycle in order without overlapping examples', async () => {
  const started = [],
    finished = [];
  let release,
    active = 0,
    peak = 0;
  const pending = eachPage(['first', 'second', 'third'], async (id) => {
    started.push(id);
    peak = Math.max(peak, ++active);
    if (id === 'first')
      await new Promise((resolve) => {
        release = resolve;
      });
    await new Promise((resolve) => setImmediate(resolve));
    finished.push(id);
    active--;
  });
  assert.deepEqual(started, ['first'], 'no second browser workload competes with the held page');
  release();
  await pending;
  assert.equal(peak, 1);
  assert.deepEqual(started, ['first', 'second', 'third']);
  assert.deepEqual(finished, started, 'all examples do the same work');
  const failure = new Error('failed lifecycle'),
    later = [];
  await assert.rejects(
    eachPage(['first', 'second'], async (id) => {
      later.push(id);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(later, ['first'], 'a terminated browser schedules no later page');
});

test('loader rendering and resolver examples choose one host, and OBJ examples fetch mesh bytes', () => {
  const examples = readmeEntries(readFileSync('packages/loaders/README.md', 'utf8')),
    render = examples.find(({ heading }) => heading === 'Optional vertex color and opacity rendering');
  assert.ok(render);
  assert.equal(placeOf(render.code), 'page');
  assert.doesNotMatch(render.code, /node:/, 'a browser render cannot carry disk resolver imports');
  const obj = examples.filter(({ heading }) => heading === 'Textured OBJ meshes');
  assert.equal(obj.length, 2);
  for (const { code } of obj) {
    assert.doesNotMatch(code, /https:\/\/example\.com/, 'the documented sample must be served by the reader project');
    assert.doesNotMatch(code, /fetch\(['"][^'"]+\.mtl['"]\)/, 'parseOBJ needs OBJ bytes, not an MTL library');
  }
  assert.match(
    obj[1].code,
    /new URL\('\/models\/crate.obj', location.href\).href/,
    'material maps need an absolute base URL',
  );
  assert.match(obj[1].code, /fetch\(objUrl\)/);
});

test('the Node Basis example has a Node host and any execution failure fails the gate', () => {
  const example = collectExamples(workspacePackages()).find(
    ({ name, code }) => name === 'decoders' && /nodeKTX2/.test(code) && /loadGLTF/.test(code),
  );
  assert.ok(example, 'the documented Node Basis load must remain an executable example');
  assert.equal(placeOf(example.code), 'node', 'a Node example cannot depend on a page canvas');
  assert.deepEqual(askedElements(example.code), []);
  const known = JSON.parse(readFileSync('scripts/support/readme-run-known.json', 'utf8'));
  const result = judge([{ id: example.id, result: 'fail' }], known, true);
  assert.equal(result.fresh.length, 1, 'a failure must not be grandfathered as a passing check');
});

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

test('a browser assertion that never finishes fails instead of passing as an ongoing server', async () => {
  const result = await runInNode(
    {
      id: 'runner-test/browser-wait',
      code: "import { chromium } from '@playwright/test'; await new Promise(() => { setInterval(() => {}, 1000); });",
    },
    samples,
    { timeout: 500 },
  );
  assert.equal(result.result, 'fail');
  assert.match(result.reason, /Browser test did not finish/);
});

test('any unfinished Node example fails, including one with live handles and no error', async () => {
  const result = await runInNode(
    { id: 'runner-test/unfinished', code: 'await new Promise(() => setInterval(() => {}, 1000));' },
    samples,
    { timeout: 500 },
  );
  assert.equal(result.result, 'fail');
  assert.match(result.reason, /Example did not finish/);
});

test('a page whose module never completes fails even with no page error', async () => {
  let closed = false;
  const result = await runInPage(
    { id: 'runner-test/unfinished-page', code: 'await new Promise(() => {});' },
    {
      origin: 'http://example.test',
      browser: {
        newPage: async () => ({
          goto: async () => {},
          waitForFunction: async () => {
            throw new Error('Example module did not finish');
          },
          waitForTimeout: async () => {},
          evaluate: async () => [],
          close: async () => {
            closed = true;
          },
        }),
      },
    },
  );
  assert.equal(result.result, 'fail');
  assert.match(result.reason, /did not finish/);
  assert.equal(closed, true);
});

for (const phase of ['creating page', 'reading errors', 'closing page']) {
  test(`the whole page deadline bounds ${phase} and closes the owning browser`, async () => {
    let browserClosed = false;
    const never = () => new Promise(() => {});
    const page = {
      goto: async () => {},
      waitForFunction: async () => {},
      waitForTimeout: async () => {},
      evaluate: phase === 'reading errors' ? never : async () => [],
      close: phase === 'closing page' ? never : async () => {},
    };
    const pages = {
      origin: 'http://example.test',
      browser: {
        newPage: phase === 'creating page' ? never : async () => page,
        close: async () => {
          browserClosed = true;
        },
      },
    };
    const result = await runInPage({ id: `runner-test/${phase.replaceAll(' ', '-')}`, code: 'export {}' }, pages, {
      timeout: 50,
    });
    assert.equal(result.result, 'fail');
    assert.match(result.reason, new RegExp('while ' + phase));
    assert.equal(browserClosed, true);
    assert.match(pages.failed, /did not finish/);
  });
}

test('TypeScript runs as a reader would paste it', async () => {
  const result = await runInNode(
    { id: 'runner-test/passes', code: 'const size: number = 2;\nconsole.log(size);' },
    samples,
  );
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
  const block = "```ts\nimport 'a';\n```\n",
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
  assert.equal(
    placeOf("import { chromium } from 'playwright'; await page.waitForFunction(() => document.title);"),
    'node',
  );
  assert.equal(placeOf("import { test } from '@playwright/test'; document.title;"), 'node');
});

test('the static fixture follows the imported loader, including Stage and umbrella aliases', () => {
  for (const name of ['@margoengine/gltf', '@margoengine/stage/gltf', 'margoengine/gltf', 'margoengine/stage/gltf']) {
    assert.equal(usesMinimalGLTF(`import { load } from '${name}';`), true);
    assert.equal(usesMinimalGLTF(`await import('${name}');`), true);
  }
  for (const name of ['@margoengine/gltf-pro', 'margoengine/gltf-pro', 'margoengine/stage/viewer'])
    assert.equal(usesMinimalGLTF(`import { load } from '${name}';`), false);
});

test('named page and worker sources are written together, including the emitted JS worker URL', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'readme-worker-'));
  try {
    const code = '// page.ts\nnew Worker(new URL("./scene-worker.js", import.meta.url), {type: "module"});',
      worker = '// scene-worker.ts\nconst value: number = 42;\npostMessage(value);',
      files = companionFiles([{ code }, { code: worker }, { code: '// ../outside.ts\nthrow 1;' }]);
    assert.deepEqual(Object.keys(files), ['page.ts', 'scene-worker.ts']);
    const url = await writePageExample({ id: 'worker/one', code, files }, folder);
    assert.equal(url, '/worker/one/example.tsx');
    assert.equal(readFileSync(join(folder, 'worker/one/scene-worker.ts'), 'utf8'), worker);
    const js = readFileSync(join(folder, 'worker/one/scene-worker.js'), 'utf8');
    assert.match(js, /postMessage\(value\)/);
    assert.doesNotMatch(js, /: number/);
    await writePageExample({ id: 'worker/two', code: 'export {};' }, folder);
    assert.equal(existsSync(join(folder, 'worker/two/scene-worker.js')), false);
    const collected = collectExamples(workspacePackages()).find(
      ({ id }) => id === 'worker/readme-margoengine-worker-b56e85',
    );
    assert.match(collected.files['scene-worker.ts'], /receiveCanvas\(\)/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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
    assert.deepEqual(
      readdirSync(base).sort(),
      ['run-111', 'run-333'],
      'what gone runs and the old shared layout left is removed',
    );
    assert.deepEqual(readdirSync(folder), ['page']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('every known-list entry names an example the READMEs still hold, so an edit that renames one is seen in verify', () => {
  // An example's id carries a hash of its code, so a README edit renames it. check:readme-run is a GPU step of the full
  // check only, so on 2026-11-07 eight renamed known failures (2 animator, 6 ragdoll) went unseen until it ran.
  const known = JSON.parse(readFileSync(new URL('../scripts/support/readme-run-known.json', import.meta.url), 'utf8')),
    ids = new Set(collectExamples(workspacePackages()).map(({ id }) => id)),
    gone = Object.keys(known).filter((id) => !ids.has(id));
  assert.deepEqual(
    gone,
    [],
    'run npm run check:readme-run -- --only=<package> and fix the renamed example, or -- --shrink if it passes',
  );
});

test('headless comparison examples prepare their own reference before the unchanged example', async (t) => {
  const { encodePNG } = await import('../packages/headless/dist/index.js');
  mkdirSync('test-results', { recursive: true });
  const wrong = join(process.cwd(), 'test-results', 'readme-reference-' + process.pid + '.png');
  const bytes = await encodePNG({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) });
  writeFileSync(wrong, bytes);
  t.after(() => rmSync(wrong, { force: true }));
  const code = `import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { encodePNG } from '@margoengine/headless';
import { compareImages } from '@margoengine/headless/compare';
const engine = { width: 3, height: 2, data: new Uint8Array(24).fill(80) };
const readPixels = async (engine) => engine;
const result = await compareImages(await readPixels(engine), await readFile('reference.png'));
assert.ok(result.pass);`;
  const result = await runInNode({ id: 'runner-test/headless-reference', code }, {
    byName: new Map([['reference.png', { path: wrong }]]), byExtension: new Map(),
  });
  assert.equal(result.result, 'pass', result.reason);
  assert.deepEqual(readFileSync(wrong), Buffer.from(bytes), 'the external reference fixture is never changed');
});
