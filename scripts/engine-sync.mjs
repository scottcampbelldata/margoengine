// The one way a Margo app gets the engine: the sibling checkout `../margoengine`, always on the latest `origin/main`.
// Apps run it through their `engine:sync` script (predev, pretest, prebuild, postinstall).
//
//   node <engine>/scripts/engine-sync.mjs [--app <dir>]   fast-forward, build if needed, write <app>/.engine/manifest.json
//   node <engine>/scripts/engine-sync.mjs --check [--app <dir>]   check the app only (its check:engine-apis runs this)
//
// Sync fails loudly when the engine checkout has tracked changes, is not on main, or cannot fast-forward. Offline, it
// warns and continues only when local main equals the last fetched origin/main. It builds only when a package the app
// uses has no build of the current commit. `--check` fails when an @margoengine package resolves anywhere but the
// engine's packages folder, a used package's build is older than engine HEAD, or the app commits engine files.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const engine = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const app = resolve(option('--app') ?? process.cwd());
const checkOnly = args.includes('--check');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  console.error(`engine:sync: ${message}`);
  process.exit(1);
}
const git = (...parts) =>
  execFileSync('git', ['-C', engine, ...parts], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The engine packages the app depends on, plus every @margoengine package they depend on. */
function packagesOf(appRoot) {
  const manifest = read(join(appRoot, 'package.json'));
  const direct = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  })
    .filter((name) => name.startsWith('@margoengine/'))
    .map((name) => name.slice('@margoengine/'.length));
  const all = new Set();
  const queue = [...direct];
  while (queue.length) {
    const name = queue.pop();
    if (all.has(name)) continue;
    const file = join(engine, 'packages', name, 'package.json');
    if (!existsSync(file))
      fail(`${appRoot} depends on @margoengine/${name}, which engine main does not have; remove it`);
    all.add(name);
    const pkg = read(file);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }))
      if (dep.startsWith('@margoengine/')) queue.push(dep.slice('@margoengine/'.length));
  }
  return { direct: direct.sort(), all: [...all].sort() };
}

// A build stamp per package: dist/.engine-commit holds the commit it was built from (dist is ignored by git).
const stamp = (name) => join(engine, 'packages', name, 'dist', '.engine-commit');
const builtAt = (name) => (existsSync(stamp(name)) ? readFileSync(stamp(name), 'utf8').trim() : null);

