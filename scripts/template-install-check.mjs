import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTarball, startRegistry } from './publish-rehearsal.mjs';
import { run, installedEnginePackages, requiredClosure } from './kit-install-check.mjs';
const root = resolve(import.meta.dirname, '..'),
  results = join(root, 'test-results/template-installs');
mkdirSync(results, { recursive: true });
const work = mkdtempSync(join(results, 'run-')),
  tarballs = join(work, 'tarballs');
mkdirSync(tarballs);
await run('npm', ['pack', '--workspace', 'packages', '--ignore-scripts', '--pack-destination', tarballs]);
await run('npm', ['pack', './tools/create-margo', '--ignore-scripts', '--pack-destination', tarballs]);
const packages = new Map();
for (const file of readdirSync(tarballs).filter((f) => f.endsWith('.tgz'))) {
  const bytes = readFileSync(join(tarballs, file)),
    files = readTarball(bytes),
    manifest = JSON.parse(files.get('package.json').toString());
  packages.set(manifest.name, { bytes, files, manifest });
}
const registry = await startRegistry(packages),
  version = packages.get('create-margo').manifest.version;
const args = [`--registry=${registry.url}`, '--replace-registry-host=never', '--no-audit', '--no-fund'];
const env = {
  ...process.env,
  npm_config_userconfig: join(work, 'no-npmrc'),
  npm_config_cache: join(work, 'cache'),
  NEXT_TELEMETRY_DISABLED: '1',
};
const report = { version, cases: [] };
try {
  for (const [name, kit] of Object.entries({
    web: 'web',
    game: 'game',
    viz: 'viz',
    react: 'react-kit',
    next: 'react-kit',
  })) {
    const app = join(work, name);
    await run('npm', ['create', `margo@${version}`, name, ...args, '--yes', '--', '--template', name], {
      cwd: work,
      env,
      seconds: 120,
    });
    const manifest = JSON.parse(readFileSync(join(app, 'package.json')));
    assert.equal(manifest.dependencies[`@margoengine/${kit}`], '^' + version);
    assert.equal('margoengine' in manifest.dependencies, false);
    await run('npm', ['install', '--ignore-scripts', ...args], { cwd: app, env, seconds: 400 });
    const installed = installedEnginePackages(app);
    assert.deepEqual(installed.map((p) => p.name).sort(), requiredClosure([`@margoengine/${kit}`], packages), name);
    for (const p of installed) {
      assert.equal(p.value.version, version, p.name);
      assert.ok(p.value.resolved.startsWith(registry.url), p.name);
    }
    const built = await run('npm', ['run', 'build'], { cwd: app, env, seconds: 400 });
    writeFileSync(join(results, `${name}-build.log`), built);
    report.cases.push({ name, kit, app, packages: installed.length });
    console.log(`${name}: packed CLI, ${installed.length} engine packages, template build passed`);
  }
  assert.deepEqual(registry.refused, []);
  writeFileSync(join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
  registry.close();
}
