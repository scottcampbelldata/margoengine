// Shipped code must run on the packages' oldest Node (engines >=22.12.0, V8 12.4): `npm run check:node-apis`.
// It parses every shipped source file (packages/*/src, bin and tools) and fails on a use of a JavaScript or Node API
// that Node 22.12 lacks, unless the use sits behind a feature test. A missing API does not fail at parse time (so
// check-engines' parse and import checks miss it); it throws the first time the line runs, on a user's server, in an
// SSR render or a CLI. Browser code is held to the same rule: Float16Array, for one, is missing from older Safari
// and Firefox releases that still have users.
//
// A use counts as feature tested when it is
//   - read through globalThis (`globalThis.Float16Array`), which yields undefined instead of throwing;
//   - an optional call (`Promise.try?.(...)`, `bytes.toHex?.()`);
//   - the operand of `typeof`;
//   - inside a branch (if, ?:, &&, ||, ??) whose test names the API.
// Add a row to API when shipped code may come to use another API newer than the oldest supported Node.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/**
 * The APIs Node 22.12 does not have. `kind` says how a use is found:
 *   global  an identifier reference (ReferenceError on Node 22.12)
 *   static  a call or `new` of Object.member (TypeError: not a function)
 *   method  a call of .member() on any value (TypeError: not a function)
 *   node    a call of .member() or a named import of it from a node: module (missing export)
 *   syntax  a regular expression literal Node 22.12 cannot parse
 * `has` is the oldest of the tested runtimes (22.12.0, 22.22.1, 24.18.0, 26.12.0) that has it, measured 2026-10-27;
 * `probe` returns true when this runtime has it (tests/node-apis.test.js asserts every probe is false on 22.12).
 */
const zlib = await import('node:zlib'),
  nodeModule = await import('node:module'),
  fs = await import('node:fs');
