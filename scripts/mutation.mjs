// Hand-rolled mutation runner (no dependency). It parses a package source file with the TypeScript compiler, lists
// small operator and constant changes ("mutants": `<` to `<=`, `+` to `-`, `&&` to `||`, `!x` to `x`, a constant plus
// one, `true` to `false`), builds the package once per mutant with that single change, and runs the named test files
// against the build. A test run that fails, crashes or times out kills the mutant; a mutant every test passes
// survives, which means a test is missing or too weak. The score is killed / (killed + survived).
//
//   node scripts/mutation.mjs biomes                 classify, fixed and placement, the published targets
//   node scripts/mutation.mjs biomes fixed --cap=40  one target, at most 40 mutants
//   node scripts/mutation.mjs biomes --list          only count the mutants
//
// Rules kept from the repository: a surviving mutant is fixed with a new test, never by removing the mutant or
// loosening an existing test; `equivalent` below lists only mutants that provably cannot change any output, each
// with its reason. The mutated builds live in `packages/<name>/.mutation/` (git-ignored) and are removed at the end.
import { parseSync } from 'rolldown/utils';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));

/** Source files and the test files (fastest first, so most mutants die early) that must kill their mutants. */
export const TARGETS = {
  biomes: {
    classify: {
      file: 'src/classify.ts',
      tests: [
        'classify-mutants.test.js',
        'classify.test.js',
        'climate.test.js',
        'gpu-classify-inputs.test.js',
        'gpu-classify-warp.test.js',
      ],
    },
    fixed: {
      file: 'src/fixed.ts',
      tests: ['fixed.test.js', 'fixed-mutants.test.js', 'classify.test.js', 'climate.test.js', 'relief.test.js'],
    },
    placement: {
      file: 'src/placement.ts',
      tests: ['placement-mutants.test.js', 'placement-output.test.js', 'placement-band.test.js', 'placement.test.js'],
    },
  },
};

const SWAPS = new Map([
  ['+', '-'],
  ['-', '+'],
  ['*', '+'],
  ['<', '<='],
  ['<=', '<'],
  ['>', '>='],
  ['>=', '>'],
  ['===', '!=='],
  ['!==', '==='],
  ['&&', '||'],
  ['||', '&&'],
  ['&', '|'],
  ['|', '&'],
  ['<<', '>>'],
  ['>>', '<<'],
  ['+=', '-='],
  ['-=', '+='],
]);

// Keys that hold types: never mutated.
const TYPE_KEYS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeArguments']);
const TYPE_NODES = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);

/**
 * Every mutant of `source`, as `{ id, line, start, end, from, to, operator }` in source order. Types, comments, strings
 * and template text are never touched (only expression nodes of the parsed tree are visited).
 * @param {string} source
 * @param {string} [fileName]
 */
export function mutantsOf(source, fileName = 'file.ts') {
  const { program } = parseSync(fileName, source);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const found = [];
  const add = (start, end, to, operator) => {
    const from = source.slice(start, end);
    if (from !== to) found.push({ line: lineOf(start), start, end, from, to, operator });
  };
  const operatorAt = (node, operator) => {
    // The operator sits between the operands; comments there are skipped by searching after the left operand.
    const gap = source.slice(node.left.end, node.right.start);
    const at = gap.replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, (m) => ' '.repeat(m.length)).indexOf(operator);
    return at < 0 ? -1 : node.left.end + at;
  };
  const walk = (node) => {
    if (!node || typeof node.type !== 'string' || TYPE_NODES.has(node.type)) return;
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression' || node.type === 'AssignmentExpression') {
      const to = SWAPS.get(node.operator);
      const at = to === undefined ? -1 : operatorAt(node, node.operator);
      if (at >= 0) add(at, at + node.operator.length, to, node.operator + ' -> ' + to);
    } else if (node.type === 'UnaryExpression' && node.operator === '!') {
      add(node.start, node.argument.start, '', '! removed');
    } else if (node.type === 'Literal') {
      if (
        typeof node.value === 'number' &&
        Number.isSafeInteger(node.value) &&
        !/^0[xXbBoO]/.test(node.raw) &&
        node.value < 2 ** 30
      ) {
        const to = String(node.value === 0 ? 1 : node.value + 1);
        add(node.start, node.end, to, node.raw + ' -> ' + to);
      } else if (typeof node.value === 'boolean')
        add(node.start, node.end, String(!node.value), node.raw + ' -> ' + !node.value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (TYPE_KEYS.has(key) || key === 'parent') continue;
      if (Array.isArray(value)) for (const item of value) walk(item);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(program);
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  return found.map((m, i) => ({ id: i, ...m }));
}

/** The source with one mutant applied. */
export function applyMutant(source, mutant) {
  return source.slice(0, mutant.start) + mutant.to + source.slice(mutant.end);
}

/** A seeded, repeatable choice of at most `cap` mutants, spread over the whole file, in source order. */
export function pickMutants(mutants, cap, seed = 1) {
  if (!(cap > 0) || mutants.length <= cap) return mutants.slice();
  let s = seed >>> 0 || 1;
  const order = mutants.map((m) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return [s, m];
  });
  order.sort((a, b) => a[0] - b[0]);
  return order
    .slice(0, cap)
    .map(([, m]) => m)
    .sort((a, b) => a.start - b.start);
}

