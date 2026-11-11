import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('Draco resource child uses a frozen artifact independently of dist and its working directory', {
  timeout: 30_000,
}, () => {
  mkdirSync('test-results', { recursive: true });
  const directory = mkdtempSync(resolve('test-results/draco-resource-')),
    wasm = resolve(directory, 'frozen.wasm');
  copyFileSync('packages/decoders/dist/draco-native.wasm', wasm);
  const child = spawnSync(
    process.execPath,
    [
      resolve('scripts/acceptance/draco-resource-child.mjs'),
      'native-full',
      resolve('packages/decoders/tests/fixtures/NormalizedTriangle.bin'),
      wasm,
    ],
    { cwd: directory, timeout: 20_000, windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.counts.compileCalls, 1);
  assert.equal(result.counts.instantiateCalls, 1);
  assert.equal(result.counts.wrapperBytes, 0);
  assert.ok(result.counts.inputCopyBytes > 0);
  assert.ok(result.counts.resultCopyBytes > 0);
  assert.ok(Number.isSafeInteger(result.final.peakRSSBytes) && result.final.peakRSSBytes > 0);
  assert.ok(result.final.linearBytes > 0 && result.final.linearBytes % 65536 === 0);
  assert.equal(result.output.points, 3);
  assert.ok(!/Ms|seconds|duration|speed|elapsed/.test(JSON.stringify(result)));
});

test('Draco resource resume cannot silently change the opaque variant', { timeout: 30_000 }, () => {
  mkdirSync('test-results', { recursive: true });
  const directory = mkdtempSync(resolve('test-results/draco-resource-resume-')),
    wasm = resolve('packages/decoders/dist/draco-native.wasm'),
    manifest = resolve(directory, 'manifest.json'),
    prefix = resolve(directory, 'run'),
    hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  writeFileSync(manifest, JSON.stringify([{ sha256: 'recorded-input' }]));
  writeFileSync(prefix + '.jsonl', JSON.stringify({ sha256: 'recorded-input' }) + '\n');
  writeFileSync(
    prefix + '-summary.json',
    JSON.stringify({
      variant: 'draco-full',
      completed: 1,
      identities: { manifestSHA256: hash(readFileSync(manifest)), wasmSHA256: hash(readFileSync(wasm)) },
    }),
  );
  // This checkpoint predates --outputs, when point clouds were converted to float on both sides.
  const run = (variant, outputs = '--outputs=float') =>
    spawnSync(
      process.execPath,
      ['scripts/acceptance/draco-resources.mjs', variant, manifest, prefix, wasm, '--resume', outputs],
      { timeout: 20_000, windowsHide: true, encoding: 'utf8' },
    );
  assert.equal(run('draco-full').status, 0, 'unchanged complete checkpoint needs no new measurement');
  const api = run('draco-full', '--outputs=api');
  assert.notEqual(api.status, 0, 'a float-output checkpoint cannot resume as an api-output campaign');
  assert.match(api.stderr, /resume inputs must be unchanged/);
  const changed = run('draco');
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /resume variant must be unchanged/);
  const missed = JSON.parse(readFileSync(prefix + '-summary.json'));
  missed.rssLosses = 1;
  writeFileSync(prefix + '-summary.json', JSON.stringify(missed));
  const loss = run('draco-full');
  assert.notEqual(loss.status, 0, 'a retained RSS loss must fail acceptance without taking another sample');
  assert.equal(JSON.parse(loss.stdout).rssLosses, 1);
});

// The prebuilt Draco build copied outside the repository, as the campaign requires of its opaque oracle.
function oracle() {
  const root = mkdtempSync(join(tmpdir(), 'margo-draco-oracle-'));
  for (const variant of ['draco', 'draco-full']) {
    mkdirSync(join(root, variant));
    for (const file of ['draco_wasm_wrapper.js', 'draco_decoder.wasm'])
      copyFileSync(resolve('packages/decoders/vendor', variant, file), join(root, variant, file));
  }
  return root;
}
const pointCloud = resolve('packages/decoders/tests/fixtures/draco-points/pc_kd_color.drc');

