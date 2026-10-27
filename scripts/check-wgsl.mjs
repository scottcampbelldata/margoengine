// WGSL compile gate (`npm run check:wgsl`, part of check:merge; real GPU, takes the GPU lock): compiles, on the
// browser's WebGPU, every WGSL source the packages hold, including the ones no view or test draws. Each package source
// file (packages/*/src, packages/shared) is parsed; its top-level constants whose text has an entry point (@vertex,
// @fragment, @compute) and its top-level functions whose body does are exposed to the page by a dev-server transform.
// Constants are compiled as they are; functions are called with every combination of their flag parameters (booleans
// both ways, string or number literal unions each value, plain numbers 1 and 4, defaults as declared), so feature
// flags are covered on and off; functions taking other arguments (source text to rewrite, option objects) are
// skipped and counted, those shaders are compiled when the visual check, check:views and the package tests create
// them (scripts/support/wgsl-guard.js checks every module any browser check creates).
// A source that fails with only unresolved names, or stops at its very end mid-declaration (a function head without
// its body), is a fragment meant to be joined to others (counted, not failed); any other error (syntax, types, a parse
// error inside the text) fails the gate with the file, the export and the source line. Its modules are labelled
// `check-wgsl:` so the page's own guard (scripts/support/wgsl-guard.js) leaves the fragments to this classification.
//   node scripts/gpu-lock.mjs run --owner=<you> -- npm run check:wgsl
// --packages=dof,post limits it to those package directories (check:merge passes the affected ones; shared WGSL is
// compiled only by the full run).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const root = resolve(import.meta.dirname, '..'),
  ENTRY = /@(vertex|fragment|compute)\b/,
  MAX_CALLS = 32;

// Source files that hold an entry point, skipping worker entries (they run on import).
function sources() {
  const out = [],
    walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts') && !/worker/i.test(name)) out.push(p);
      }
    };
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, pkg === 'shared' ? '' : 'src');
    if (statSync(join(root, 'packages', pkg)).isDirectory() && statSync(src, { throwIfNoEntry: false })) walk(src);
  }
  return out.filter((p) => ENTRY.test(readFileSync(p, 'utf8')) && !p.includes(`${join('shared', 'node_modules')}`));
}

// Argument lists to call a function with, from its parameters: undefined when one cannot be made up.
function argumentSets(params, text) {
  const values = params.map((p) => {
    const annotated = p.type === 'AssignmentPattern' ? p.left : p,
      t = annotated.typeAnnotation?.typeAnnotation;
    if (t?.type === 'TSBooleanKeyword') return [false, true];
    if (t?.type === 'TSNumberKeyword') return [1, 4];
    if (t?.type === 'TSUnionType' && t.types.every((u) => u.type === 'TSLiteralType'))
      return t.types.map((u) => JSON.parse(text.slice(u.literal.start, u.literal.end).replace(/^'|'$/g, '"')));
    if (p.type === 'AssignmentPattern') return [undefined];
    return undefined;
  });
  if (values.some((v) => v === undefined)) return undefined;
  let sets = [[]];
  for (const v of values) sets = sets.flatMap((s) => v.map((x) => [...s, x]));
  return sets.length <= MAX_CALLS ? sets : sets.slice(0, MAX_CALLS);
}

