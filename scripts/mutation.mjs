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
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killChildTreeSync } from './support/shutdown.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));

const mathTests = [
  'vector-pins.test.js',
  'quaternion-pins.test.js',
  'matrix-pins.test.js',
  'bounds-pins.test.js',
  'box3-unbounded.test.js',
  'frustum-unbounded.test.js',
  'shape-box-unbounded.test.js',
  'ray-box-edges.test.js',
  'mathutils-log2.test.js',
  'ray-pins.test.js',
  'line-frustum-pins.test.js',
  'triangle-pins.test.js',
  'seed-pins.test.js',
  'math.test.js',
  'methods.test.js',
  'edge-cases.test.js',
  'audit-132.test.js',
  'arrays.test.js',
  'checked.test.js',
  'entries.test.js',
  'field-types.test.js',
  'degrees.test.js',
  'split-trs.test.js',
  'euler-poles.test.js',
  'euler-quaternion.test.js',
  'euler-workcount.test.js',
  'line3-triangle.test.js',
  'ray-box.test.js',
  'obb.test.js',
  'capsule.test.js',
  'billboard.test.js',
  'project.test.js',
  'curve.test.js',
  'sh.test.js',
  'grade.test.js',
  'color-p3.test.js',
  'color-primaries.test.js',
  'color-space.test.js',
];

/** `equivalent` rows for one reason: `equiv(reason, [line, from, to], ...)`. */
function equiv(reason, ...rows) {
  return rows.map(([line, from, to]) => ({ line, from, to, reason }));
}

const OUT_OF_RANGE =
  'the loop or scratch size is one past the typed array: a read gives undefined and a write is ignored, or a later write replaces the value, so no output changes';
const ZERO_VECTOR =
  'only differs when the divisor is a zero vector, whose components are all zero, so 0 / 2 gives the same result as 0 / 1';
const AT_BOUNDARY =
  'the changed comparison differs only when two doubles are exactly equal, and both branches then give the same value';

