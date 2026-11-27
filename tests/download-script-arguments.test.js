// A download script once treated every argument it did not know, `--help` included, as "download everything": asking
// scripts/fetch-readme-assets.mjs for help fetched its samples, and sixteen more scripts did the same, some of them
// replacing committed fixtures. Each one is run here with the network, other programs and file writes refused.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const guard = pathToFileURL(resolve(root, 'tests/support/refuse-downloads.mjs')).href;

const NODE_SCRIPTS = [
  'packages/environment/scripts/fetch-fixtures.mjs',
  'packages/loaders/scripts/fetch-fixtures.js',
  'packages/loaders/scripts/fetch-real-files-runtimes.mjs',
  'packages/loaders/scripts/test-real-files.mjs',
  'packages/sciviz/scripts/fetch-graph-gpu-data.mjs',
  'packages/sciviz/scripts/prepare-stats.mjs',
  'scripts/check-live-island-build.js',
  'scripts/fetch-readme-assets.mjs',
  'scripts/prepare-sciviz-cloud.mjs',
  'scripts/reference-rendering/fetch-assets.mjs',
  'scripts/reference-rendering/fetch-skip-assets.mjs',
];
const PYTHON_SCRIPTS = [
  'packages/sciviz/scripts/fetch-amr-sample.py',
  'packages/sciviz/scripts/fetch-idr-crop.py',
  'packages/sciviz/scripts/generate-table-fixtures.py',
  'packages/sciviz/scripts/prepare-contour2d.py',
  'scripts/prepare-sciviz-data.py',
  'scripts/prepare-sciviz-mapped.py',
  'scripts/prepare-sciviz-tetvolume.py',
];
// Scripts that name an outside address and fetch, but are not downloads somebody runs to get files.
const NOT_DOWNLOADS = {
  'scripts/build-catalog.js': 'a build step that asks the npm registry which versions are published',
  'scripts/modern-extension-tests.js': 'a browser test that answers those addresses itself',
  'scripts/reference-rendering/blend-repeat-scene.mjs': 'a scene module another check imports',
  'scripts/umbrella.mjs': 'writes an import map that names a CDN',
};

/** Runs one script under the guard. npm is replaced too: the runtimes script asks `npm_execpath` to install. */
function node(script, args) {
  return spawnSync(process.execPath, ['--import', guard, resolve(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, npm_execpath: resolve(root, 'tests/support/no-such-npm.js') },
  });
}

const python = [['python'], ['python3'], ['py', '-3']].find(([command, ...args]) =>
  /^Python 3\./.test(spawnSync(command, [...args, '--version'], { encoding: 'utf8', timeout: 30_000 }).stdout ?? ''),
);

function py(script, args) {
  assert.ok(python, 'Python 3 is required to check the Python download scripts');
  const [command, ...first] = python;
  return spawnSync(
    command,
    [...first, '-I', resolve(root, 'tests/support/refuse_downloads.py'), resolve(root, script), ...args],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
}

function check(run, script) {
  const help = run(script, ['--help']);
  assert.equal(help.error, undefined);
  assert.doesNotMatch(help.stderr, /REFUSED/, `${script} --help did work`);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage:/i);
  for (const args of [['--no-such-flag'], ['no-such-word']]) {
    const unknown = run(script, args);
    assert.equal(unknown.error, undefined);
    assert.doesNotMatch(unknown.stderr, /REFUSED/, `${script} ${args[0]} did work`);
    assert.equal(unknown.status, 2, `${script} ${args[0]}: ${unknown.stderr}`);
    assert.ok(unknown.stderr.includes(args[0]), `${script} names the argument it refused: ${unknown.stderr}`);
    assert.match(unknown.stderr, /usage:/i);
  }
}

for (const script of NODE_SCRIPTS)
  test(`${script} prints usage and refuses unknown arguments without downloading`, () => check(node, script));
for (const script of PYTHON_SCRIPTS)
  test(`${script} prints usage and refuses unknown arguments without downloading`, () => check(py, script));

test('a flag a script does take still reaches it', () => {
  // The guard stops each at its first piece of real work, which shows the arguments were accepted.
  for (const [script, args] of [
    ['scripts/fetch-readme-assets.mjs', ['--ffmpeg']],
    ['scripts/prepare-sciviz-cloud.mjs', ['--only=hemibrain']],
    ['scripts/reference-rendering/fetch-assets.mjs', ['--case=metallic-roughness']],
  ]) {
    const run = node(script, args);
    assert.match(run.stderr, /REFUSED/, `${script} ${args[0]}: ${run.stderr}`);
  }
  assert.match(py('packages/sciviz/scripts/fetch-amr-sample.py', ['--local']).stderr, /REFUSED urlopen/);
});

test('every tracked script that downloads is checked here', () => {
  const address =
    /https?:\/\/(?!localhost|127\.|\$\{|margoengine\.com\/errors|www\.w3\.org)[A-Za-z0-9.-]+\.[a-z]{2,}\//;
  const call = /\b(fetch|fetchFixture|urlopen|urlretrieve|cloudStore|get_mapper)\s*\(/;
  const found = execFileSync('git', ['ls-files', '-z', '--', 'scripts', 'packages/*/scripts', 'tools'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  })
    .split('\0')
    .filter((file) => /\.(c?js|mjs|ts|py)$/.test(file) && !file.includes('/support/'))
    .filter((file) => {
      if (/(^|\/)(fetch|download)[-_][^/]*$/.test(file)) return true;
      const code = readFileSync(resolve(root, file), 'utf8').replace(/^\s*(\/\/|#|\*).*$/gm, '');
      return address.test(code) && call.test(code);
    });
  const known = new Set([...NODE_SCRIPTS, ...PYTHON_SCRIPTS, ...Object.keys(NOT_DOWNLOADS)]);
  assert.deepEqual(
    found.filter((file) => !known.has(file)),
    [],
    'a new download script reads its arguments with scripts/support/download-arguments.mjs (argparse in Python) and ' +
      'is listed in this test',
  );
});