// What the transform appends to a module: its WGSL constants and functions, with the calls to make.
function probe(code, id) {
  const ast = parseAst(code, { lang: id.endsWith('.ts') ? 'ts' : 'js' }),
    text = (n) => code.slice(n.start, n.end),
    items = [];
  const fn = (name, node) => {
    const sets = argumentSets(node.params, code);
    items.push(
      sets
        ? `[${JSON.stringify(name)}, (...a) => ${name}(...a), ${JSON.stringify(sets)}]`
        : `[${JSON.stringify(name)}, null, null]`,
    );
  };
  for (let st of ast.body) {
    if ((st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration') && st.declaration)
      st = st.declaration;
    if (st.type === 'VariableDeclaration')
      for (const d of st.declarations) {
        if (d.id.type !== 'Identifier' || !d.init || !ENTRY.test(text(d.init))) continue;
        if (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') fn(d.id.name, d.init);
        else items.push(`[${JSON.stringify(d.id.name)}, () => ${d.id.name}]`);
      }
    else if (st.type === 'FunctionDeclaration' && st.id && ENTRY.test(text(st))) fn(st.id.name, st);
  }
  return `\nexport const __margoWgslProbe = [${items.join(',')}];\n`;
}

const only = process.argv
    .find((a) => a.startsWith('--packages='))
    ?.slice(11)
    .split(',')
    .filter(Boolean),
  files = sources().filter((f) => !only || only.some((dir) => f.startsWith(join(root, 'packages', dir) + sep))),
  wanted = new Set(files.map((f) => resolve(f).replaceAll('\\', '/'))),
  plugin = {
    name: 'margo-wgsl-probe',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replaceAll('\\', '/');
      return wanted.has(file) ? { code: code + probe(code, file), map: null } : undefined;
    },
  };

if (only && !files.length) {
  console.log(`check:wgsl: no WGSL entry points in ${only.join(', ')}; nothing to compile`);
  process.exit(0);
}
const release = await acquire({ owner: 'check-wgsl' }),
  started = performance.now();
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/wgsl-check.html', port: 5317, plugins: [plugin] });
  const paths = files.map((f) => `/${relative(root, f).replaceAll('\\', '/')}`),
    report = await browser.page.evaluate(async (list) => {
      if (!navigator.gpu)
        throw new Error(
          'navigator.gpu is missing in this browser; try MARGO_BROWSER=chrome, or MARGO_SOFTWARE_GPU=1 on a machine without a GPU',
        );
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
        device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] }),
        seen = new Map(),
        out = { files: list.length, constants: 0, variants: 0, skipped: [], threw: [], fragments: 0, errors: [] },
        UNRESOLVED = /unresolved (value|type|call target|function|identifier|attribute)|undeclared/i;
      const compile = async (code, where) => {
        if (typeof code !== 'string' || !/@(vertex|fragment|compute)\b/.test(code)) return;
        if (seen.has(code)) return;
        seen.set(code, where);
        const info = await device.createShaderModule({ code, label: `check-wgsl:${where}` }).getCompilationInfo(),
          errors = info.messages.filter((m) => m.type === 'error'),
          end = code.trimEnd().length;
        if (!errors.length) return;
        if (errors.every((m) => UNRESOLVED.test(m.message) || m.offset >= end)) {
          out.fragments++;
          return;
        }
        const lines = code.split('\n');
        for (const m of errors)
          out.errors.push(
            `${where} ${m.lineNum}:${m.linePos} ${m.message} | ${(lines[m.lineNum - 1] ?? '').trim().slice(0, 160)}`,
          );
      };
      for (const path of list) {
        let module;
        try {
          module = await import(path);
        } catch (error) {
          out.errors.push(`${path}: import failed: ${String(error.message ?? error).split('\n')[0]}`);
          continue;
        }
        for (const [name, get, sets] of module.__margoWgslProbe ?? []) {
          const where = `${path} ${name}`;
          if (!get) {
            out.skipped.push(where);
            continue;
          }
          if (!sets) {
            out.constants++;
            await compile(get(), where);
            continue;
          }
          for (const args of sets) {
            let code;
            try {
              code = get(...args.map((a) => (a === null ? undefined : a)));
            } catch (error) {
              out.threw.push(`${where}(${args.join(', ')}): ${String(error.message ?? error).split('\n')[0]}`);
              continue;
            }
            out.variants++;
            await compile(code, `${where}(${args.join(', ')})`);
          }
        }
      }
      out.modules = seen.size;
      device.destroy();
      return out;
    }, paths);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `check:wgsl: ${report.files} files, ${report.constants} constants and ${report.variants} builder variants: ${report.modules} distinct sources compiled (${report.fragments} fragments joined elsewhere), ${report.skipped.length} builders skipped (arguments not flags), ${report.threw.length} calls threw, in ${seconds} s`,
  );
  for (const t of report.threw) console.log(`  threw: ${t}`);
  if (process.argv.includes('--verbose')) for (const s of report.skipped) console.log(`  skipped: ${s}`);
  if (report.errors.length) {
    for (const e of report.errors) console.error(`  WGSL error: ${e}`);
    throw new Error(`check:wgsl: ${report.errors.length} WGSL errors`);
  }
} finally {
  await browser?.close();
  release();
}
