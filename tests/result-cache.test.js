// The content key of the result cache (scripts/support/result-cache.mjs) and the recorder under it
// (scripts/support/record-reads.mjs): same bytes same key, a changed env value or read file changes it, an untracked read
// is refused, a failure is never stored and poisons a key holding a pass, and a build gives the same bytes twice.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { classifyCommand } from '../scripts/support/record-reads.mjs';
import {
  buildManifest,
  collectLogs,
  computeKey,
  defaultStoreDir,
  hashFolder,
  ResultStore,
  ShadowRun,
  servingRequested,
} from '../scripts/support/result-cache.mjs';

const repo = resolve(import.meta.dirname, '..'),
  recorder = pathToFileURL(join(repo, 'scripts/support/record-reads.mjs')).href,
  facts = { node: 'v0', npm: '0', os: 'test', profile: 'test' };

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'result-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A small fake repository: the files, what git tracks, and a lock file. */
function fixture(t, files = { 'a.js': 'one', 'b.js': 'two' }, tracked = Object.keys(files)) {
  const root = temp(t);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
  return {
    root,
    repository: { root: resolve(root), tracked: new Set(tracked), dirty: new Set(), lock: {} },
  };
}

/** Runs a script under the recorder and returns the merged record of the process. */
function record(t, root, source, env = {}) {
  const dir = join(temp(t), 'logs'),
    script = join(root, 'step.mjs');
  writeFileSync(script, source);
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...withoutRecorder(), MARGO_RECORD_DIR: dir, NODE_OPTIONS: `--import=${recorder}`, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return collectLogs(dir).scopes.get('');
}

const hasher = () => ({ value: statValue });
function statValue(kind, path) {
  try {
    return kind === 'e' ? 'present' : `file ${readFileSync(path, 'latin1')}`;
  } catch {
    return 'absent';
  }
}
const manifestOf = (rec, repository, outputs = new Set()) =>
  buildManifest(rec, { repository, hasher: hasher(), outputs });

const READS = `import { readFileSync } from 'node:fs'; readFileSync('a.js'); void process.env.BROWSER_ARGS;`;

test('the same bytes give the same key, whatever order they were read in', (t) => {
  const { root, repository } = fixture(t);
  const one = manifestOf(record(t, root, READS, { BROWSER_ARGS: 'x' }), repository);
  const two = manifestOf(record(t, root, READS, { BROWSER_ARGS: 'x' }), repository);
  assert.ok(one.inputs.some(([kind, name]) => kind === 'file' && name === 'a.js'));
  assert.equal(computeKey('s', one.inputs, facts), computeKey('s', two.inputs, facts));
  assert.equal(computeKey('s', [...one.inputs].reverse(), facts), computeKey('s', one.inputs, facts));
});

test('a changed read file changes the key; a file nobody read does not', (t) => {
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  const before = computeKey('s', manifestOf(record(t, root, READS), repository).inputs, facts);
  writeFileSync(join(root, 'b.js'), 'not read');
  assert.equal(computeKey('s', manifestOf(record(t, root, READS), repository).inputs, facts), before);
  writeFileSync(join(root, 'a.js'), 'changed');
  assert.notEqual(computeKey('s', manifestOf(record(t, root, READS), repository).inputs, facts), before);
});

test('a changed env value changes the key, and so does the same name going absent', (t) => {
  const { root, repository } = fixture(t);
  const keyWith = (env) => computeKey('s', manifestOf(record(t, root, READS, env), repository).inputs, facts);
  assert.notEqual(keyWith({ BROWSER_ARGS: 'x' }), keyWith({ BROWSER_ARGS: 'y' }));
  assert.notEqual(keyWith({ BROWSER_ARGS: 'x' }), keyWith({}));
});

test('a copy of the whole environment is not a read of every name', (t) => {
  const { root } = fixture(t);
  const rec = record(t, root, 'const copy = { ...process.env }; void copy; void process.env.NAMED;', { UNREAD: '1' });
  assert.ok(rec.env.has('NAMED'));
  assert.ok(!rec.env.has('UNREAD'));
});

test('an untracked read is refused, and names the file', (t) => {
  const { root, repository } = fixture(t, { 'a.js': 'one', 'test-results/left-over.json': '{}' }, ['a.js']);
  repository.tracked.add('step.mjs');
  const { refused } = manifestOf(
    record(t, root, `import { readFileSync } from 'node:fs'; readFileSync('test-results/left-over.json');`),
    repository,
  );
  assert.equal(refused.length, 1);
  assert.match(refused[0], /untracked read: test-results\/left-over\.json/);
});

