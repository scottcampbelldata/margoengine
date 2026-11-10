import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
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
  const run = (variant) =>
    spawnSync(
      process.execPath,
      ['scripts/acceptance/draco-resources.mjs', variant, manifest, prefix, wasm, '--resume'],
      { timeout: 20_000, windowsHide: true, encoding: 'utf8' },
    );
  assert.equal(run('draco-full').status, 0, 'unchanged complete checkpoint needs no new measurement');
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
