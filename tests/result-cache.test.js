// The content key of the result cache (scripts/support/result-cache.mjs) and the recorder under it
// (scripts/support/record-reads.mjs): same bytes same key, a changed env value or read file changes it, an untracked read
// is refused, a failure is never stored and poisons a key holding a pass, and a build gives the same bytes twice.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { classifyCommand } from '../scripts/support/record-reads.mjs';
import { archiveMetadata } from '../scripts/support/archive-metadata.mjs';
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

// macOS os.tmpdir() is /var/folders/..., a link to /private/var/folders/...: Node reports module and working folder
// paths in the real form, so a root given through a link must still own them. An explicit link fails on any system.
test('a repository reached through a symlink still owns the reads, in either spelling', (t) => {
  const { root: real, repository } = fixture(t, { 'a.js': 'one', 'b.js': 'two' });
  const root = join(temp(t), 'linked');
  symlinkSync(real, root, 'junction');
  repository.root = root;
  repository.tracked.add('step.mjs');
  const step = `import { readFileSync, writeFileSync } from 'node:fs';
    readFileSync('a.js'); readFileSync(${JSON.stringify(join(root, 'b.js'))});
    writeFileSync(${JSON.stringify(join(root, 'new.js'))}, 'x'); readFileSync('new.js');`;
  const { inputs, refused } = manifestOf(record(t, root, step), repository);
  assert.deepEqual(refused, []);
  const files = inputs.filter(([kind]) => kind === 'file').map(([, name]) => name);
  assert.deepEqual(files.sort(), ['a.js', 'b.js', 'step.mjs']);
});

