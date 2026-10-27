// The Node versions this repository declares, checked against what its files need (bug 23, 2026-10-27).
//   node scripts/check-engines.mjs                 any Node: the engines fields, the CI jobs and the syntax table agree
//   node scripts/check-engines.mjs --run=packages  also, on this Node: every shipped file parses and every package
//                                                  entry imports (after build:packages)
//   node scripts/check-engines.mjs --run=repo      also, on this Node: every repository script and test parses
// Two minimums, because users and contributors run different code:
//   packages  what users run: each package's dist and bin. Declared by the packages' own `engines` (all the same) and
//             checked by CI's node-compat job on exactly that version.
//   repo      what contributors run: the tests and scripts. Declared by the root package.json `engines` and checked by
//             CI's test job on exactly that version (the unit tests, so "run" is covered there).
// The syntax table catches a file that uses syntax newer than its scope's minimum on any Node (an old Node fails to
// parse it with a SyntaxError, as Node 22.22.1 did on 14 test files with `using` while the root declared >=22.12.0).
// The --run checks on the minimum itself are the backstop for anything the table does not list.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/** Syntax with the first Node release that parses it. Add a row when the code adopts newer syntax. */
export const SYNTAX = [
  {
    name: '`using` / `await using` declarations',
    node: '24.0.0',
    test: (node) => node.type === 'VariableDeclaration' && (node.kind === 'using' || node.kind === 'await using'),
  },
];

/** [major, minor, patch] of '>=22.12.0', '22.12.0' or 'v22.12.0'; throws for any other range. */
export function version(text) {
  const match = /^(?:>=\s*)?v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  if (!match)
    throw new TypeError(`engines.node must be ">=x.y.z" (got ${JSON.stringify(text)}); write the minimum that way`);
  return match.slice(1).map(Number);
}
export const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const show = (v) => v.join('.');

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
/** The published packages: { dir, manifest }. */
export function packages(base = root) {
  return readdirSync(join(base, 'packages'))
    .filter((dir) => existsSync(join(base, 'packages', dir, 'package.json')))
    .map((dir) => ({ dir: join(base, 'packages', dir), manifest: json(join(base, 'packages', dir, 'package.json')) }))
    .filter(({ manifest }) => !manifest.private);
}

const SKIP = new Set(['node_modules', '.git', 'test-results', '.tmp', 'target', 'fixtures']);
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.m?js$/.test(name)) out.push(path);
  }
  return out;
}
/** The JavaScript files of each scope. */
export function files(base = root) {
  const published = packages(base);
  const repo = [join(base, 'tests'), join(base, 'scripts')];
  for (const dir of readdirSync(join(base, 'packages')))
    for (const sub of ['tests', 'test', 'scripts']) repo.push(join(base, 'packages', dir, sub));
  return {
    packages: published.flatMap(({ dir }) => [...walk(join(dir, 'dist')), ...walk(join(dir, 'bin'))]),
    repo: repo.flatMap((dir) => walk(dir)),
  };
}

/** The ESTree nodes of `ast` for which `test` holds. */
function find(ast, test, found = []) {
  if (!ast || typeof ast !== 'object') return found;
  if (Array.isArray(ast)) {
    for (const item of ast) find(item, test, found);
    return found;
  }
  if (typeof ast.type === 'string' && test(ast)) found.push(ast);
  for (const key in ast) if (key !== 'type' && ast[key] && typeof ast[key] === 'object') find(ast[key], test, found);
  return found;
}