/** killed / (killed + survived), as a fraction; timeouts and crashes count as killed. */
export function scoreOf(results) {
  const killed = results.filter((r) => r.status === 'killed').length;
  const survived = results.filter((r) => r.status === 'survived').length;
  const total = killed + survived;
  return { killed, survived, total, score: total ? killed / total : 1 };
}

/**
 * Runs `node --test` on each file in turn inside `cwd`; resolves `{ passed, file, reason }` at the first file that
 * fails (an early `not ok` line, a non-zero exit, or `timeoutMs` of silence-free running) and kills it at once.
 */
export async function runTests(cwd, files, { timeoutMs = 240_000 } = {}) {
  for (const file of files) {
    const outcome = await new Promise((done) => {
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        done(value);
      };
      const timer = setTimeout(() => finish({ passed: false, reason: 'timeout' }), timeoutMs);
      child.stdout.on('data', (d) => {
        out += d;
        if (/^\s*not ok /m.test(out)) finish({ passed: false, reason: 'assertion' });
      });
      child.stderr.on('data', () => {});
      child.on('error', () => finish({ passed: false, reason: 'spawn' }));
      child.on('close', (code) => finish(code === 0 ? { passed: true } : { passed: false, reason: `exit ${code}` }));
    });
    if (!outcome.passed) return { ...outcome, file };
  }
  return { passed: true };
}

async function buildInto(name, work, target, mutated) {
  const { build } = await import('vite');
  const root = resolve(repository, 'packages', name);
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const peers = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
  const entries = {};
  for (const entry of Object.values(manifest.exports)) {
    const module = entry.import.slice('./dist/'.length, -'.js'.length);
    entries[module] = resolve(root, 'src', module + '.ts');
  }
  const targetPath = resolve(root, target).replaceAll('\\', '/');
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'mutant',
        enforce: 'pre',
        load(id) {
          return id.split('?')[0].replaceAll('\\', '/') === targetPath ? mutated : null;
        },
      },
    ],
    build: {
      outDir: resolve(work, 'dist'),
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      lib: { entry: entries, formats: ['es'], fileName: (_format, entry) => entry + '.js' },
      rollupOptions: {
        external: (id) =>
          id.startsWith('node:') || [...peers, manifest.name].some((peer) => id === peer || id.startsWith(peer + '/')),
      },
    },
  });
}

