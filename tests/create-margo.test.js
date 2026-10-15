// create-margo: scaffolds into a temp dir, then type-checks and builds the app against this checkout's packages
// (node_modules links instead of an install, so no network). Needs `npm run build:packages` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

const root = resolve(import.meta.dirname, '..'), cli = join(root, 'tools/create-margo/index.js');
const run = (args, cwd) => execFileSync(process.execPath, [cli, ...args], {cwd, encoding: 'utf8', env: {...process.env, npm_config_user_agent: 'pnpm/10.0.0 node/v24'}});

test('create-margo scaffolds the template and refuses a non-empty directory', t => {
  const temp = mkdtempSync(join(tmpdir(), 'create-margo-')); t.after(() => rmSync(temp, {recursive: true, force: true}));
  const output = run(['My App'], temp), app = join(temp, 'My App');
  assert.match(output, /cd "My App"\n {2}pnpm install\n {2}pnpm dev/);
  assert.deepEqual(readdirSync(app).sort(), ['.gitignore', 'README.md', 'index.html', 'package.json', 'public', 'src', 'tsconfig.json']);
  const headers = readFileSync(join(app, 'public/_headers'), 'utf8');
  for (const directive of ["script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", 'immutable']) assert.ok(headers.includes(directive), directive);
  assert.ok(readdirSync(join(app, 'public')).includes('404.html'), 'a 404 page keeps hosts from serving index.html for missing assets');
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'my-app');
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    const local = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(range, `^${local.version}`, `${name} should track the workspace version`);
  }
  const main = readFileSync(join(app, 'src/main.ts'), 'utf8');
  for (const call of ['applyQualityTier()', 'paceEngine(engine)', 'watchQuality()', 'OrbitControls.attach(engine)', 'Stats.attach(engine)', 'EnvironmentLighting.attach(']) assert.ok(main.includes(call), call);
  assert.ok(main.indexOf('applyQualityTier()') < main.indexOf('Engine.create('), 'quality tier before the engine');

  writeFileSync(join(temp, 'taken.txt'), '');
  assert.throws(() => execFileSync(process.execPath, [cli, '.'], {cwd: temp, stdio: 'pipe'}), /not empty/);
  assert.throws(() => execFileSync(process.execPath, [cli, '--template', 'x'], {cwd: temp, stdio: 'pipe'}), /unknown option/);
  assert.ok(!existsSync(join(temp, '--template')));
});

test('the scaffolded app type-checks and builds against the local packages', {timeout: 180_000}, t => {
  const temp = mkdtempSync(join(tmpdir(), 'create-margo-build-')); t.after(() => rmSync(temp, {recursive: true, force: true}));
  run(['app'], temp);
  const app = join(temp, 'app'), modules = join(app, 'node_modules'), manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  mkdirSync(join(modules, '@margoengine'), {recursive: true});
  for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) symlinkSync(join(root, 'node_modules', name), join(modules, name), 'junction');
  execFileSync(process.execPath, [join(modules, 'typescript/bin/tsc'), '-p', app], {cwd: app, stdio: 'pipe'});
  execFileSync(process.execPath, [join(modules, 'vite/bin/vite.js'), 'build', '--logLevel', 'error'], {cwd: app, stdio: 'pipe'});
  assert.ok(existsSync(join(app, 'dist/_headers')), 'Vite copies public/_headers into dist');
  const assets = join(app, 'dist/assets'), scripts = readdirSync(assets).filter(file => file.endsWith('.js'));
  const gzip = scripts.reduce((sum, file) => sum + gzipSync(readFileSync(join(assets, file)), {level: 9}).length, 0);
  console.log(`create-margo app: ${scripts.length} JS file(s), ${gzip} bytes gzip`);
  assert.ok(gzip > 10_000 && gzip < 80_000, `unexpected bundle size ${gzip}`);
});