/** Problems (strings) with the declared minimums, the CI jobs and the syntax each scope uses. */
export async function check(base = root) {
  const problems = [];
  const rootRange = json(join(base, 'package.json')).engines?.node;
  if (!rootRange) problems.push('package.json declares no engines.node (the minimum Node for the tests and scripts)');
  const repoMin = rootRange && version(rootRange);
  const declared = packages(base).filter(({ manifest }) => manifest.engines?.node);
  const ranges = [...new Set(declared.map(({ manifest }) => manifest.engines.node))];
  if (ranges.length !== 1)
    problems.push(
      `the published packages must declare one engines.node; found ${ranges.length ? ranges.join(', ') : 'none'}`,
    );
  const packageMin = ranges.length && version(ranges[0]);
  if (repoMin && packageMin && compare(packageMin, repoMin) > 0)
    problems.push(`the packages need Node ${show(packageMin)}, more than the repository's ${show(repoMin)}`);

  // CI must run each scope on its minimum exactly.
  const ci = readFileSync(join(base, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
  const job = (name) => new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'm').exec(ci)?.[1] ?? '';
  const versions = (text) => [...text.matchAll(/node(?:-version)?: (\[[^\]]*\]|'[^']*'|\S+)/g)].map((m) => m[1]);
  if (repoMin && !versions(job('test')).some((v) => v.replaceAll("'", '') === show(repoMin)))
    problems.push(`ci.yml's test job must run on node-version '${show(repoMin)}', the root engines minimum`);
  if (packageMin && !versions(job('node-compat')).some((v) => v.includes(`'${show(packageMin)}'`)))
    problems.push(`ci.yml's node-compat matrix must include '${show(packageMin)}', the packages' engines minimum`);

  const { parseAst } = await import('rolldown/parseAst');
  const scopes = files(base);
  for (const [scope, min] of [
    ['packages', packageMin],
    ['repo', repoMin],
  ]) {
    if (!min) continue;
    for (const file of scopes[scope]) {
      let ast;
      try {
        ast = parseAst(readFileSync(file, 'utf8'), { sourceType: 'module' });
      } catch {
        continue; // not ECMAScript the parser takes (a CommonJS template, say); --run parses it on the real Node
      }
      for (const row of SYNTAX)
        if (compare(version(row.node), min) > 0 && find(ast.body, row.test).length)
          problems.push(
            `${relative(base, file)} uses ${row.name}, which needs Node ${row.node}, but its scope (${scope}) declares >=${show(min)}`,
          );
    }
  }
  return problems;
}

/** Files of `scope` this Node cannot parse, as "file: message" (a child with vm modules does the parsing). */
export function unparsable(scope, base = root) {
  const list = files(base)[scope];
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import vm from 'node:vm'; import { readFileSync } from 'node:fs';
       for (const file of JSON.parse(readFileSync(0, 'utf8'))) {
         try { new vm.SourceTextModule(readFileSync(file, 'utf8').replace(/^#!.*/, ''), { identifier: file }); }
         catch (error) { if (error instanceof SyntaxError) console.log(file + ': ' + error.message); }
       }`,
    ],
    { encoding: 'utf8', input: JSON.stringify(list), maxBuffer: 1 << 26, timeout: 10 * 60_000 },
  );
  if (child.status !== 0) throw new Error(`the parse check failed to run: ${child.stderr}`);
  return child.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => relative(base, line));
}

/** Package entries (every JavaScript target of every exports map) this Node cannot import, as "name key: error". */
export async function unimportable(base = root) {
  const targets = (value) =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.entries(value)
            .filter(([condition]) => condition !== 'types')
            .flatMap(([, v]) => targets(v))
        : [];
  const failed = [];
  for (const { dir, manifest } of packages(base)) {
    const map = typeof manifest.exports === 'string' ? { '.': manifest.exports } : (manifest.exports ?? {});
    for (const [key, value] of Object.entries(map)) {
      if (key.includes('*')) continue;
      for (const target of new Set(targets(value).filter((t) => /\.m?js$/.test(t))))
        try {
          await import(pathToFileURL(join(dir, target)).href);
        } catch (error) {
          failed.push(`${manifest.name} ${key} (${target}): ${error?.constructor?.name}: ${String(error?.message)}`);
        }
    }
  }
  return failed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const run = process.argv.find((arg) => arg.startsWith('--run='))?.slice(6);
  if (run && run !== 'packages' && run !== 'repo') throw new TypeError('--run takes packages or repo');
  const problems = await check();
  if (run) {
    problems.push(...unparsable(run).map((line) => `Node ${process.version} cannot parse ${line}`));
    if (run === 'packages')
      problems.push(...(await unimportable()).map((line) => `Node ${process.version} cannot import ${line}`));
  }
  for (const problem of problems) console.error(`check-engines: ${problem}`);
  console.log(
    problems.length
      ? `check-engines: ${problems.length} problem(s)`
      : `check-engines: ok (${run ? `${run} parse${run === 'packages' ? ' and import' : ''} on ${process.version}` : 'static'})`,
  );
  process.exitCode = problems.length ? 1 : 0;
}