/** One target per source file name: `{ name: { file: 'src/name.ts', tests } }`. */
function sourceTargets(names, tests, equivalent = {}) {
  return Object.fromEntries(
    names.map((name) => [name, { file: `src/${name}.ts`, tests, parallel: true, equivalent: equivalent[name] ?? [] }]),
  );
}

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
  // One target per source file, named after it; every target runs the whole CPU test list of its package.
  math: sourceTargets(
    [
      'vector2',
      'vector3',
      'vector4',
      'quaternion',
      'euler',
      'matrix3',
      'matrix4',
      'box3',
      'sphere',
      'plane',
      'ray',
      'line3',
      'frustum',
      'triangle',
      'mathutils',
    ],
    mathTests,
    {
      vector2: equiv(ZERO_VECTOR, [115, '1', '2']).concat(
        equiv(
          'a is 0 here, and the wrapped value 0 + 2 pi is returned as 0 by the next line, so the same 0 comes out',
          [123, '>=', '>'],
        ),
      ),
      vector3: equiv(ZERO_VECTOR, [157, '1', '2']).concat(
        equiv(AT_BOUNDARY + ' (lengthSq equal to 1e-290: sqrt and hypot agree on 1e-145)', [150, '>', '>=']),
        equiv('d is 0 only for the zero vector, and then v.x * 1, v.y * 1 and v.z * 1 are 0 as well', [195, '0', '1']),
      ),
      vector4: equiv(ZERO_VECTOR, [105, '1', '2']).concat(
        equiv(AT_BOUNDARY + ' (lengthSq equal to 1e-290: sqrt and hypot agree)', [102, '>', '>=']),
      ),
      quaternion: equiv(ZERO_VECTOR, [148, '1', '2']).concat(
        equiv(
          AT_BOUNDARY +
            ' (1 + dot equal to 1e-8 exactly: the half turn and the half-way vector are the same rotation there)',
          [102, '<', '<='],
        ),
        equiv(
          AT_BOUNDARY +
            ' (sin squared equal to Number.EPSILON: the straight line and the arc differ by less than 1e-16)',
          [208, '<=', '<'],
        ),
      ),
      matrix3: equiv(OUT_OF_RANGE, [86, '<', '<='], [86, '9', '10'], [157, '<', '<='], [157, '9', '10']),
      matrix4: equiv(
        OUT_OF_RANGE,
        [70, '<', '<='],
        [70, '4', '5'],
        [75, '<', '<='],
        [75, '4', '5'],
        [83, '<', '<='],
        [83, '16', '17'],
        [154, '<', '<='],
        [154, '4', '5'],
        [299, '<', '<='],
        [299, '3', '4'],
        [301, '<', '<='],
        [301, '3', '4'],
        [449, '<', '<='],
        [449, '16', '17'],
      ).concat(
        equiv(
          'decompose hands setFromRotationMatrix only the upper 3 x 3 of the scratch matrix, so the fourth row and column it writes here are never read',
          [302, '4', '5'],
          [302, '3', '4'],
          [302, '0', '1'],
          [304, '12', '13'],
          [304, '13', '14'],
          [304, '14', '15'],
          [304, '0', '1'],
          [305, '15', '16'],
          [305, '1', '2'],
        ),
      ),
      box3: equiv(
        'the plane normal component is non-zero inside this branch, so the changed comparison is the same test as before',
        [190, '>', '>='],
        [191, '>', '>='],
        [194, '>', '>='],
        [195, '>', '>='],
        [198, '>', '>='],
        [199, '>', '>='],
      ),
      sphere: equiv(
        'the two spheres touch from inside here, and the union in exact arithmetic is the larger sphere itself, as the early return gives: centre and radius agree',
        [126, '<=', '<'],
        [127, '<=', '<'],
      ).concat(
        equiv(
          'at equality the scale factor, or the step, is exactly 1 or 0, so the result is the same either way',
          [90, '>', '>='],
          [115, '>', '>='],
        ),
      ),
      plane: equiv(ZERO_VECTOR, [70, '1', '2'], [78, '1', '2'], [95, '1', '2']).concat(
        equiv('a determinant of exactly 0 gives a zero cofactor normal, which negating leaves as zero', [
          117,
          '<',
          '<=',
        ]),
      ),
      frustum: equiv(
        'the plane normal component is non-zero inside this branch, so the changed comparison is the same test as before',
        [74, '>', '>='],
        [75, '>', '>='],
        [76, '>', '>='],
      ),
      ray: equiv(
        'the extra pass repeats the z slab test, which changes neither near nor far, so the loop gives the same answer',
        [142, '<', '<='],
        [142, '3', '4'],
      ).concat(
        equiv(
          'assigning an equal value, or swapping two equal values, changes nothing',
          [155, '>', '>='],
          [160, '>', '>='],
          [161, '>', '>='],
          [162, '<', '<='],
        ),
        equiv(
          'u above 1 with v at least 0 gives u + v above 1, which the next line rejects, and v below 0 is rejected too',
          [193, '1', '2'],
        ),
      ),
      line3: equiv('equal clamp bounds return the same value from either side', [6, '<', '<='], [6, '>', '>=']).concat(
        equiv(
          'the start value of s or t is overwritten before use, or only multiplies a zero-length direction, so no distance or point changes',
          [107, '0', '1'],
          [108, '0', '1'],
          [109, '0', '1'],
        ),
        equiv(
          AT_BOUNDARY +
            ' (a parallel pair on the exact limit, or t exactly 0 or 1, where the re-clamped s equals the first s)',
          [117, '>', '>='],
          [119, '<', '<='],
          [122, '>', '>='],
        ),
      ),
      triangle: equiv(
        OUT_OF_RANGE,
        [8, '9', '10'],
        [9, '9', '10'],
        [10, '3', '4'],
        [247, '<', '<='],
        [247, '3', '4'],
        [258, '<', '<='],
        [258, '9', '10'],
      ).concat(
        equiv('equal clamp bounds return the same value from either side', [20, '<', '<='], [20, '>', '>=']),
        equiv(
          'the scratch value is overwritten before it is read, or the result is the same zero for a degenerate triangle',
          [88, '0', '1'],
          [134, '0', '1'],
          [142, '0', '1'],
          [154, '0', '1'],
          [211, '0', '1'],
          [189, '0', '1'],
          [190, '0', '1'],
          [191, '0', '1'],
        ),
        equiv(
          AT_BOUNDARY +
            ' (a projection exactly on an edge belongs to that edge in both branches, and tied edges share the nearest vertex)',
          [176, '>', '>='],
          [179, '>=', '>'],
          [179, '<=', '<'],
          [189, '>', '>='],
          [190, '>', '>='],
          [195, '<=', '<'],
          [196, '<=', '<'],
        ),
        equiv(
          'the separating test is invariant under scaling an axis, and the reversed edge order gives the same set of axes up to sign',
          [246, '1', '2'],
          [249, '1', '2'],
        ),
      ),
      mathutils: equiv(
        'at x equal to min or max the formula already gives exactly 0 or 1',
        [24, '>=', '>'],
        [31, '>=', '>'],
      ).concat(
        equiv('0x9e3779b9 is odd, so OR-ing it with 1 leaves the start state unchanged', [89, '0', '1']),
        equiv(
          'the second correction only runs for 0 and Infinity, where p / 2, p / 3 and p are the same value, because Math.log2 never rounds across a power of two (mathutils-log2.test.js pins it at every power and 4096 steps either side)',
          [49, '2', '3'],
          [49, '>=', '>'],
          [56, '2', '3'],
          [56, '<=', '<'],
        ),
      ),
    },
  ),
  splines: sourceTargets(
    ['closest', 'fit', 'frames', 'index', 'kinds', 'knots', 'mesh', 'offset', 'polynomial', 'query'],
    [
      'splines.test.js',
      'kinds.test.js',
      'features.test.js',
      'periodic.test.js',
      'offset.test.js',
      'query.test.js',
      'intersect-workcount.test.js',
    ],
  ),
  fsm: sourceTargets(
    ['document', 'events', 'final', 'index', 'inspect', 'invoke', 'parallel', 'scxml', 'trace'],
    [
      'pins.test.js',
      'scxml-pins.test.js',
      'final-pins.test.js',
      'document-issues.test.js',
      'index-pins.test.js',
      'inspect-pins.test.js',
      'invoke-pins.test.js',
      'parallel-pins.test.js',
      'trace-pins.test.js',
      'scxml-export-pins.test.js',
      'fsm.test.js',
      'events.test.js',
      'document.test.js',
      'final.test.js',
      'history.test.js',
      'delay.test.js',
      'invoke.test.js',
      'parallel.test.js',
      'scxml.test.js',
      'inspect.test.js',
      'trace.test.js',
    ],
    {
      final: equiv('steps starts at 0 again in stabilize, its only reader, before any read', [26, '0', '1']).concat(
        equiv(
          'start or after undefined makes distance NaN, and NaN > 0 is false, so the transition is skipped either way',
          [140, '||', '&&'],
        ),
        equiv('the return runs the finally, which sets the queue length to 0 straight after', [185, '0', '1']),
      ),
      index: equiv(
        'an undefined duration gives 0 or 1 here, both finite and not negative, so validation passes either way',
        [114, '0', '1'],
        [115, '0', '1'],
      ).concat(
        equiv(
          'the extra step compares a name past the end of one path with the other path: equal only when both paths end, which means the same state, and change returned before',
          [189, '<', '<='],
        ),
        equiv('at end equal to due, due is set to the value it already holds', [267, '<', '<=']),
        equiv('when the re-arm time equals the entry time both branches return the same number', [290, '>', '>=']),
        equiv(
          'path[length + 1] and path[length] are undefined, which matches no transition from a state name, so the scan finds the same transition',
          [294, '-', '+'],
        ),
        equiv('the only caller tests index < 0, so -1 and -2 mean the same', [304, '1', '2']),
      ),
      inspect: equiv('an AbortSignal fires abort once, and dispose removes the listener, so once changes nothing', [
        91,
        'true',
        'false',
      ]),
      invoke: equiv(
        'an AbortSignal fires abort once, and dispose or settling removes the listener, so once changes nothing',
        [97, 'true', 'false'],
        [156, 'true', 'false'],
      ).concat(
        equiv(
          'a run leaves live only through cancel, which also aborts it, and is aborted only there, so both tests are true together or false together',
          [160, '||', '&&'],
          [166, '||', '&&'],
        ),
      ),
      parallel: equiv('the loop ends only with an empty queue, so clearing it again changes nothing', [
        202,
        'true',
        'false',
      ]),
      scxml: equiv(
        'regionXML is called with depth 0 from the root and with depth + level + 2 from write, which has already refused depth + level + 3 above 128, so depth is at most 127 here and this check never fires (scxml-export-pins.test.js pins the 126 and 62 level limits)',
        [348, '>', '>='],
        [348, '128', '129'],
      ),
    },
  ),
  tween: sourceTargets(
    [
      'async',
      'bezier',
      'control',
      'custom-ease',
      'damp',
      'easings',
      'full-timeline',
      'index',
      'inertia',
      'interpolate',
      'motion-path',
      'props',
      'scroll',
      'scroll-pin',
      'spring',
      'stagger',
      'timeline',
    ],
    [
      'tween.test.js',
      'depth.test.js',
      'linear-oracle.test.js',
      'timeline.test.js',
      'full-timeline.test.js',
      'control.test.js',
      'async.test.js',
      'custom-ease.test.js',
      'props.test.js',
      'stagger.test.js',
      'motion-path.test.js',
      'damp.test.js',
      'spring.test.js',
      'inertia.test.js',
      'scroll.test.js',
      'scroll-pin.test.js',
    ],
  ),
  wfc: sourceTargets(
    [
      'assemble',
      'chunks',
      'constraints',
      'graph',
      'grid',
      'heap',
      'hex',
      'index',
      'overlapping',
      'overlapping3d',
      'sockets',
      'tileset',
      'worker',
    ],
    [
      'wfc.test.js',
      'sockets.test.js',
      'tileset.test.js',
      'hex.test.js',
      'assemble.test.js',
      'inputs.test.js',
      'overlapping3d.test.js',
      'overlapping-pins.test.js',
      'constraints.test.js',
      'overlapping.test.js',
      'worker.test.js',
      'loading.test.js',
      'chunks.test.js',
    ],
  ),
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

