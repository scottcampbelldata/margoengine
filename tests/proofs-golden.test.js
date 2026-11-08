// Golden outputs for the --current proofs (examples/package-benchmarks/proofs/golden.js). A fresh clone of main once
// failed `npm run verify`: 14 of the 20 --current proofs rebuilt their baselines with `git rev-parse` / `git show` on
// commits that existed only in one PC's pre-rewrite history. Now a --current run reads stored outputs and never asks
// Git; these tests pin that down: lossless storage, the SHA-256 check, tapes that catch a changed function, read mode
// refusing Git, and pinned runs reporting HISTORICAL for a commit the clone lacks. They also cover canonicalNaN, the
// fix for geometry.proof.js failing at random on NaN bit patterns.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { canonicalNaN, decode, digest, encode, exactMath } from '../examples/package-benchmarks/proofs/golden.js';

const proofs = resolve(import.meta.dirname, '../examples/package-benchmarks/proofs');
const url = (file) => pathToFileURL(join(proofs, file)).href;

test('encode/decode keep every byte, NaN, -0, undefined, Maps, Sets and a "$" key', () => {
  const nan = new Float64Array(2);
  new DataView(nan.buffer).setBigUint64(0, 0xfff8000000000001n, true); // a NaN with a payload
  const value = {
    $: 'not a tag',
    list: [1, -0, NaN, Infinity, -Infinity, undefined, null, 'x', true, 10n],
    f32: new Float32Array([1.5, -0]),
    nan,
    u8: new Uint8Array([0, 255]),
    buffer: new Uint8Array([1, 2, 3]).buffer,
    map: new Map([[1, { a: [2] }]]),
    set: new Set(['a', 'b']),
  };
  const back = decode(JSON.parse(JSON.stringify(encode(value))));
  assert.deepStrictEqual(back, value);
  assert.equal(
    Buffer.from(back.nan.buffer).toString('hex'),
    Buffer.from(nan.buffer).toString('hex'),
    'NaN payload kept',
  );
  assert.ok(Object.is(back.list[1], -0));
  assert.throws(() => encode({ f() {} }), /cannot store a function/);
  assert.throws(() => encode(new (class Thing {})()), /cannot store a Thing/);
  assert.notEqual(digest(encode([0])), digest(encode([-0])));
});

test('canonicalNaN: NaN payloads compare equal, every other bit still counts', () => {
  const a = new Float32Array([NaN, 1]),
    b = new Float32Array([NaN, 1]);
  new DataView(b.buffer).setUint32(0, 0xffc00000, true); // x86's default NaN (sign set)
  assert.notDeepStrictEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
  assert.deepStrictEqual(canonicalNaN({ x: [a] }), canonicalNaN({ x: [b] }));
  assert.notDeepStrictEqual(canonicalNaN(new Float64Array([0])), canonicalNaN(new Float64Array([-0])));
  const plain = new Float32Array([1, 2]);
  assert.equal(canonicalNaN(plain), plain, 'an array without NaN is returned as it is');
});

