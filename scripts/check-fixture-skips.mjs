// Required evidence cannot disappear behind a successful test. Runs in verify through tests/fixture-skips.test.js.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSync } from 'rolldown/utils';

const evidence = /fixture|sample|asset|validator|sharp|venv|python|\.exr\b|\.hdr\b|\.bin\b/i;
// Batch 160 owns these exact files; physics is on hold. These are ownership exclusions, not passing evidence.
export const deferredFiles = new Set([
  'packages/animation/tests/interactivity.test.js',
  'packages/gltf-pro/tests/physics.test.js',
  'packages/gltf-pro/tests/splats.test.js',
  'packages/splats/test/spz-sog.test.js',
]);

/** Finds fixture-dependent skips and successful early exits in executable syntax, ignoring comments and strings. */
export function fixtureSkips(source, file = 'test.js') {
  const { program } = parseSync(file, source);
  const problems = [];
  const initializers = new Map();
  const children = (node) =>
    Object.values(node)
      .flat()
      .filter((v) => v && typeof v === 'object' && typeof v.type === 'string');
  const walk = (node, visit) => {
    visit(node);
    for (const child of children(node)) walk(child, visit);
  };
  const text = (node) => source.slice(node.start, node.end);
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init)
      initializers.set(node.id.name, initializers.has(node.id.name) ? null : node.init);
  });
  const availability = (node, seen = new Set(), anyPath = false) => {
    if (!node) return false;
    if (
      !/^(Identifier|UnaryExpression|BinaryExpression|LogicalExpression|ConditionalExpression|CallExpression)$/.test(
        node.type,
      )
    )
      return false;
    if (node.type === 'Identifier' && !seen.has(node.name)) {
      const next = new Set(seen).add(node.name);
      return availability(initializers.get(node.name), next, anyPath);
    }
    if (node.type === 'CallExpression') {
      const name = node.callee.type === 'Identifier' ? node.callee.name : node.callee.property?.name;
      return (
        /^(existsSync|accessSync|readFileSync|readFile|fixture|full)$/.test(name) &&
        (anyPath || evidence.test(text(node)))
      );
    }
    return children(node).some((child) => availability(child, seen, anyPath));
  };
  const exits = (node) => {
    if (node.type === 'ReturnStatement' || node.type === 'ContinueStatement') return true;
    // A return inside a nested callback does not terminate this test.
    if (/Function/.test(node.type)) return false;
    return children(node).some(exits);
  };
  const add = (node, reason) =>
    problems.push(
      `${file}:${source.slice(0, node.start).split('\n').length}: ${reason}; require the file and name its fetch command`,
    );
  walk(program, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.name === 'skip'
    ) {
      const reason = node.arguments
        .map((arg) =>
          arg.type === 'Identifier' && initializers.get(arg.name) ? text(initializers.get(arg.name)) : text(arg),
        )
        .join(' ');
      if (evidence.test(reason) || /LFS|not (installed|built)|missing|not checked out/i.test(reason))
        add(node, 'missing evidence skips a test');
    }
    if (
      node.type === 'Property' &&
      (node.key.name ?? node.key.value) === 'skip' &&
      (availability(node.value, new Set(), true) ||
        (node.value.type === 'Literal' &&
          /fixture|sample|asset|LFS|not installed|not built|missing/i.test(node.value.value)))
    )
      add(node, 'missing evidence sets a skip option');
    if (node.type === 'IfStatement' && availability(node.test) && exits(node.consequent))
      add(node, 'missing evidence exits successfully');
    if (
      node.type === 'ConditionalExpression' &&
      availability(node.test) &&
      [node.consequent, node.alternate].some((branch) => branch.type === 'Literal' && branch.value === null)
    )
      add(node, 'missing evidence becomes optional data');
  });
  return problems;
}

/** Audits tracked test and proof programs, apart from the explicit held work above. */
export function checkFixtureSkips(root = resolve(import.meta.dirname, '..')) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
    .trim()
    .split('\n');
  return [...new Set(files)]
    .filter(
      (file) =>
        /\.(m?js|ts)$/.test(file) &&
        /(^tests\/|\/tests?\/|^scripts\/.*(?:test|proof)|\/proofs\/)/.test(file) &&
        !/^packages\/physics(?:2d)?\//.test(file) &&
        !deferredFiles.has(file),
    )
    .flatMap((file) => fixtureSkips(readFileSync(resolve(root, file), 'utf8'), file));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const problems = checkFixtureSkips();
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exitCode = 1;
  else console.log('Required-fixture gate passed (batch 160 and held physics listed separately).');
}