test("a read of an earlier step's output is allowed; a read of the step's own output is not an input", (t) => {
  const { root, repository } = fixture(t, { 'out.js': 'built' }, []);
  repository.tracked.add('step.mjs');
  const earlier = `import { readFileSync } from 'node:fs'; readFileSync('out.js');`;
  assert.deepEqual(manifestOf(record(t, root, earlier), repository, new Set(['out.js'])).refused, []);
  const own = manifestOf(
    record(
      t,
      root,
      `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync('new.js', 'x'); readFileSync('new.js');`,
    ),
    repository,
  );
  assert.deepEqual(own.refused, []);
  assert.ok(!own.inputs.some(([, name]) => name === 'new.js'));
});

test('a file with uncommitted changes, an LFS pointer, a rewritten input and the network are refused', (t) => {
  const { root, repository } = fixture(t, { 'a.js': 'one', 'lfs.bin': 'version https://git-lfs.github.com/spec/v1\n' });
  repository.tracked.add('step.mjs');
  repository.dirty.add('a.js');
  const realHasher = { value: (kind, path) => (kind === 'e' ? 'present' : `file ${readFileSync(path, 'latin1')}`) };
  const refusedFor = (source) => {
    const rec = record(t, root, source);
    return buildManifest(rec, { repository, hasher: realHasher, outputs: new Set() }).refused.join('\n');
  };
  assert.match(
    refusedFor(`import { readFileSync } from 'node:fs'; readFileSync('a.js');`),
    /uncommitted changes: a\.js/,
  );
  assert.match(refusedFor(`import { readFileSync } from 'node:fs'; readFileSync('lfs.bin');`), /LFS pointer: lfs\.bin/);
  assert.match(
    refusedFor(
      `import { readFileSync, writeFileSync } from 'node:fs'; readFileSync('b.txt', { flag: 'a+' }); writeFileSync('b.txt', 'x');`,
    ),
    /reads and then rewrites b\.txt/,
  );
  assert.match(
    refusedFor(`import net from 'node:net'; net.connect({ host: 'example.invalid', port: 1 }).on('error', () => {});`),
    /uses the network: example\.invalid/,
  );
});

test('Math.random from a step file marks it nondeterministic; from infrastructure it does not', (t) => {
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  const { refused } = manifestOf(record(t, root, 'Math.random();'), repository);
  assert.match(refused.join('\n'), /nondeterministic: step\.mjs calls Math\.random/);
  const clean = manifestOf(record(t, root, 'void 1;'), repository);
  assert.deepEqual(clean.refused, []);
});

test('reads in a child process are recorded, also when the child is given its own env', (t) => {
  const { root } = fixture(t);
  const rec = record(
    t,
    root,
    `import { spawnSync } from 'node:child_process';
     spawnSync(process.execPath, ['-e', 'require("fs").readFileSync("a.js"); void process.env.CHILD_NAME'], { env: { KEEP: '1' } });`,
  );
  assert.ok([...rec.reads.keys()].some((path) => path.endsWith('a.js')));
  assert.ok(rec.env.has('CHILD_NAME'));
});

test('a git probe that exits non-zero is an input, not a crash', (t) => {
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  spawnSync('git', ['init', '-q'], { cwd: root });
  const rec = record(
    t,
    root,
    `import { spawnSync } from 'node:child_process'; spawnSync('git', ['rev-parse', '--verify', '--quiet', 'no-such-commit']);`,
  );
  const { inputs, refused } = manifestOf(rec, repository);
  assert.deepEqual(refused, []);
  const row = inputs.find(([kind]) => kind === 'git');
  assert.match(row[3], /^1 /);
});