/** Runs a small "proof" in a child with its own baselines folder; returns { status, out }. */
function proof(dir, body, env = {}) {
  const file = join(dir, 'tiny.proof.js');
  writeFileSync(
    file,
    `import { begin, golden, tape, fact, deterministicMath } from ${JSON.stringify(url('golden.js'))};\n${body}\n`,
  );
  const result = spawnSync(process.execPath, [file], {
    cwd: resolve(proofs, '../../..'),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PROOFS_BASELINES: join(dir, 'baselines'),
      PROOFS_GOLDEN: '',
      PROOFS_GOLDEN_CAPTURE: '',
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const tiny = (standIn) => `
begin('HEAD');
const value = await golden('calls', () => ({ log: [['write', new Float32Array([1, 2])]], n: -0 }));
if (!(value.log[0][1] instanceof Float32Array) || !Object.is(value.n, -0)) throw new Error('value changed in storage');
const old = tape('copies', { twice: (x) => x * 2, fill: (out) => { out[0] = 7; return out; } }, ${standIn});
const out = [0];
if (old.twice(21) !== 42 || old.fill(out) !== out || out[0] !== 7) throw new Error('tape replay is wrong');
if (fact('a fact', () => 3) !== 3) throw new Error('fact');`;
const good = '{ twice: (x) => x + x, fill: (out) => { out[0] = 7; return out; } }';

test('capture stores, read mode replays from the store alone, and a changed function fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-golden-'));
  try {
    const captured = proof(dir, tiny(good), { PROOFS_GOLDEN_CAPTURE: '1' });
    assert.equal(captured.status, 0, captured.out);
    const meta = JSON.parse(readFileSync(join(dir, 'baselines/tiny.json'), 'utf8'));
    assert.deepEqual(Object.keys(meta.outputs).sort(), ['calls', 'copies']);
    assert.equal(meta.facts['a fact'], 3);

    assert.equal(proof(dir, tiny(good), { PROOFS_GOLDEN: '1' }).status, 0, 'read mode');
    assert.equal(proof(dir, tiny(good)).status, 0, 'check mode (HEAD exists): rebuilt and compared with the store');

    // Today's code computes something else: the tape's digest no longer matches.
    const changed = proof(dir, tiny('{ twice: (x) => x * 3, fill: (out) => { out[0] = 7; return out; } }'), {
      PROOFS_GOLDEN: '1',
    });
    assert.notEqual(changed.status, 0);
    assert.match(changed.out, /no longer computes what the old copies did|tape replay is wrong/);

    // A stand-in that does not match the old copy is caught at capture, before anything is stored.
    const wrong = proof(dir, tiny('{ twice: (x) => x * 3, fill: (out) => out }'), { PROOFS_GOLDEN_CAPTURE: '1' });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.out, /the stand-in for twice differs from the copy/);

    // A proof that stops calling a taped copy, or stops asking for a stored value, fails.
    const quiet = proof(
      dir,
      `begin('HEAD'); await golden('calls', () => 0); tape('copies', {}, {}); fact('a fact', () => 3);`,
      {
        PROOFS_GOLDEN: '1',
      },
    );
    assert.notEqual(quiet.status, 0);
    assert.match(quiet.out, /"copies": 0 calls/);
    const fewer = proof(dir, `begin('HEAD'); await golden('calls', () => 0); fact('a fact', () => 3);`, {
      PROOFS_GOLDEN: '1',
    });
    assert.notEqual(fewer.status, 0);
    assert.match(fewer.out, /never compared with stored copies/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store is checked against its SHA-256 and read mode never asks Git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-golden-'));
  try {
    assert.equal(proof(dir, tiny(good), { PROOFS_GOLDEN_CAPTURE: '1' }).status, 0);
    const metaFile = join(dir, 'baselines/tiny.json'),
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    meta.outputs.calls = '0'.repeat(64);
    writeFileSync(metaFile, JSON.stringify(meta));
    const corrupt = proof(dir, tiny(good), { PROOFS_GOLDEN: '1' });
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.out, /does not match its SHA-256/);

    const clean = mkdtempSync(join(tmpdir(), 'margo-golden-'));
    assert.equal(proof(clean, tiny(good), { PROOFS_GOLDEN_CAPTURE: '1' }).status, 0);
    const git = proof(
      clean,
      `import { revision } from ${JSON.stringify(url('history.js'))};\nbegin('HEAD');\nrevision('HEAD');`,
      { PROOFS_GOLDEN: '1' },
    );
    assert.notEqual(git.status, 0);
    assert.match(git.out, /tiny --current asked Git for HEAD/);
    rmSync(clean, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pinned run whose commit this clone lacks is HISTORICAL with the commit named, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-golden-'));
  try {
    const missing = proof(
      dir,
      `import { revision } from ${JSON.stringify(url('history.js'))};\nrevision('0000000000000000000000000000000000000001');\nthrow new Error('not reached');`,
    );
    assert.equal(missing.status, 0, missing.out);
    assert.match(
      missing.out,
      /^HISTORICAL: tiny is pinned to 0000000000000000000000000000000000000001, a commit only in the pre-rewrite history/m,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A proof that exits 0 as HISTORICAL passes, so only Git's own "no" may lead there. Any other failure of `git` once meant
// the same (a proofs-pinned-core test returned 0 while another worktree rewrote .git/config), and a failed
// `git show` silently read the working tree in place of the pinned file.
const history = (body, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-golden-'));
  try {
    return proof(
      dir,
      `import { holds, isAncestor, revision, show } from ${JSON.stringify(url('history.js'))};\n${body}`,
      env,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
// Two ways Git gives no answer, whatever the question: it cannot start, and it starts and cannot read the repository.
const noAnswer = {
  'git cannot start': `process.env.PATH = '';`,
  'git cannot read the repository': `process.env.GIT_DIR = 'no-such-directory';`,
};
const questions = {
  revision: `revision('HEAD~1')`,
  holds: `holds('HEAD')`,
  show: `show(id, 'package.json')`,
  'show of a missing file': `show(id, 'no/such/file')`,
  isAncestor: `isAncestor(id, id)`,
};

for (const [name, cause] of Object.entries(noAnswer))
  for (const [question, ask] of Object.entries(questions))
    test(`${question} throws when ${name}, and is never HISTORICAL`, () => {
      const run = history(`const id = revision('HEAD');\n${cause}\nconsole.log('answered', ${ask});`);
      assert.notEqual(run.status, 0, run.out);
      assert.match(run.out, /gave no answer/);
      assert.doesNotMatch(run.out, /HISTORICAL|answered/);
    });

test("Git's own answers stand: a file the commit lacks, a commit that is no ancestor, a commit the clone lacks", () => {
  // A repository of its own: the fresh-clone check runs this test in a clone of one parentless commit.
  const dir = mkdtempSync(join(tmpdir(), 'margo-golden-'));
  try {
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'file.txt'), 'text');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    git('commit', '-q', '--allow-empty', '-m', 'second');
    const copy = join(dir, 'examples/package-benchmarks/proofs/history.js');
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(join(proofs, 'history.js'), copy);
    const run = proof(
      dir,
      `import { holds, isAncestor, revision, show } from ${JSON.stringify(pathToFileURL(copy).href)};
      const id = revision('HEAD'), parent = revision('HEAD~1');
      console.log(JSON.stringify({
        file: show(id, 'file.txt'),
        missing: show(id, 'no/such/file') === undefined,
        ancestor: isAncestor(parent, id),
        notAncestor: isAncestor(id, parent),
        holds: holds(id),
        lacks: holds('0000000000000000000000000000000000000001'),
      }));`,
    );
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(JSON.parse(run.out.match(/^\{.*\}$/m)[0]), {
      file: 'text',
      missing: true,
      ancestor: true,
      notAncestor: false,
      holds: true,
      lacks: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ref is resolved once: a run keeps reading the commit it started with, without asking Git again', () => {
  const run = history(`
    const id = revision('HEAD');
    process.env.PATH = '';
    console.log(String(revision('HEAD') === id) + ' ' + String(revision(id) === id));
  `);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /^true true$/m);
});

// Bug 17 (2026-10-27): math-consolidation passed on this PC (Node 26.12, V8 14.6) and failed on Node 22.22.1 (V8 12.4)
// on Linux and on Windows. Its inputs used `10 ** x` and six of its tapes stored results of the sRGB curves (`**`), and
// ECMAScript leaves the rounding of `**` to the engine: V8 14.6 computes it with the C library's pow
// (`--use-std-math-pow`, on by default), V8 12.4 with its own, and 10 ** -5 is 0.00001 in one and
// 0.000009999999999999999 in the other. A stored digest may only cover exactly specified results.

test('exactMath: sin, cos and hypot from exactly rounded operations, close to Math and with its special cases', () => {
  for (const [name, x] of [
    ['sin', -0],
    ['sin', 0],
    ['cos', -0],
  ])
    assert.ok(Object.is(exactMath[name](x), Math[name](x)), `${name}(${x})`);
  for (const x of [NaN, Infinity, -Infinity])
    assert.ok(Number.isNaN(exactMath.sin(x)) && Number.isNaN(exactMath.cos(x)));
  assert.equal(exactMath.hypot(), 0);
  assert.ok(Object.is(exactMath.hypot(-0, 0), 0));
  assert.equal(exactMath.hypot(NaN, -Infinity), Infinity);
  assert.ok(Number.isNaN(exactMath.hypot(1, NaN)));
  assert.equal(exactMath.hypot(3e300, 4e300), 5e300, 'no overflow');
  assert.equal(exactMath.hypot(3, 4), 5);
  let seed = 3;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 20000; i++) {
    const x = (random() * 2 - 1) * 100,
      y = (random() * 2 - 1) * 1e-3;
    // Close to the host's value (reducing by the double nearest 2 pi costs about 16 periods * 2.4e-16 at |x| = 100).
    assert.ok(Math.abs(exactMath.sin(x) - Math.sin(x)) < 1e-14, `sin(${x})`);
    assert.ok(Math.abs(exactMath.cos(x) - Math.cos(x)) < 1e-14, `cos(${x})`);
    assert.ok(Math.abs(exactMath.hypot(x, y, x) - Math.hypot(x, y, x)) <= 4 * Number.EPSILON * Math.hypot(x, y, x));
  }
});

test('a taped call that uses an approximated Math function fails the run; sin, cos and hypot get exact stand-ins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-golden-'));
  try {
    const exact = proof(
      dir,
      `import { exactMath } from ${JSON.stringify(url('golden.js'))};
begin('HEAD');
deterministicMath();
if (Math.sin !== exactMath.sin || Math.cos !== exactMath.cos || Math.hypot !== exactMath.hypot) throw new Error('not replaced');
const old = tape('copies', { f: (x) => Math.sin(x) + Math.hypot(x, 1) }, { f: (x) => Math.sin(x) + Math.hypot(x, 1) });
old.f(0.5);`,
      { PROOFS_GOLDEN_CAPTURE: '1' },
    );
    assert.equal(exact.status, 0, exact.out);
    const tan = proof(
      dir,
      `begin('HEAD');
deterministicMath();
Math.tan(1); // outside a taped call: allowed
const old = tape('copies', { f: (x) => Math.tan(x) }, { f: (x) => Math.tan(x) });
old.f(0.5);`,
      { PROOFS_GOLDEN_CAPTURE: '1' },
    );
    assert.notEqual(tan.status, 0);
    assert.match(tan.out, /taped calls used Math\.tan, which hosts round differently/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tape's canonical form is what its digest records, so a result through `**` stores the same on every host", () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-golden-'));
  try {
    const stored = (fn, canonical) => {
      const run = proof(
        dir,
        `begin('HEAD');\nconst old = tape('copies', { f: ${fn} }, { f: ${fn} }, ${canonical});\nold.f(0.3); old.f(0.7);`,
        { PROOFS_GOLDEN_CAPTURE: '1' },
      );
      assert.equal(run.status, 0, run.out);
      return JSON.parse(readFileSync(join(dir, 'baselines/tiny.json'), 'utf8')).outputs.copies;
    };
    const form = "{ f: (args, value) => ({ input: args[0], value: value > 0 ? 'positive' : value }) }";
    // Two different results with one canonical form store one digest; without the form they differ.
    assert.equal(stored('(x) => x ** 2.4', form), stored('(x) => x * x', form));
    assert.notEqual(stored('(x) => x ** 2.4', '{}'), stored('(x) => x * x', '{}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The V8 flag that picks the other pow implementation, or undefined on a Node without the choice (Node 22). */
function otherPow() {
  const options = spawnSync(process.execPath, ['--v8-options'], { encoding: 'utf8', timeout: 30_000 }).stdout ?? '';
  const flag = /--use-std-math-pow\b[^\n]*\n\s*type: bool\s+default: (--(?:no-)?use-std-math-pow)/.exec(options)?.[1];
  return flag && (flag === '--use-std-math-pow' ? '--no-use-std-math-pow' : '--use-std-math-pow');
}

test('math-consolidation replays from its stored digests under another pow (after build:packages)', () => {
  // Node 26 has both pows: this runs the one `npm run proofs -- --current` does not. Node 22 has only V8's own, which
  // is not the pow the digests were captured with (Node 26 on Windows: `capturedOn` in baselines/math-consolidation.json).
  // CI runs this file on Node 22.12.0 and 26 (.github/workflows/ci.yml, node-compat).
  const flag = otherPow(),
    run = spawnSync(
      process.execPath,
      [...(flag ? [flag] : []), join(proofs, 'math-consolidation.proof.js'), '--current'],
      {
        cwd: resolve(proofs, '../../..'),
        encoding: 'utf8',
        timeout: 5 * 60_000,
        killSignal: 'SIGKILL',
        env: { ...process.env, PROOFS_GOLDEN: '1', PROOFS_GOLDEN_CAPTURE: '', PROOFS_NO_WRITE: '1' },
      },
    );
  assert.equal(run.status, 0, `${flag ?? 'default pow'}:\n${run.stderr.slice(-3000)}`);
  assert.match(run.stdout, /"outputsIdentical": true/);
});
