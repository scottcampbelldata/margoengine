// Golden outputs for the --current proofs (examples/package-benchmarks/proofs/golden.js). A fresh clone of main once
// failed `npm run verify`: 14 of the 20 --current proofs rebuilt their baselines with `git rev-parse` / `git show` on
// commits that existed only in one PC's pre-rewrite history. Now a --current run reads stored outputs and never asks
// Git; these tests pin that down: lossless storage, the SHA-256 check, tapes that catch a changed function, read mode
// refusing Git, and pinned runs reporting HISTORICAL for a commit the clone lacks. They also cover canonicalNaN, the
// fix for geometry.proof.js failing at random on NaN bit patterns.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { canonicalNaN, decode, digest, encode } from '../examples/package-benchmarks/proofs/golden.js';

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
  writeFileSync(file, `import { begin, golden, tape, fact } from ${JSON.stringify(url('golden.js'))};\n${body}\n`);
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
