// Runs tests/frame-alloc.test.js under every Node it finds (`npm run test:frame-alloc:nodes`) and fails naming each
// Node and V8 version whose frame allocates over its limit. The middle tier (Maglev) differs between V8 versions: the
// limits once held only on the Node that set them (Node 26) and failed on the minimum Node (24.18).
// Nodes: MARGO_NODES (executables separated by the path delimiter, ';' on Windows, ':' elsewhere), this Node, and any
// under ~/.nvm/versions/node, NVM_HOME (nvm-windows), VOLTA_HOME and ~/margo/node* (the Linux test server). Nodes below
// the repository's minimum (package.json engines) are listed as skipped: the repository's tests need it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'),
  minimum = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.node.replace(/^>=\s*/, ''),
  windows = process.platform === 'win32',
  exe = windows ? 'node.exe' : join('bin', 'node');
const below = (version, floor) => {
  const a = version.replace(/^v/, '').split('.').map(Number),
    b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};
const inside = (folder, pick = () => true) =>
  existsSync(folder)
    ? readdirSync(folder)
        .filter(pick)
        .map((name) => join(folder, name, exe))
    : [];
const home = homedir(),
  candidates = [
    ...(process.env.MARGO_NODES ?? '').split(delimiter).filter(Boolean),
    process.execPath,
    ...inside(join(home, '.nvm', 'versions', 'node')),
    ...(process.env.NVM_HOME ? inside(process.env.NVM_HOME, (name) => /^v\d/.test(name)) : []),
    ...(process.env.VOLTA_HOME ? inside(join(process.env.VOLTA_HOME, 'tools', 'image', 'node')) : []),
    ...inside(join(home, 'margo'), (name) => /^node\d*$/.test(name)),
  ];

const nodes = new Map();
for (const path of candidates) {
  if (!existsSync(path)) continue;
  const probe = spawnSync(path, ['-p', 'process.version + " " + process.versions.v8'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const [version, v8] = probe.stdout?.trim().split(' ') ?? [];
  if (probe.status === 0 && version && !nodes.has(version)) nodes.set(version, { path, v8 });
}

const failed = [];
for (const [version, { path, v8 }] of [...nodes].sort()) {
  const name = `Node ${version} (V8 ${v8})`;
  if (below(version, minimum)) {
    console.log(`${name}: skipped, below the repository's minimum Node ${minimum}`);
    continue;
  }
  const run = spawnSync(path, ['--test', 'tests/frame-alloc.test.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 900_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`,
    lines = output.split(/\r?\n/);
  if (run.status === 0) {
    const skipped = lines.filter((line) => /# SKIP/.test(line)).length;
    console.log(`${name}: pass${skipped ? ` (${skipped} skipped)` : ''}`);
  } else {
    failed.push(name);
    console.log(`${name}: FAIL${run.error ? ` (${run.error.message})` : ''}`);
    for (const line of lines.filter((line) => /AssertionError|B per (frame|call)|^✖/.test(line)).slice(0, 12))
      console.log(`  ${line.trim()}`);
  }
}
if (!nodes.size) throw new Error('No Node executable found; set MARGO_NODES to the Node executables to test.');
if (failed.length) {
  console.error(`Frame allocation over its limit on ${failed.join(', ')}.`);
  process.exit(1);
}