const has = (value) => value !== undefined;
export const API = [
  { name: 'Float16Array', kind: 'global', has: '24.18', probe: () => has(globalThis.Float16Array) },
  { name: 'SuppressedError', kind: 'global', has: '24.18', probe: () => has(globalThis.SuppressedError) },
  { name: 'DisposableStack', kind: 'global', has: '24.18', probe: () => has(globalThis.DisposableStack) },
  { name: 'AsyncDisposableStack', kind: 'global', has: '24.18', probe: () => has(globalThis.AsyncDisposableStack) },
  { name: 'URLPattern', kind: 'global', has: '24.18', probe: () => has(globalThis.URLPattern) },
  { name: 'Math.f16round', kind: 'static', has: '24.18', probe: () => has(Math.f16round) },
  { name: 'Promise.try', kind: 'static', has: '24.18', probe: () => has(Promise.try) },
  { name: 'RegExp.escape', kind: 'static', has: '24.18', probe: () => has(RegExp.escape) },
  { name: 'Uint8Array.fromBase64', kind: 'static', has: '26.12', probe: () => has(Uint8Array.fromBase64) },
  { name: 'Uint8Array.fromHex', kind: 'static', has: '26.12', probe: () => has(Uint8Array.fromHex) },
  { name: 'Error.isError', kind: 'static', has: '24.18', probe: () => has(Error.isError) },
  { name: 'Iterator.concat', kind: 'static', has: '26.12', probe: () => has(globalThis.Iterator?.concat) },
  { name: 'Math.sumPrecise', kind: 'static', has: 'none of them', probe: () => has(Math.sumPrecise) },
  { name: 'Intl.DurationFormat', kind: 'static', has: '24.18', probe: () => has(Intl.DurationFormat) },
  { name: 'Atomics.pause', kind: 'static', has: '24.18', probe: () => has(Atomics.pause) },
  { name: 'toBase64', kind: 'method', has: '26.12', probe: () => has(Uint8Array.prototype.toBase64) },
  { name: 'toHex', kind: 'method', has: '26.12', probe: () => has(Uint8Array.prototype.toHex) },
  { name: 'setFromBase64', kind: 'method', has: '26.12', probe: () => has(Uint8Array.prototype.setFromBase64) },
  { name: 'setFromHex', kind: 'method', has: '26.12', probe: () => has(Uint8Array.prototype.setFromHex) },
  { name: 'getFloat16', kind: 'method', has: '24.18', probe: () => has(DataView.prototype.getFloat16) },
  { name: 'setFloat16', kind: 'method', has: '24.18', probe: () => has(DataView.prototype.setFloat16) },
  { name: 'getOrInsert', kind: 'method', has: '26.12', probe: () => has(Map.prototype.getOrInsert) },
  { name: 'getOrInsertComputed', kind: 'method', has: '26.12', probe: () => has(Map.prototype.getOrInsertComputed) },
  { name: 'zstdCompress', kind: 'node', has: '22.22', probe: () => has(zlib.zstdCompress) },
  { name: 'zstdCompressSync', kind: 'node', has: '22.22', probe: () => has(zlib.zstdCompressSync) },
  { name: 'zstdDecompress', kind: 'node', has: '22.22', probe: () => has(zlib.zstdDecompress) },
  { name: 'zstdDecompressSync', kind: 'node', has: '22.22', probe: () => has(zlib.zstdDecompressSync) },
  { name: 'createZstdCompress', kind: 'node', has: '22.22', probe: () => has(zlib.createZstdCompress) },
  { name: 'createZstdDecompress', kind: 'node', has: '22.22', probe: () => has(zlib.createZstdDecompress) },
  { name: 'registerHooks', kind: 'node', has: '22.22', probe: () => has(nodeModule.registerHooks) },
  { name: 'mkdtempDisposable', kind: 'node', has: '24.18', probe: () => has(fs.promises.mkdtempDisposable) },
  { name: 'mkdtempDisposableSync', kind: 'node', has: '24.18', probe: () => has(fs.mkdtempDisposableSync) },
  // `using` declarations are fine in src: the package build (target es2022) lowers them to try/finally with a helper
  // that falls back where SuppressedError is missing, and check-engines' syntax table fails a dist file that keeps one.
  // Regular expression syntax is not lowered by the build, so it is checked here.
  {
    name: 'regular expression modifiers (?i:...)',
    kind: 'syntax',
    has: '24.18',
    probe: () => {
      try {
        return new RegExp('(?i:a)').test('A');
      } catch {
        return false;
      }
    },
  },
].map((row) => ({ ...row, needs: row.has === 'none of them' ? 'a newer Node than 26.12' : `Node ${row.has}` }));
/** Keys and node types that hold TypeScript types only; nothing under them runs. */
const TYPE_KEYS = new Set([
  'typeAnnotation',
  'typeParameters',
  'typeArguments',
  'returnType',
  'superTypeArguments',
  'implements',
]);
const TYPE_NODES = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction']);

const byKind = (kind) => new Map(API.filter((row) => row.kind === kind).map((row) => [row.name, row]));
const GLOBALS = byKind('global'),
  STATICS = byKind('static'),
  METHODS = new Map([...byKind('method'), ...byKind('node')]),
  NODE = byKind('node');
const MODIFIERS = /\(\?[imsx]*-?[imsx]+:/;

/**
 * The shipped source files (.ts, .tsx, .js, .mjs, .cjs; no declaration files): packages/<name>/{src,bin,tools} and the
 * published command line tools/<name> (margo-convert, create-margo and its templates) without their tests.
 */
export function shippedFiles(base = root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'test' || name === 'tests') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:tsx?|m?js|cjs)$/.test(name) && !/\.d\.[mc]?ts$/.test(name)) out.push(path);
    }
  };
  for (const pkg of readdirSync(join(base, 'packages')))
    for (const sub of ['src', 'bin', 'tools']) {
      const dir = join(base, 'packages', pkg, sub);
      if (existsSync(dir)) walk(dir);
    }
  for (const tool of existsSync(join(base, 'tools')) ? readdirSync(join(base, 'tools')) : []) {
    const manifest = join(base, 'tools', tool, 'package.json');
    if (existsSync(manifest) && !JSON.parse(readFileSync(manifest, 'utf8')).private) walk(join(base, 'tools', tool));
  }
  return out;
}

const memberName = (node) =>
  node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    ? node.property.name
    : undefined;
const staticName = (node) =>
  node?.type === 'MemberExpression' && node.object.type === 'Identifier'
    ? `${node.object.name}.${memberName(node)}`
    : '';