/** Problems with how the app uses the engine; empty when it is sound. */
export function checkApp(appRoot = app) {
  const problems = [];
  const head = git('rev-parse', 'HEAD');
  const { direct, all } = packagesOf(appRoot);
  const manifest = read(join(appRoot, 'package.json'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
    for (const [name, spec] of Object.entries(manifest[field] ?? {}))
      if (name.startsWith('@margoengine/') && spec !== `file:../margoengine/packages/${name.slice(13)}`)
        problems.push(`package.json ${field}: ${name} must be file:../margoengine/packages/${name.slice(13)}`);
  for (const name of direct) {
    const link = join(appRoot, 'node_modules', '@margoengine', name);
    if (!existsSync(link)) {
      problems.push(`node_modules/@margoengine/${name} is missing; run npm install`);
      continue;
    }
    const real = realpathSync(link);
    if (real !== realpathSync(join(engine, 'packages', name)))
      problems.push(`node_modules/@margoengine/${name} resolves to ${real}, not the engine checkout; run npm install`);
  }
  for (const name of all)
    if (builtAt(name) !== head)
      problems.push(`@margoengine/${name} is not built from engine HEAD; run npm run engine:sync`);
  // Nothing engine-related is committed in an app.
  const tracked = execFileSync('git', ['-C', appRoot, 'ls-files'], { encoding: 'utf8' }).split('\n');
  for (const path of tracked)
    if (
      /^(?:vendor\/margo[^/]*|\.engine)\//i.test(path) ||
      /^vendor\/.*\.tgz$/i.test(path) ||
      /(?:^|\/)margoengine-[^/]*\.tgz$/i.test(path)
    )
      problems.push(`${path}: an engine copy is committed; delete it (apps use ../margoengine)`);
  if (!tracked.includes('.gitignore') || !/^\/?\.engine\/?$/m.test(readFileSync(join(appRoot, '.gitignore'), 'utf8')))
    problems.push('.gitignore must list .engine/');
  return problems;
}

if (checkOnly) {
  const problems = checkApp();
  if (problems.length) fail(`\n${problems.join('\n')}`);
  console.log(
    `engine:sync --check: ${relative(process.cwd(), app) || '.'} uses engine ${git('rev-parse', '--short', 'HEAD')} from ../margoengine`,
  );
  process.exit(0);
}

// One sync at a time per engine checkout (several apps may run their hooks together).
const lock = join(engine, 'node_modules', '.cache', 'engine-sync.lock');
mkdirSync(dirname(lock), { recursive: true });
// The lock holds this process's ID; a lock whose process has ended is taken over, and waiting stops after 5 minutes.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const started = Date.now();
let told = false;
for (;;) {
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(process.pid));
    break;
  } catch {
    let holder = 0;
    try {
      holder = Number(readFileSync(join(lock, 'pid'), 'utf8'));
    } catch {}
    if (!holder || !alive(holder)) {
      if (Date.now() - statSync(lock).mtimeMs > 5_000 || holder) rmSync(lock, { recursive: true, force: true });
    } else if (Date.now() - started > 5 * 60_000)
      fail(`another engine:sync (process ${holder}) has held ${lock} for over 5 minutes; wait for it or end it`);
    else if (!told) {
      told = true;
      console.log(`engine:sync: waiting for another engine:sync (process ${holder}) to finish`);
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
  }
}
// fail() exits without unwinding, so release the lock on every exit.
process.on('exit', () => rmSync(lock, { recursive: true, force: true }));
try {
  if (git('branch', '--show-current') !== 'main') fail(`${engine} is not on main; check out main there`);
  if (git('status', '--porcelain', '--untracked-files=no'))
    fail(`${engine} has uncommitted changes; commit, land or stash them there first`);
  let offline = false;
  try {
    execFileSync('git', ['-C', engine, 'fetch', '--quiet', 'origin', 'main'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
    });
  } catch {
    offline = true;
  }
  const local = git('rev-parse', 'HEAD'),
    remote = git('rev-parse', 'origin/main');
  if (offline) {
    if (local !== remote)
      fail(
        `cannot fetch origin and local main (${local.slice(0, 8)}) is not the last fetched origin/main (${remote.slice(0, 8)})`,
      );
    console.warn(`engine:sync: offline; using local main ${local.slice(0, 8)}, the last fetched origin/main`);
  } else if (local !== remote) {
    try {
      git('merge', '--ff-only', '--quiet', 'origin/main');
    } catch {
      fail(`${engine} main cannot fast-forward to origin/main; it has commits that are not on origin/main`);
    }
  }
  const head = git('rev-parse', 'HEAD');
  if (!existsSync(join(engine, 'node_modules', 'typescript'))) {
    console.log('engine:sync: installing engine dependencies (npm ci)');
    const install = spawnSync(npm, ['ci'], { cwd: engine, stdio: 'inherit', shell: process.platform === 'win32' });
    if (install.status !== 0) fail('npm ci in the engine failed');
  }
  const { all } = packagesOf(app);
  const stale = all.filter((name) => builtAt(name) !== head);
  if (stale.length) {
    console.log(
      `engine:sync: building engine packages at ${head.slice(0, 8)} (${stale.length} of ${all.length} out of date)`,
    );
    const build = spawnSync(npm, ['run', 'build:packages'], {
      cwd: engine,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) fail('npm run build:packages in the engine failed');
    // The build regenerates tracked files (docs/catalog.json); on a sound main they come out unchanged.
    const changed = git('status', '--porcelain', '--untracked-files=no');
    if (changed)
      fail(
        `building engine main ${head.slice(0, 8)} changed tracked files, so main is missing a regenerated file:\n${changed}\nland that file on engine main, then run git -C "${engine}" checkout -- . and sync again`,
      );
    // build:packages builds every package, so every app finds its packages current.
    for (const name of readdirSync(join(engine, 'packages')))
      if (existsSync(join(engine, 'packages', name, 'dist'))) writeFileSync(stamp(name), `${head}\n`);
  }
  const out = join(app, '.engine');
  mkdirSync(out, { recursive: true });
  const record = { engine: 'margoengine', commit: head, packages: all };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`engine:sync: ${relative(dirname(engine), app).split(sep).join('/')} on engine main ${head.slice(0, 8)}`);
} finally {
  rmSync(lock, { recursive: true, force: true });
}