test('a native bundler or linter widens the key to the committed tree, leaving out documents', (t) => {
  const { root, repository } = fixture(t, { 'a.js': 'one', 'packages/x/dist/i.js': 'b' });
  repository.tracked.add('step.mjs');
  repository.stage = ['100644 aaa 0\tsrc/a.js', '100644 bbb 0\tdocs/a.md'];
  const rec = record(t, root, 'void 1;');
  rec.opaque.add('biome');
  const before = manifestOf(rec, repository);
  assert.ok(before.inputs.some(([kind]) => kind === 'tree'));
  assert.ok(before.inputs.some(([kind]) => kind === 'all-dist'));
  repository.stage = ['100644 aaa 0\tsrc/a.js', '100644 ccc 0\tdocs/a.md'];
  assert.equal(computeKey('s', manifestOf(rec, repository).inputs, facts), computeKey('s', before.inputs, facts));
  repository.stage = ['100644 ddd 0\tsrc/a.js', '100644 ccc 0\tdocs/a.md'];
  assert.notEqual(computeKey('s', manifestOf(rec, repository).inputs, facts), computeKey('s', before.inputs, facts));
});

test('the pnpm marker probe, made only on some paths, is not an input', (t) => {
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  const { inputs } = manifestOf(
    record(t, root, `import { existsSync } from 'node:fs'; existsSync('node_modules/.modules.yaml');`),
    repository,
  );
  assert.ok(!inputs.some(([, name]) => name === 'node_modules/.modules.yaml'));
});

test('a command path with spaces is still node; an unknown program is opaque', () => {
  assert.equal(classifyCommand('C:\\Program Files\\nodejs\\node.exe', true).kind, 'node');
  assert.equal(classifyCommand('git rev-parse HEAD').args.join(' '), 'rev-parse HEAD');
  assert.equal(classifyCommand('cmd /c npm run x').kind, 'node');
  assert.deepEqual(classifyCommand('cargo build'), { kind: 'opaque', program: 'cargo' });
});

let runs = 0;

/** One shadow run over a store, for the pass and failure rules. */
function shadowRun(t, repository, store, env = {}) {
  return new ShadowRun({
    root: repository.root,
    store,
    repository,
    facts,
    runId: `run-${++runs}`,
    commit: 'c1',
    env: { ...withoutRecorder(), ...env },
  });
}
function runStep(t, shadow, root, source, code = 0) {
  const { dir, env } = shadow.stepEnv();
  writeFileSync(join(root, 'step.mjs'), source);
  spawnSync(process.execPath, [join(root, 'step.mjs')], { cwd: root, env });
  return shadow.finish('step', dir, { kind: 'step', code, seconds: 2 })[0];
}

test('a failure is never stored', (t) => {
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  const store = new ResultStore(join(temp(t), 'store'));
  const failed = runStep(t, shadowRun(t, repository, store), root, READS, 1);
  assert.equal(failed.passed, false);
  assert.deepEqual(store.candidates('step'), []);
  assert.throws(() => store.put({ step: 'step', key: 'k', passed: false }), /only a first-try pass/);
});

test('a pass is stored, the next run would hit it, and the step still ran', (t) => {
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  const store = new ResultStore(join(temp(t), 'store'));
  const first = runStep(t, shadowRun(t, repository, store), root, READS);
  assert.equal(first.cache.wouldHit, false);
  const second = runStep(t, shadowRun(t, repository, store), root, READS);
  assert.equal(second.cache.wouldHit, true);
  assert.equal(second.cache.hit, false, 'shadow mode never serves');
  assert.equal(second.cache.from.commit, 'c1');
  writeFileSync(join(root, 'a.js'), 'changed');
  assert.equal(runStep(t, shadowRun(t, repository, store), root, READS).cache.wouldHit, false);
});

test('a failure on a key holding a pass poisons it and writes the ledger', (t) => {
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  mkdirSync(join(root, 'test-results'));
  const store = new ResultStore(join(temp(t), 'store'));
  const pass = runStep(t, shadowRun(t, repository, store), root, READS);
  assert.ok(pass.key);
  const shadow = shadowRun(t, repository, store);
  const failed = runStep(t, shadow, root, READS, 1);
  assert.equal(failed.cache.wouldHit, true);
  assert.equal(store.isPoisoned(pass.key), true);
  assert.equal(store.get('step', pass.key), undefined);
  const ledger = JSON.parse(readFileSync(join(root, 'test-results/cache/disagreements.json'), 'utf8'));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, 'failed-on-stored-pass');
  assert.equal(ledger[0].storedKey, pass.key);
  // Poisoned for good: a later pass on the same bytes is not stored and would not hit.
  const later = runStep(t, shadowRun(t, repository, store), root, READS);
  assert.equal(later.cache.wouldHit, false);
  assert.deepEqual(store.candidates('step'), []);
});