/**
 * Marks surviving mutants listed in a target's `equivalent` table (`{ line, from, to, reason }`) as `equivalent`: they
 * cannot change any output, so they count neither as killed nor as survived. Every other result is returned as it is.
 */
export function markEquivalent(results, equivalent = []) {
  return results.map((r) => {
    if (r.status !== 'survived') return r;
    const hit = equivalent.find((e) => e.line === r.line && e.from === r.from && e.to === r.to);
    return hit ? { ...r, status: 'equivalent', reason: hit.reason } : r;
  });
}

/**
 * The rows of an `equivalent` table that name no mutant of the source (`all`, from mutantsOf): a source edit or
 * reformat moved the line. markEquivalent would leave such a mutant counted as survived without a word.
 */
export function staleEquivalents(all, equivalent = []) {
  return equivalent.filter((e) => !all.some((m) => m.line === e.line && m.from === e.from && m.to === e.to));
}

/** killed / (killed + survived), as a fraction; timeouts and crashes count as killed, equivalent mutants are left out. */
export function scoreOf(results) {
  const killed = results.filter((r) => r.status === 'killed').length;
  const survived = results.filter((r) => r.status === 'survived').length;
  const total = killed + survived;
  return { killed, survived, total, score: total ? killed / total : 1 };
}

