import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTarball, startRegistry } from './publish-rehearsal.mjs';
import { run, installedEnginePackages, requiredClosure } from './kit-install-check.mjs';
import { BAD_LINE, humanEnv, probe } from './support/dev-server-probe.mjs';

// Besides installing and building, every server script of each template is started the way the template README says
// (`npm run dev`, `npm run preview`, `npm start`): the first page and what it loads answer 200 and the output holds no
// warning or error line. `--cleanup` removes the scaffolded apps afterwards in a detached process; without it they stay
// for template-browser-check.mjs. No GPU is used here.
const cleanup = process.argv.includes('--cleanup');
const serverProblems = [];
let nextPort = 5600;

/** The server scripts of a template: dev, preview and start (the `build` script runs separately, above them). */
function serverScripts(manifest) {
  return Object.keys(manifest.scripts).filter((script) => /^(dev|preview|start)$/.test(script));
}

/** The command a template script runs, started directly from the app's own install on a chosen port. */
function serverCommand(app, script, port) {
  const next = join(app, 'node_modules/next/dist/bin/next'),
    vite = join(app, 'node_modules/vite/bin/vite.js'),
    command = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).scripts[script],
    page = `http://127.0.0.1:${port}/`;
  if (/^next (dev|start)\b/.test(command))
    return { command: process.execPath, args: [next, command.split(' ')[1], '--hostname', '127.0.0.1', '--port', String(port)], page };
  if (/^vite( preview)?$/.test(command))
    return { command: process.execPath, args: [vite, ...command.split(' ').slice(1), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], page };
  throw new Error(`template script ${script} runs \`${command}\`, which this check does not know how to start`);
}
/**
 * What a Vite template's production build emitted: no JavaScript file over Vite's 500 kB warning size, or over the
 * limit in WARN_LIMITS for a template whose own start-up code is larger (a Wasm inlined as base64 once needed 4,500 kB),
 * and for the game, Rapier's Wasm as an asset of its own. Templates built by another tool (Next) have no `dist`.
 */
// The game's start-up engine code measured 675,315 B minified on 2026-11-10; its vite.config.ts says 700 kB.
const WARN_LIMITS = { game: 700_000 };
function viteOutputProblems(name, app) {
  const dist = join(app, 'dist');
  if (!existsSync(dist)) return [];
  const problems = [],
    files = readdirSync(dist, { recursive: true }).map(String);
  for (const file of files.filter((f) => /\.m?js$/.test(f))) {
    const size = statSync(join(dist, file)).size;
    const limit = WARN_LIMITS[name] ?? 500_000;
    if (size > limit) problems.push(`${name}: build emitted ${file} of ${size} bytes, over its ${limit / 1000} kB warning size`);
  }
  if (name === 'game' && !files.some((f) => f.endsWith('.wasm'))) problems.push('game: build emitted no .wasm asset (Rapier)');
  return problems;
}
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
    for (const line of built.split(/\r?\n/)) if (BAD_LINE.test(line)) serverProblems.push(`${name}: build output: ${line.trim().slice(0, 240)}`);
    serverProblems.push(...viteOutputProblems(name, app));
    for (const script of serverScripts(manifest)) {
      const { problems } = await probe({ ...serverCommand(app, script, nextPort++), cwd: app, env: { ...humanEnv(env), NEXT_TELEMETRY_DISABLED: '1' }, limitMs: 150_000 });
      for (const problem of problems) serverProblems.push(`${name} npm run ${script}: ${problem}`);
      console.log(`${name}: npm run ${script} ${problems.length ? 'FAILED' : 'started clean'}`);
    }
    report.cases.push({ name, kit, app, packages: installed.length });
    console.log(`${name}: packed CLI, ${installed.length} engine packages, template build passed`);
  }
  assert.deepEqual(registry.refused, []);
  assert.deepEqual(serverProblems, [], `template servers did not start clean:\n${serverProblems.join('\n')}`);
  writeFileSync(join(results, 'report.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
  registry.close();
  if (cleanup)
    spawn(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(work)}, { recursive: true, force: true, maxRetries: 5 })`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
}