// KB4824a residue (bug sweep L5b, 2026-11-11): the child converted every native point attribute to float in JavaScript,
// which DracoPointsDecoder never does on either decoder, and charged that to the native side's RSS.
test('Draco resource child measures what the point API returns; float output is a separate like-for-like row', {
  timeout: 60_000,
}, () => {
  const env = { ...process.env, MARGO_DRACO_ORACLE_ROOT: oracle() },
    wasm = resolve('packages/decoders/dist/draco-native.wasm');
  const child = (side, outputs) => {
    const args = [resolve('scripts/acceptance/draco-resource-child.mjs'), side, pointCloud, wasm];
    if (outputs) args.push(outputs);
    const run = spawnSync(process.execPath, args, { env, timeout: 20_000, windowsHide: true, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  for (const [outputs, floats] of [
    [undefined, false],
    ['api', false],
    ['float', true],
  ]) {
    const old = child('draco-full', outputs),
      native = child('native-full', outputs);
    assert.equal(native.outputs, outputs ?? 'api');
    assert.ok(old.output.attributes.length > 0);
    old.output.attributes.forEach((a, i) => {
      const b = native.output.attributes[i];
      assert.equal(b.native, a.native, 'stored-type output is identical');
      assert.equal(a.float !== null, floats, `prebuilt float output with ${outputs}`);
      assert.equal(b.float !== null, floats, `native float output with ${outputs}`);
      if (floats) assert.equal(b.float, a.float);
    });
  }
});

test('Draco resource paired check takes turns, keeps every round and decides on per-side minima', {
  timeout: 120_000,
}, () => {
  mkdirSync('test-results', { recursive: true });
  const directory = mkdtempSync(resolve('test-results/draco-resource-paired-')),
    manifest = resolve(directory, 'manifest.json'),
    prefix = resolve(directory, 'run'),
    env = { ...process.env, MARGO_DRACO_ORACLE_ROOT: oracle() },
    input = resolve('packages/decoders/tests/fixtures/draco-points/cube_pc.drc');
  writeFileSync(
    manifest,
    JSON.stringify([
      {
        path: input,
        sha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
        names: ['cube_pc'],
      },
    ]),
  );
  const run = (...extra) =>
    spawnSync(
      process.execPath,
      [
        'scripts/acceptance/draco-resources.mjs',
        'draco-full',
        manifest,
        prefix,
        resolve('packages/decoders/dist/draco-native.wasm'),
        ...extra,
      ],
      { env, timeout: 100_000, windowsHide: true, encoding: 'utf8' },
    );
  for (const bad of ['--paired=4', '--paired=17', '--paired=x', '--outputs=raw'])
    assert.notEqual(run(bad).status, 0, bad);
  assert.match(run('--paired=5', '--resume').stderr, /cannot resume/);
  const paired = run('--paired=5');
  const record = JSON.parse(readFileSync(prefix + '-summary.json', 'utf8')),
    rows = readFileSync(prefix + '.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
  assert.equal(record.rounds, 5);
  assert.equal(record.completed, 1);
  assert.equal(record.startup, undefined, 'a paired check takes no one-shot startup stage');
  assert.deepEqual(
    rows.map((r) => r.first),
    ['old', 'native', 'old', 'native', 'old'],
  );
  const [result] = record.results;
  assert.equal(result.oldPeakRSSMin, Math.min(...rows.map((r) => r.old.final.peakRSSBytes)));
  assert.equal(result.nativePeakRSSMin, Math.min(...rows.map((r) => r.native.final.peakRSSBytes)));
  assert.equal(record.rssLosses, result.nativePeakRSSMin > result.oldPeakRSSMin ? 1 : 0);
  assert.equal(paired.status, record.rssLosses || record.linearLosses ? 1 : 0, paired.stderr);
  assert.notEqual(run('--paired=5').status, 0, 'a paired check is never repeated into an existing record');
});
