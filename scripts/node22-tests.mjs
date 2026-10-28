// `npm run test:node22`: the unit tests of the packages that run code in Node (scripts/node22-packages.json), on the
// Node running this script. CI's "node22 unit tests (Node-run packages)" job runs it on Node 22.12.0 and the latest
// 22.x after build:packages; on Node 24 and later it runs the same files natively. The test files that use `using`
// declarations run through scripts/lib/lower-using.mjs, which lowers them only on a runtime that cannot parse them.
//   node scripts/node22-tests.mjs              every listed package's tests, once
//   node scripts/node22-tests.mjs --repeat=5   five times in a row (the flake check), stopping at the first failure
//   node scripts/node22-tests.mjs --list       print the test files and stop
// Every run has a hard limit (MARGO_NODE22_TIMEOUT_MIN, default 30 minutes); on timeout the process tree is killed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/** The config: { sharedTests, node: { name: reason | { reason, tests } }, contributorNode, browserOnly }. */
export const config = () => JSON.parse(readFileSync(join(root, 'scripts/node22-packages.json'), 'utf8'));

/** Published package directories by package name (packages/*, tools/*). */
export function packageDirs(base = root) {
  const dirs = new Map();
  for (const top of ['packages', 'tools'])
    for (const dir of existsSync(join(base, top)) ? readdirSync(join(base, top)) : []) {
      const file = join(base, top, dir, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (!manifest.private) dirs.set(manifest.name, { dir: join(base, top, dir), manifest });
    }
  return dirs;
}

/** Files matching `pattern` (a repository-relative path whose last part may hold one `*`). */
function expand(pattern, base) {
  const at = pattern.lastIndexOf('/'),
    folder = join(base, pattern.slice(0, at)),
    name = pattern.slice(at + 1);
  if (!name.includes('*')) return existsSync(join(base, pattern)) ? [join(base, pattern)] : [];
  const [head, tail] = name.split('*');
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((file) => file.startsWith(head) && file.endsWith(tail))
        .sort()
        .map((file) => join(folder, file))
    : [];
}

/** The test files of every package in the node list, as { name, files }; throws for a name with no package or tests. */
export function testFiles(base = root) {
  const dirs = packageDirs(base);
  return Object.entries(config().node).map(([name, entry]) => {
    const found = dirs.get(name);
    if (!found) throw new TypeError(`scripts/node22-packages.json lists ${name}, which is not a published package`);
    const files = [];
    for (const sub of ['tests', 'test']) files.push(...expand(`${relative(base, found.dir)}/${sub}/*.test.js`, base));
    for (const pattern of typeof entry === 'object' ? (entry.tests ?? []) : []) {
      const matched = expand(pattern, base);
      if (!matched.length)
        throw new TypeError(`scripts/node22-packages.json: ${name}'s test ${pattern} matches no file`);
      files.push(...matched);
    }
    if (!files.length)
      throw new TypeError(`scripts/node22-packages.json: ${name} has no test files; name them in its "tests"`);
    return { name, files: files.map((file) => relative(base, file).replaceAll('\\', '/')) };
  });
}

/** Ends a command and everything it started. */
function kill(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function main() {
  const repeat = Number(process.argv.find((arg) => arg.startsWith('--repeat='))?.slice(9) ?? 1);
  if (!Number.isInteger(repeat) || repeat < 1) throw new RangeError('--repeat takes a whole number of 1 or more');
  const groups = [{ name: 'shared (packages/shared and this harness)', files: config().sharedTests }, ...testFiles()],
    files = [...new Set(groups.flatMap((group) => group.files))];
  if (process.argv.includes('--list')) {
    for (const { name, files } of groups) console.log(`${name}\n  ${files.join('\n  ')}`);
    return;
  }
  const minutes = Number(process.env.MARGO_NODE22_TIMEOUT_MIN ?? 30),
    concurrency = Math.min(8, Math.max(2, availableParallelism() >> 1));
  console.log(
    `node22 unit tests: ${groups.length} packages, ${files.length} files on Node ${process.version}, ${repeat} run(s)`,
  );
  for (let run = 1; run <= repeat; run++) {
    const since = performance.now();
    const child = spawn(
      process.execPath,
      [
        // Some tests import TypeScript sources; Node strips types by default from 22.18 (process.features.typescript),
        // and 22.12 to 22.17 do it behind this flag, with the same strip-only rules.
        ...(process.features.typescript ? [] : ['--experimental-strip-types']),
        '--import',
        './scripts/lib/lower-using.mjs',
        '--experimental-test-module-mocks',
        '--test',
        `--test-concurrency=${concurrency}`,
        ...files,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks = [];
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => kill(child), minutes * 60_000);
    const code = await new Promise((done) => child.on('close', (value) => done(value ?? 1)));
    clearTimeout(timer);
    const output = Buffer.concat(chunks).toString(),
      seconds = Math.round((performance.now() - since) / 100) / 10;
    const count = (label) => new RegExp(`(?:#|ℹ) ${label} (\\d+)`).exec(output)?.[1] ?? '?';
    console.log(
      `run ${run}/${repeat}: ${code === 0 ? 'passed' : 'FAILED'} in ${seconds} s (pass ${count('pass')}, fail ${count('fail')})`,
    );
    if (code !== 0) {
      console.log(output.trimEnd());
      if (performance.now() - since >= minutes * 60_000) console.log(`timed out after ${minutes} minutes; killed`);
      process.exitCode = 1;
      return;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