test('asking for serving changes nothing: every step still runs', (t) => {
  assert.equal(servingRequested({ MARGO_RESULT_CACHE_SERVE: '1' }), true);
  const { root, repository } = fixture(t);
  repository.tracked.add('step.mjs');
  const store = new ResultStore(join(temp(t), 'store'));
  runStep(t, shadowRun(t, repository, store), root, READS);
  const marker = `import { writeFileSync } from 'node:fs'; ${READS.replace(/^import[^;]*;/, "import { readFileSync } from 'node:fs';")} writeFileSync('ran.txt', 'yes');`;
  const shadow = shadowRun(t, repository, store, { MARGO_RESULT_CACHE_SERVE: '1' });
  const row = runStep(t, shadow, root, marker);
  assert.equal(row.cache.hit, false);
  assert.equal(readFileSync(join(root, 'ran.txt'), 'utf8'), 'yes');
});

test('a stored output comes back byte for byte, and the store keeps to its cap, oldest out', (t) => {
  const base = temp(t),
    folder = join(base, 'dist');
  mkdirSync(join(folder, 'inner'), { recursive: true });
  writeFileSync(join(folder, 'a.js'), 'alpha');
  writeFileSync(join(folder, 'inner/b.js'), 'beta');
  const expected = hashFolder(folder),
    store = new ResultStore(join(base, 'store'), { capBytes: 200 });
  store.storeOutput('k1', folder);
  writeFileSync(join(folder, 'stale.js'), 'must go');
  assert.equal(store.restoreOutput('k1', folder), true);
  assert.equal(hashFolder(folder), expected);
  assert.equal(store.restoreOutput('missing', folder), false);
  const big = join(base, 'big');
  mkdirSync(big);
  writeFileSync(join(big, 'x.bin'), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 2654435761) >>> 24)));
  store.storeOutput('k2', big);
  assert.equal(store.restoreOutput('k1', folder), false, 'the older entry left to stay under the cap');
});

test('the store lives in the per-user folder', () => {
  assert.equal(defaultStoreDir({ LOCALAPPDATA: 'L' }), join('L', 'margoengine', 'result-cache'));
});

test('building three small packages twice gives the same bytes', { timeout: 120_000 }, (t) => {
  // In a temp tree, because verify runs this file beside steps that read the real dist folders.
  const tree = temp(t),
    names = ['fsm', 'splines', 'road'];
  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'LICENSE', 'NOTICE'])
    try {
      cpSync(join(repo, file), join(tree, file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  const manifest = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
  manifest.workspaces = names.map((name) => `packages/${name}`);
  writeFileSync(join(tree, 'package.json'), JSON.stringify(manifest));
  for (const name of names)
    cpSync(join(repo, 'packages', name), join(tree, 'packages', name), {
      recursive: true,
      filter: (path) => !/[\\/](dist|node_modules)$/.test(path),
    });
  cpSync(join(repo, 'packages/shared'), join(tree, 'packages/shared'), { recursive: true });
  cpSync(join(repo, 'packages/core/src/wasm.ts'), join(tree, 'packages/core/src/wasm.ts'));
  cpSync(join(repo, 'packages/gltf/tsconfig.json'), join(tree, 'packages/gltf/tsconfig.json'));
  // The build's modules read every package's manifest when they load.
  for (const name of readdirSync(join(repo, 'packages'))) {
    const file = join(repo, 'packages', name, 'package.json');
    if (existsSync(file) && !names.includes(name)) cpSync(file, join(tree, 'packages', name, 'package.json'));
  }
  // The build finds packages from its own location, so the scripts must sit in the temp tree too.
  cpSync(join(repo, 'scripts'), join(tree, 'scripts'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'junction');
  const build = () => {
    const result = spawnSync(
      process.execPath,
      [join(tree, 'scripts/build-modern.js'), '--precompiled', `--only=${names.join(',')}`],
      { cwd: tree, encoding: 'utf8', env: withoutRecorder() },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return names.map((name) => hashFolder(join(tree, 'packages', name, 'dist')));
  };
  assert.deepEqual(build(), build());
});

function withoutRecorder() {
  const env = { ...process.env };
  delete env.MARGO_RECORD_DIR;
  delete env.MARGO_RECORD_SCOPE;
  delete env.MARGO_RECORD_PER_TEST;
  delete env.NODE_OPTIONS;
  return env;
}