test('a folder made in the temp folder is covered, whichever spelling of the temp folder made it', (t) => {
  const { root } = fixture(t);
  // The link lives in test-results/, not in the temp folder: Windows 11 (build 26300) refuses to make a folder through
  // a junction that sits in the temp folder (EEXIST), whatever it points at, and allows it elsewhere.
  const links = resolve(import.meta.dirname, '../test-results');
  mkdirSync(links, { recursive: true });
  const holder = mkdtempSync(join(links, 'result-cache-link-'));
  t.after(() => rmSync(holder, { recursive: true, force: true }));
  const real = fs.realpathSync(temp(t)),
    linkedTemp = join(holder, 'linked-temp');
  symlinkSync(real, linkedTemp, 'junction');
  const step = `import { mkdirSync } from 'node:fs';
    mkdirSync(${JSON.stringify(join(linkedTemp, 'through-link'))}); mkdirSync(${JSON.stringify(join(real, 'real'))});`;
  const { covers } = record(t, root, step, { TMPDIR: linkedTemp, TMP: linkedTemp, TEMP: linkedTemp });
  assert.deepEqual([...covers].sort(), [join(real, 'real'), join(real, 'through-link')]);
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

test('an entry another run prunes after the listing counts as not stored', (t) => {
  const store = new ResultStore(join(temp(t), 'store'));
  store.put({ step: 'step', key: 'kept', passed: true });
  const { readdirSync: list, statSync: stat } = fs,
    /** Runs `read` with the listing still naming gone.json, as if a prune landed just after it. */
    race = (read, statted) => {
      fs.readdirSync = (folder, ...rest) => [...list(folder, ...rest), 'gone.json'];
      if (statted)
        fs.statSync = (file, ...rest) =>
          String(file).endsWith('gone.json') ? { mtimeMs: Date.now() + 1000 } : stat(file, ...rest);
      syncBuiltinESMExports();
      try {
        return read();
      } finally {
        fs.readdirSync = list;
        fs.statSync = stat;
        syncBuiltinESMExports();
      }
    },
    keys = (entries) => entries.map((entry) => entry.key);
  assert.deepEqual(keys(race(() => store.candidates('step'))), ['kept'], 'gone before the stat');
  assert.deepEqual(keys(race(() => store.candidates('step'), true)), ['kept'], 'gone before the read');
  assert.equal(store.get('step', 'gone'), undefined);
});

test('a prune another run blocks leaves the entry for the next put; other errors still throw', (t) => {
  const store = new ResultStore(join(temp(t), 'store'));
  const { renameSync: move } = fs,
    refusing = (code, work) => {
      fs.renameSync = () => {
        throw Object.assign(new Error(code), { code });
      };
      syncBuiltinESMExports();
      try {
        return work();
      } finally {
        fs.renameSync = move;
        syncBuiltinESMExports();
      }
    },
    count = () => store.candidates('step').length,
    files = () => readdirSync(join(store.dir, 'steps', readdirSync(join(store.dir, 'steps'))[0])).length;
  let next = 0;
  const put = () => store.put({ step: 'step', key: `k${next++}`, passed: true });
  put();
  while (files() < 8) put();
  const full = files();
  assert.ok(count() > 0);
  for (const code of ['EPERM', 'EBUSY']) assert.equal(refusing(code, put), true, code);
  assert.equal(files(), full + 2, 'the refused entries stay for now');
  put();
  assert.equal(files(), full, 'the next put prunes them');
  assert.equal(refusing('ENOENT', put), true, 'another run moved it first');
  put();
  assert.throws(() => refusing('EIO', put), { code: 'EIO' });
});

test('a prune takes an entry off its name before deleting it, so no reader opens a file mid delete', (t) => {
  const store = new ResultStore(join(temp(t), 'store')),
    { rmSync: remove } = fs,
    deleted = [];
  fs.rmSync = (path, ...rest) => {
    deleted.push(String(path));
    return remove(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.rmSync = remove;
    syncBuiltinESMExports();
  });
  for (let key = 0; key < 12; key++) store.put({ step: 'step', key: `k${key}`, passed: true });
  assert.equal(store.candidates('step').length, 8);
  assert.ok(deleted.length > 12, 'temp names and pruned entries were deleted');
  assert.deepEqual(
    deleted.filter((path) => path.endsWith('.json')),
    [],
  );
  const folder = join(store.dir, 'steps', readdirSync(join(store.dir, 'steps'))[0]);
  assert.equal(readdirSync(folder).length, 8, 'nothing is left under a moved name');
});

test('a stored entry that cannot be parsed still throws', (t) => {
  const store = new ResultStore(join(temp(t), 'store'));
  store.put({ step: 'step', key: 'k', passed: true });
  const [folder] = readdirSync(join(store.dir, 'steps'));
  writeFileSync(join(store.dir, 'steps', folder, 'k.json'), '{');
  assert.throws(() => store.candidates('step'), SyntaxError);
});

test('a second write of one key keeps the first entry and leaves no temp file', (t) => {
  const store = new ResultStore(join(temp(t), 'store'));
  assert.equal(store.put({ step: 'step', key: 'k', passed: true, run: 'first' }), true);
  assert.equal(store.put({ step: 'step', key: 'k', passed: true, run: 'second' }), true);
  assert.equal(store.get('step', 'k').run, 'first');
  const folders = readdirSync(join(store.dir, 'steps'));
  assert.deepEqual(readdirSync(join(store.dir, 'steps', folders[0])), ['k.json']);
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

test('an output another run evicts between asking and opening counts as not stored', (t) => {
  const base = temp(t),
    store = new ResultStore(join(base, 'store')),
    folder = join(base, 'out');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'a');
  const packed = store.storeOutput('later', folder),
    { existsSync: exists } = fs;
  rmSync(packed);
  fs.existsSync = (path) => String(path) === packed || exists(path);
  syncBuiltinESMExports();
  t.after(() => {
    fs.existsSync = exists;
    syncBuiltinESMExports();
  });
  assert.equal(store.restoreOutput('later', join(base, 'back')), false);
});

test('an eviction another run blocks leaves the output for the next one; other errors still throw', (t) => {
  const base = temp(t),
    store = new ResultStore(join(base, 'store'), { capBytes: 1 }),
    folder = join(base, 'out');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'a');
  const { renameSync: move } = fs,
    refusing = (code, run) => {
      fs.renameSync = () => {
        throw Object.assign(new Error(code), { code });
      };
      syncBuiltinESMExports();
      try {
        return run();
      } finally {
        fs.renameSync = move;
        syncBuiltinESMExports();
      }
    },
    packed = refusing('EPERM', () => store.storeOutput('held', folder));
  assert.equal(existsSync(packed), true, 'it stays for now');
  assert.ok(refusing('EBUSY', () => store.evict()) > 0, 'and still counts toward the cap');
  assert.throws(() => refusing('EIO', () => store.evict()), { code: 'EIO' });
  assert.equal(store.evict(), 0, 'the next eviction takes it');
  assert.equal(existsSync(packed), false);
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

/** The old per-output stat scan is the reference; no wall-clock measurements enter this comparison. */
function outputBatchFixture(t, { fullScan = false, archives = 128, capBytes = Infinity } = {}) {
  const base = temp(t),
    store = new ResultStore(join(base, 'store'), {
      capBytes,
      readOutputs: fullScan ? (folder) => archiveMetadata(folder, { platform: 'portable' }) : undefined,
    }),
    output = join(base, 'output');
  mkdirSync(output);
  writeFileSync(join(output, 'value.txt'), 'identical output bytes');
  const packed = store.storeOutput('seed', output),
    bytes = readFileSync(packed);
  for (let i = 0; i < archives; i++) {
    const path = join(store.dir, 'dist', `seed-${i}.gz`);
    writeFileSync(path, bytes);
    utimesSync(path, 100 + i, 100 + i);
  }
  rmSync(packed, { force: true });
  return { store, output, bytes };
}

for (const atCap of [false, true]) test(`Windows output enumeration eliminates per-archive stats ${atCap ? 'at' : 'under'} cap with identical bytes`, (t) => {
  const { statSync: stat, readFileSync: read } = fs,
    counts = [],
    retained = [];
  t.after(() => {
    fs.statSync = stat;
    fs.readFileSync = read;
    syncBuiltinESMExports();
  });
  for (const fullScan of [true, false]) {
    const { store, output, bytes } = outputBatchFixture(t, { fullScan });
    if (atCap) store.capBytes = bytes.length * 128;
    let statted = 0,
      archiveBytesRead = 0;
    fs.statSync = (path, ...rest) => {
      if (dirname(String(path)) === join(store.dir, 'dist')) statted++;
      return stat(path, ...rest);
    };
    fs.readFileSync = (path, ...rest) => {
      const bytes = read(path, ...rest);
      if (dirname(String(path)) === join(store.dir, 'dist')) archiveBytesRead += bytes.length;
      return bytes;
    };
    syncBuiltinESMExports();
    for (let i = 0; i < 12; i++) store.storeOutput(`build-${i}`, output);
    counts.push({ statted, archiveBytesRead });
    fs.statSync = stat;
    fs.readFileSync = read;
    syncBuiltinESMExports();
    retained.push(readdirSync(join(store.dir, 'dist')).map((name) => [name, read(join(store.dir, 'dist', name))]));
    assert.equal(store.restoreOutput('build-11', output), true);
    assert.equal(readFileSync(join(output, 'value.txt'), 'utf8'), 'identical output bytes');
  }
  const oldStats = atCap ? 1548 : 1614;
  assert.deepEqual(counts, [
    { statted: oldStats, archiveBytesRead: 0 },
    { statted: process.platform === 'win32' ? 0 : oldStats, archiveBytesRead: 0 },
  ]);
  assert.deepEqual(retained[1], retained[0]);
});

test('native eviction sees other lanes, fresh touch ordering, ties and per-write capacity decisions', (t) => {
  const results = [];
  for (const fullScan of [true, false]) {
    const { store, output, bytes } = outputBatchFixture(t, { fullScan, archives: 4 }),
      dist = join(store.dir, 'dist'),
      snapshots = [],
      snapshot = () => snapshots.push(readdirSync(dist).filter((name) => name.endsWith('.gz')));
    {
      store.evict();
      const other = new ResultStore(store.dir);
      other.storeOutput('seed-0', output); // Another lane touches what used to be oldest.
      rmSync(join(dist, 'seed-1.gz')); // Another lane removes an output.
      writeFileSync(join(dist, 'foreign.gz'), bytes); // Another lane publishes a new key.
      utimesSync(join(dist, 'foreign.gz'), 102, 102); // Tie with seed-2: listing order still decides.
      store.capBytes = bytes.length * 4;
      store.storeOutput('new-0', output);
      snapshot();
      store.storeOutput('new-1', output);
      snapshot();
      // Returning to an evicted key must recreate it and enforce the cap at this write, too.
      store.storeOutput('foreign', output);
      snapshot();
      results.push({ snapshots, total: store.evict() });
    }
    assert.equal(existsSync(join(dist, 'seed-0.gz')), true, 'the other lane refreshed its timestamp');
    assert.equal(existsSync(join(dist, 'seed-2.gz')), false, 'the old timestamp is evicted');
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[1].snapshots[0].includes('foreign.gz'), false, 'equal timestamps retain listing order');
});

test('every eviction observes timestamps moved backwards by another lane', (t) => {
  const { store, bytes } = outputBatchFixture(t, { archives: 2 }),
    newest = join(store.dir, 'dist', 'seed-1.gz');
  store.evict();
  utimesSync(newest, 1, 1);
  store.capBytes = bytes.length;
  assert.equal(store.evict(), bytes.length);
  assert.equal(existsSync(newest), false);
  assert.equal(existsSync(join(store.dir, 'dist', 'seed-0.gz')), true);
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

// Found on 2026-11-06: build:package:fbx and build:package:usdz reported "same inputs built different bytes" after a
// rebase that changed only gltf-pro. Their worker bundles take in gltf-pro's dist, which the key did not name.
test('a package build keys on the dist of what it depends on, near and far, and of nothing else', (t) => {
  const files = {
    'package.json': '{}',
    'packages/app/package.json': JSON.stringify({ name: '@x/app', peerDependencies: { '@x/near': '1' } }),
    'packages/app/src/index.js': 'app',
    'packages/near/package.json': JSON.stringify({ name: '@x/near', dependencies: { '@x/far': '1' } }),
    'packages/far/package.json': JSON.stringify({ name: '@x/far' }),
    'packages/other/package.json': JSON.stringify({ name: '@x/other' }),
  };
  const { root, repository } = fixture(t, files);
  for (const name of ['app', 'near', 'far', 'other']) mkdirSync(join(root, `packages/${name}/dist`));
  const dist = (name) => join(root, `packages/${name}/dist/index.js`);
  for (const name of ['near', 'far', 'other']) writeFileSync(dist(name), name);
  repository.tracked.add('build.mjs');
  const script = join(root, 'build.mjs');
  writeFileSync(
    script,
    `import { readFileSync } from 'node:fs';
await globalThis[Symbol.for('margoengine.recordReads')].job('package:app', async () =>
  readFileSync('packages/app/src/index.js'),
);
`,
  );
  const store = new ResultStore(join(temp(t), 'store'));
  const build = () => {
    const run = shadowRun(t, repository, store),
      { dir, env } = run.stepEnv(),
      result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    // The bundler reads and writes natively: the recorder sees none of this, as in a real build.
    writeFileSync(dist('app'), `${readFileSync(dist('near'))} ${readFileSync(dist('far'))}`);
    const [row] = run.finish('npm run build:packages', dir, { kind: 'builds', code: 0 });
    assert.deepEqual(row.refused, []);
    return { row, disagreements: run.disagreements };
  };
  assert.equal(build().row.cache.wouldHit, false);
  assert.equal(build().row.cache.wouldHit, true, 'nothing changed');
  writeFileSync(dist('other'), 'changed');
  assert.equal(build().row.cache.wouldHit, true, 'a package it does not depend on changes nothing');
  for (const name of ['near', 'far']) {
    writeFileSync(dist(name), `${name} changed`);
    const { row, disagreements } = build();
    assert.equal(row.cache.wouldHit, false, `a changed ${name} dist is a changed input`);
    assert.deepEqual(disagreements, [], 'and never reads as same inputs, different bytes');
  }
});

function withoutRecorder() {
  const env = { ...process.env };
  delete env.MARGO_RECORD_DIR;
  delete env.MARGO_RECORD_SCOPE;
  delete env.MARGO_RECORD_PER_TEST;
  delete env.NODE_OPTIONS;
  return env;
}

test('jobs side by side keep their own reads and children, even when their work overlaps', (t) => {
  const { root } = fixture(t, { 'a.js': 'one', 'b.js': 'two', 'shared.js': 'three' });
  const dir = join(temp(t), 'logs'),
    script = join(root, 'step.mjs');
  writeFileSync(
    script,
    `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { recordJob } from ${JSON.stringify(recorder)};
const pause = () => new Promise((done) => setTimeout(done, 5));
const job = (name, file) => recordJob(name, async () => {
  for (let i = 0; i < 3; i++) { readFileSync(file); await pause(); }
  spawnSync(process.execPath, ['-e', "require('fs').readFileSync(process.argv[1])", 'child-' + file], { stdio: 'ignore' });
});
readFileSync('shared.js');
await Promise.all([job('package:a', 'a.js'), job('package:b', 'b.js')]);
`,
  );
  writeFileSync(join(root, 'child-a.js'), 'x');
  writeFileSync(join(root, 'child-b.js'), 'y');
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...withoutRecorder(), MARGO_RECORD_DIR: dir, NODE_OPTIONS: `--import=${recorder}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const { scopes } = collectLogs(dir),
    names = (scope) => [...scopes.get(scope).reads.keys()].map((path) => path.replace(/\\/g, '/').split('/').pop());
  for (const [scope, own, other] of [
    ['package:a', 'a.js', 'b.js'],
    ['package:b', 'b.js', 'a.js'],
  ]) {
    assert.ok(names(scope).includes(own), `${scope} read ${own}`);
    assert.ok(names(scope).includes(`child-${own}`), `${scope}'s child belongs to it`);
    assert.ok(!names(scope).includes(other), `${scope} did not read ${other}`);
    assert.ok(!names(scope).includes(`child-${other}`));
  }
  assert.ok(names('').includes('shared.js'), 'outside any job stays the step');
});

// Windows reuses process ids within one long step (found while building the recorder): a log named by the id alone was
// overwritten by the later process, and that process's reads vanished from the key.
test('two processes with one process id keep two logs', (t) => {
  const { root } = fixture(t, { 'first.js': '1', 'second.js': '2' });
  const dir = join(temp(t), 'logs'),
    script = join(root, 'step.mjs'),
    samePid = 'data:text/javascript,Object.defineProperty(process,"pid",{value:4242})';
  writeFileSync(script, "import { readFileSync } from 'node:fs'; readFileSync(process.argv[2]);\n");
  for (const file of ['first.js', 'second.js']) {
    const result = spawnSync(process.execPath, [`--import=${samePid}`, `--import=${recorder}`, script, file], {
      cwd: root,
      env: { ...withoutRecorder(), MARGO_RECORD_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const logs = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(logs.length, 2, 'one log for each process');
  const reads = [...collectLogs(dir).scopes.get('').reads.keys()].join(' ');
  assert.ok(reads.includes('first.js') && reads.includes('second.js'), reads);
});

test('evict takes a stored output another run removed while it was looking', (t) => {
  const dir = join(temp(t), 'store'),
    store = new ResultStore(dir, {
      capBytes: 1,
      readOutputs: (folder) => archiveMetadata(folder, { platform: 'portable' }),
    }),
    folder = join(temp(t), 'out');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'a.txt'), 'a');
  store.storeOutput('kept', folder);
  const gone = join(dir, 'dist', 'gone.gz'),
    real = fs.statSync;
  writeFileSync(gone, 'x');
  fs.statSync = (path, ...rest) => {
    if (path === gone) fs.rmSync(gone, { force: true });
    return real(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.statSync = real;
    syncBuiltinESMExports();
  });
  assert.equal(store.evict(), 0);
});