/** The folder a package keeps its tests in: `tests` where it exists, otherwise `test`. */
export function testDirOf(packageRoot) {
  return existsSync(resolve(packageRoot, 'tests')) ? 'tests' : 'test';
}

/**
 * Runs `node --test` on each file in turn inside `cwd`; resolves `{ passed, file, reason }` at the first file that
 * fails (an early `not ok` line, a non-zero exit, or `timeoutMs` of silence-free running) and kills it at once.
 */
export async function runTests(cwd, files, { timeoutMs = 240_000, parallel = false } = {}) {
  // `parallel` hands every file to one `node --test` process, which runs them side by side; the first `not ok`
  // line, crash or timeout still kills the mutant, and the run stops at once.
  const groups = parallel ? [files] : files.map((file) => [file]);
  for (const group of groups) {
    const outcome = await new Promise((done) => {
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...group], {
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
        // `node --test` runs each file in a child process of its own: end the whole tree, or a child keeps the folder busy.
        if (child.exitCode !== null) done(value);
        else if (process.platform === 'win32') {
          killChildTreeSync(child);
          done(value);
        } else {
          child.kill('SIGKILL');
          done(value);
        }
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
    if (!outcome.passed)
      return { ...outcome, file: group.length === 1 ? group[0] : 'one of ' + group.length + ' files' };
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
  const stale = staleEquivalents(all, target.equivalent);
  if (stale.length)
    throw new Error(
      `MUTATION_STALE_EQUIVALENT: ${name}/${targetName} lists ${stale.map((e) => `line ${e.line} ${e.from} -> ${e.to}`).join(', ')}, which ${target.file} no longer has; point each at the line its mutant moved to (KB-MUTATION-PINS1)`,
    );
  const inRange = lines ? all.filter((m) => m.line >= lines[0] && m.line <= lines[1]) : all;
  const chosen = pickMutants(inRange, cap, seed);
  log(`${name}/${targetName}: ${all.length} mutants, running ${chosen.length}`);
  if (listOnly) return { results: [], all: all.length };
  const testDir = testDirOf(root);
  const slots = [];
  for (let i = 0; i < jobs; i++) {
    // Same depth as the package, so tests' relative imports (../dist, ../bench, ../../../scripts) all resolve.
    const top = resolve(repository, '.mutation', name + '-' + targetName + '-' + i);
    const work = resolve(top, 'packages', name);
    await rm(top, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await cp(resolve(root, testDir), resolve(work, testDir), { recursive: true });
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
  const base = await runTests(resolve(slots[0], testDir), target.tests, { parallel: target.parallel });
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
        const run = await runTests(resolve(slot, testDir), target.tests, { parallel: target.parallel });
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
  return { results: markEquivalent(results, target.equivalent), all: all.length };
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
    const equivalent = results.filter((r) => r.status === 'equivalent').length;
    report[targetName] = {
      generated: all,
      ...s,
      equivalent,
      survivors: results.filter((r) => r.status === 'survived'),
    };
    if (!argv.includes('--list'))
      console.log(
        `${name}/${targetName}: killed ${s.killed} / ${s.total} = ${(s.score * 100).toFixed(1)} %, survivors ${s.survived}, equivalent ${equivalent}`,
      );
  }
  const out = flag('json', '');
  if (out) await writeFile(out, JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