/** Runs one target; `onResult` is called after each mutant. Returns the result list. */
export async function runTarget(
  name,
  targetName,
  { cap = 0, seed = 1, jobs = 4, listOnly = false, lines = null, log = console.log } = {},
) {
  const target = TARGETS[name]?.[targetName];
  if (!target) throw new Error(`unknown target ${name}/${targetName}`);
  const root = resolve(repository, 'packages', name);
  const source = await readFile(resolve(root, target.file), 'utf8');
  const all = mutantsOf(source, target.file);
  const inRange = lines ? all.filter((m) => m.line >= lines[0] && m.line <= lines[1]) : all;
  const chosen = pickMutants(inRange, cap, seed);
  log(`${name}/${targetName}: ${all.length} mutants, running ${chosen.length}`);
  if (listOnly) return { results: [], all: all.length };
  const slots = [];
  for (let i = 0; i < jobs; i++) {
    // Same depth as the package, so tests' relative imports (../dist, ../bench, ../../../scripts) all resolve.
    const top = resolve(repository, '.mutation', name + '-' + targetName + '-' + i);
    const work = resolve(top, 'packages', name);
    await rm(top, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await cp(resolve(root, 'tests'), resolve(work, 'tests'), { recursive: true });
    await cp(resolve(root, 'bench'), resolve(work, 'bench'), { recursive: true }).catch(() => {});
    // Tests that import ../src/*.ts (through a resolve hook) see the mutant too: the slot holds its own copy of src.
    await cp(resolve(root, 'src'), resolve(work, 'src'), { recursive: true });
    await cp(resolve(repository, 'packages/shared'), resolve(top, 'packages/shared'), { recursive: true }).catch(
      () => {},
    );
    await cp(resolve(root, 'package.json'), resolve(work, 'package.json'));
    await cp(resolve(repository, 'scripts/support'), resolve(top, 'scripts/support'), { recursive: true });
    slots.push(work);
  }
  const results = new Array(chosen.length);
  let next = 0;
  // Sanity: the unmutated build must pass, or every "kill" would be a broken build.
  await writeFile(resolve(slots[0], target.file), source);
  await buildInto(name, slots[0], target.file, source);
  const base = await runTests(resolve(slots[0], 'tests'), target.tests);
  if (!base.passed) throw new Error(`unmutated ${name}/${targetName} fails ${base.file}: ${base.reason}`);
  const worker = async (slot) => {
    for (;;) {
      const index = next++;
      if (index >= chosen.length) return;
      const mutant = chosen[index];
      const record = { ...mutant, file: target.file };
      try {
        const mutated = applyMutant(source, mutant);
        await writeFile(resolve(slot, target.file), mutated);
        await buildInto(name, slot, target.file, mutated);
        const run = await runTests(resolve(slot, 'tests'), target.tests);
        record.status = run.passed ? 'survived' : 'killed';
        if (!run.passed) record.killedBy = `${run.file} (${run.reason})`;
      } catch (error) {
        // A mutant that does not build is a compile-time kill.
        record.status = 'killed';
        record.killedBy = 'build error: ' + String(error.message).split('\n')[0].slice(0, 80);
      }
      results[index] = record;
      if (record.status === 'survived')
        log(`  SURVIVED ${target.file}:${record.line} ${record.operator}  (${record.from} -> ${record.to})`);
    }
  };
  await Promise.all(slots.map(worker));
  await rm(resolve(repository, '.mutation'), { recursive: true, force: true });
  return { results, all: all.length };
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flag = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const [name, ...wanted] = args;
  if (!TARGETS[name])
    throw new Error(
      `usage: node scripts/mutation.mjs <${Object.keys(TARGETS).join('|')}> [target...] [--cap=N] [--jobs=N] [--list] [--json=path]`,
    );
  const names = wanted.length ? wanted : Object.keys(TARGETS[name]);
  const report = {};
  for (const targetName of names) {
    const { results, all } = await runTarget(name, targetName, {
      cap: Number(flag('cap', 0)),
      jobs: Number(flag('jobs', 4)),
      seed: Number(flag('seed', 1)),
      listOnly: argv.includes('--list'),
      lines: flag('lines', '') ? flag('lines', '').split('-').map(Number) : null,
    });
    const s = scoreOf(results);
    report[targetName] = { generated: all, ...s, survivors: results.filter((r) => r.status === 'survived') };
    if (!argv.includes('--list'))
      console.log(
        `${name}/${targetName}: killed ${s.killed} / ${s.total} = ${(s.score * 100).toFixed(1)} %, survivors ${s.survived}`,
      );
  }
  const out = flag('json', '');
  if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