/** Node keys that hold a name, not a reference. */
const isKey = (parent, key) =>
  (key === 'property' && parent.type === 'MemberExpression' && !parent.computed) ||
  (key === 'key' && !parent.computed) ||
  key === 'label' ||
  (parent.type === 'ImportSpecifier' && key === 'imported') ||
  (parent.type === 'ExportSpecifier' && key === 'exported');

/** Unguarded uses of API in `source` (TypeScript or JavaScript) as { name, needs, line }. */
export async function scan(source, filename = 'file.ts') {
  const { parseAst } = await import('rolldown/parseAst');
  const lang = /\.tsx$/.test(filename) ? 'tsx' : /\.ts$/.test(filename) ? 'ts' : 'js';
  const ast = parseAst(source, { lang, sourceType: 'module' }, filename);
  const found = [];
  const lineOf = (offset) => source.slice(0, offset).split('\n').length;
  // `guards` holds the source text of every branch test on the way down.
  const report = (row, node, guards) => {
    const word = row.name.split('.').at(-1);
    if (guards.some((text) => text.includes(word))) return;
    found.push({ name: row.name, needs: row.needs, line: lineOf(node.start) });
  };
  const visit = (node, parent, key, guards) => {
    if (!node || typeof node.type !== 'string') return;
    // Types are erased: nothing in a type annotation, interface, type alias, `declare` or `import type` runs.
    if (TYPE_KEYS.has(key) || TYPE_NODES.has(node.type) || node.declare || node.importKind === 'type') return;
    if (node.type === 'UnaryExpression' && node.operator === 'typeof') return;
    if (node.type === 'Identifier' && GLOBALS.has(node.name) && !isKey(parent, key))
      report(GLOBALS.get(node.name), node, guards);
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && !node.optional) {
      const callee = node.callee;
      if (callee.type === 'MemberExpression' && !callee.optional) {
        const row = STATICS.get(staticName(callee)) ?? METHODS.get(memberName(callee));
        if (row) report(row, node, guards);
      }
    }
    if (node.type === 'ImportDeclaration' && /^node:|^(?:zlib|module|fs)$/.test(node.source.value))
      for (const spec of node.specifiers)
        if (spec.type === 'ImportSpecifier' && NODE.has(spec.imported.name))
          report(NODE.get(spec.imported.name), spec, guards);
    if (node.type === 'Literal' && node.regex && MODIFIERS.test(node.regex.pattern))
      report(
        API.find((row) => row.name.startsWith('regular expression modifiers')),
        node,
        guards,
      );
    // A branch whose test names an API guards what runs only when the test passed (or failed: `x ?? fallback`).
    const test =
      node.type === 'IfStatement' || node.type === 'ConditionalExpression'
        ? node.test
        : node.type === 'LogicalExpression'
          ? node.left
          : undefined;
    for (const child of Object.keys(node)) {
      if (child === 'type' || child === 'start' || child === 'end') continue;
      const value = node[child];
      const inner = test && value !== test ? [...guards, source.slice(test.start, test.end)] : guards;
      if (Array.isArray(value)) for (const item of value) visit(item, node, child, inner);
      else if (value && typeof value === 'object') visit(value, node, child, inner);
    }
  };
  visit(ast, { type: 'Program' }, 'program', []);
  return found;
}

/** Every unguarded use in the shipped sources, as "file:line uses name (needs ...)". */
export async function check(base = root) {
  const problems = [];
  for (const file of shippedFiles(base))
    for (const { name, needs, line } of await scan(readFileSync(file, 'utf8'), file))
      problems.push(`${relative(base, file).replaceAll('\\', '/')}:${line} uses ${name}, which needs ${needs}`);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = await check();
  for (const problem of problems) console.error(`check-node-apis: ${problem}`);
  console.log(
    problems.length
      ? `check-node-apis: ${problems.length} use(s) of APIs Node 22.12 lacks without a feature test; guard each one (see the header of scripts/check-node-apis.mjs)`
      : `check-node-apis: ok (${shippedFiles().length} shipped source files, ${API.length} APIs newer than Node 22.12)`,
  );
  process.exitCode = problems.length ? 1 : 0;
}
