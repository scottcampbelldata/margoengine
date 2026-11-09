import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSkips, checkFixtureSkips } from '../scripts/check-fixture-skips.mjs';
import { requiredFixture } from '../scripts/support/required-fixture.mjs';
import { fetchFixture } from '../scripts/support/fetch-fixture.mjs';

for (const [name, source] of Object.entries({
  'skip call': "if (!existsSync(fixture)) return t.skip('fixture missing')",
  'skip option': "test('real', {skip: !existsSync(fixtures + name)}, () => {})",
  'aliased skip option': "const available = existsSync(sample); test('real', {skip: !available}, () => {})",
  'unnamed input skip': "const ready = existsSync(p); test('real', {skip: !ready}, () => {})",
  'silent return': "if (!existsSync(fixtures + 'BrightRings.exr')) return;",
  'silent continue': 'for (const name of files) { if (!existsSync(fixtures + name)) continue; }',
  'optional read': 'const fixture = (name) => existsSync(fixtures + name) ? readFileSync(name) : null;',
  'missing build': "try { await import('./dist/a.js'); } catch { t.skip('package is not built'); }",
  'missing tool': "const options = validator ? {} : { skip: 'gltf-validator not installed' };",
  'indirect reason': "const message = 'required fixture absent'; t.skip(message);",
})) {
  test(`required-fixture gate rejects ${name}`, () => assert.ok(fixtureSkips(source).length, name));
}

test('the fixture gate ignores descriptions, normal returns, hardware skips and asserted fixture reads', () => {
  assert.deepEqual(
    fixtureSkips(`
    // if (!existsSync(fixtures + name)) return;
    test('t.skip(\'fixture missing\')', () => { assert.ok(existsSync(fixture), 'fetch it'); });
    test('Windows handles', { skip: process.platform !== 'win32' }, () => {});
    function scalar(x) { if (!x) return 0; return x; }
  `),
    [],
  );
});

test('missing and LFS-only fixtures fail with the exact file and recovery command; bytes remain unchanged', () => {
  mkdirSync(join(import.meta.dirname, '../test-results'), { recursive: true });
  const folder = mkdtempSync(join(import.meta.dirname, '../test-results/required-fixture-'));
  try {
    const file = join(folder, 'model.bin'),
      command = 'git lfs pull';
    const message = (error) => error.message.includes(file) && error.message.includes(command);
    assert.throws(() => requiredFixture(file, command), message);
    writeFileSync(file, 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 8\n');
    assert.throws(() => requiredFixture(file, command), message);
    const data = Buffer.from([0, 1, 2, 255]);
    writeFileSync(file, data);
    assert.deepEqual(requiredFixture(file, command), data);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('required fixture checks never silently skip or return on missing evidence', () => {
  assert.deepEqual(checkFixtureSkips(), []);
});

test('a missing external validator fails before exporter tests can pass without validation', () => {
  const root = join(import.meta.dirname, '..');
  const path = join(root, 'test-results/no-validator-toolchain');
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('./packages/exporters/tests/helpers.js')"],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, MARGOENGINE_EXPORTERS_TOOLS: path },
    },
  );
  assert.equal(run.error, undefined);
  assert.notEqual(run.status, 0);
  assert.ok(run.stderr.includes(path), run.stderr);
  assert.match(run.stderr, /Missing required validator.*npm ci/);
});

test('fixture download refuses HTTP errors, oversized bodies and changed bytes instead of reporting a skip', async () => {
  const url = 'https://fixtures.test/model.bin',
    file = join(import.meta.dirname, '../test-results/download-refusal.bin');
  const request = (response) => ({ fetch: async () => response });
  await assert.rejects(
    fetchFixture(url, file, '0'.repeat(64), request(new Response('', { status: 404 }))),
    /Required fixture.*HTTP 404/,
  );
  await assert.rejects(
    fetchFixture(url, file, '0'.repeat(64), { ...request(new Response(new Uint8Array(8))), maxBytes: 4 }),
    /byte budget exceeded/,
  );
  await assert.rejects(fetchFixture(url, file, '0'.repeat(64), request(new Response('changed'))), /SHA-256 mismatch/);
});
