// Code hygiene scorecard (HANDOFF 5k, launch gate 6): `npm run hygiene` measures each 5k gate per package and overall,
// prints a table and writes test-results/hygiene.json. Needs `npm run build:packages` and current api/ reports (gates
// 3, 5 and 6 read the built dist/*.d.ts and api/*.api.md). `node scripts/hygiene.js --verify` runs only gates 1-2
// (Biome format check + lint, about 2 s, no build needed) and never fails: the gates are in warn mode until phase 2
// lands, then `--strict` makes any violation exit 1.
//
// Gates (units = what is counted; a violation is one unit failing the gate):
//   1 format   units: source files Biome covers (biome.json `files.includes`); violation: Biome would reformat it.
//   2 lint     units: the same files; violation: a file with >= 1 Biome lint warning (warning count also reported).
//   3 any      units: public API declarations (top-level blocks of api/*.api.md, exported and "not exported but used")
//              + src files; violation: a declaration whose text contains `any` (no allowlist: 5k wants 0 in public
//              APIs), or a src file with more explicit `any` (Biome noExplicitAny) than scripts/hygiene-allowlist.json
//              grants it (justified survivors only, each with its reason).
//   4 strict   units: 3 flags per package tsconfig (`strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, after
//              `extends`); violation: a flag that is off.
//   5 types    units: distinct names declared in the api reports of all packages; violation: a type/interface declared
//              in >= 2 packages (duplicate shared type, e.g. Vec3), or a name declared and exported by >= 2 packages
//              (clashing export, e.g. loadGLTF). A package is charged for each such name it declares.
//   6 tsdoc    units: exported symbols declared in the package (dist/*.d.ts through the TypeScript checker);
//              violation: no `/** */` comment on any of its declarations (a symbol two entries export counts once).
//   7 errors   units: `throw new X(` sites in src; violation: a bare `Error` (the convention is a typed error:
//              TypeError/RangeError/... or a named class; 1h.h will add shared codes, then this gate tightens).
//   8 api      not measured here: the open items of "API rough edges before 1.0" in docs/HANDOFF.md are a manual list.
//   9 dead     units: src files + their named exports; violation: a file no package entry, worker URL or build script
//              reaches, or an export nothing imports (any repo file), re-exports or makes public.
// Score per gate: max(0, 10 - 100 * violations / units): each 1% of units in violation costs one point, so 10 means
// none and 9 means at most 1%. Overall gate scores use repo-wide totals; a package's score is the mean of its gates;
// the hygiene score is the mean of the 8 measured gates. `met` is true only at 0 violations (the 5k target).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { parseSync } from 'rolldown/utils';

const root = resolve(import.meta.dirname, '..');
const quick = process.argv.includes('--verify');
const strict = process.argv.includes('--strict');
const slash = (p) => p.replaceAll('\\', '/');
const rel = (p) => slash(relative(root, p));
const texts = new Map();
const read = (p) => texts.get(p) ?? texts.set(p, readFileSync(join(root, p), 'utf8')).get(p);
const json = (p) => JSON.parse(read(p).replace(/^\s*\/\/.*$/gm, ''));
const code = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;

// Packages: every packages/<dir> with a package.json. Files outside packages/ group under their top folder.
const packages = readdirSync(join(root, 'packages'))
  .filter((dir) => existsSync(join(root, 'packages', dir, 'package.json')))
  .sort();
const groupOf = (file) => {
  const [top, dir] = file.split('/');
  return top === 'packages' ? dir : top;
};

// Gate 1 + 2 units: the files biome.json covers (its includes are "<top>/**/*.{ext}" plus "!" exclusions).
const biomeConfig = json('biome.json');
const excludes = biomeConfig.files.includes.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
const tops = new Set(biomeConfig.files.includes.filter((p) => !p.startsWith('!')).map((p) => p.split('/')[0]));
const excluded = (file) =>
  excludes.some((p) => (p.startsWith('**/') ? file.split('/').includes(p.slice(3)) : file === p));
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => code.test(f) && tops.has(f.split('/')[0]) && !excluded(f) && existsSync(join(root, f)));

const rows = new Map(); // group -> { gate -> { units, violations, ... } }
const row = (group) => {
  if (!rows.has(group)) rows.set(group, {});
  return rows.get(group);
};
const add = (group, gate, units, violations, extra) => {
  const g = (row(group)[gate] ??= { units: 0, violations: 0 });
  g.units += units;
  g.violations += violations;
  if (extra) for (const [k, v] of Object.entries(extra)) g[k] = (g[k] ?? 0) + v;
};

// --- Gates 1-2: one `biome check` run (formatter + linter).
let biome = '';
try {
  const bin = createRequire(join(root, 'package.json')).resolve('@biomejs/biome/bin/biome');
  biome = execFileSync(process.execPath, [bin, 'check', '--reporter=json', '--max-diagnostics=none'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (error) {
  biome = error.stdout ?? ''; // exit 1 when a file needs formatting; the JSON report is still complete
}
if (!biome && !quick) throw new Error('Biome did not run; npm install (devDependency @biomejs/biome)');
const diagnostics = biome ? JSON.parse(biome).diagnostics : [];
const unformatted = new Set();
const lintByFile = new Map();
const anyByFile = new Map();
for (const d of diagnostics) {
  const file = slash(d.location?.path ?? '');
  if (d.category === 'format') unformatted.add(file);
  else if (d.category?.startsWith('lint/')) {
    lintByFile.set(file, (lintByFile.get(file) ?? 0) + 1);
    if (d.category === 'lint/suspicious/noExplicitAny') anyByFile.set(file, (anyByFile.get(file) ?? 0) + 1);
  }
}
for (const file of files) {
  add(groupOf(file), 'format', 1, unformatted.has(file) ? 1 : 0);
  add(groupOf(file), 'lint', 1, lintByFile.has(file) ? 1 : 0, { warnings: lintByFile.get(file) ?? 0 });
}

let details = {};
if (!quick) {
  // --- Gate 3: `any` in public API (api reports) and internal explicit `any` (src, Biome noExplicitAny).
  const allowlist = existsSync(join(root, 'scripts/hygiene-allowlist.json'))
    ? json('scripts/hygiene-allowlist.json')
    : {};
  const reports = readdirSync(join(root, 'api')).filter((f) => f.endsWith('.api.md'));
  const reportOwner = new Map(); // report file -> package dir
  for (const dir of packages) {
    const manifest = json(`packages/${dir}/package.json`);
    for (const subpath of Object.keys(manifest.exports ?? {}))
      reportOwner.set(`${dir}${subpath === '.' ? '' : '.' + subpath.slice(2).replaceAll('/', '-')}.api.md`, dir);
  }
  const declared = new Map(); // name -> Map(package -> {type, exported})
  const counted = new Set(); // package + declaration text: a declaration several entries share counts once
  for (const report of reports) {
    const dir = reportOwner.get(report);
    if (!dir) continue;
    const body = /```ts\n([\s\S]*)\n```/.exec(read(`api/${report}`).replaceAll('\r\n', '\n'))?.[1] ?? '';
    const [exportedPart, localPart = ''] = body.split(
      '// Not exported from this entry, but used by the exports above:',
    );
    for (const [part, exported] of [
      [exportedPart, true],
      [localPart, false],
    ]) {
      for (const block of part.split(/\n\n(?=\S)/)) {
        const text = block.replace(/^\/\/.*\n/gm, '').trim();
        if (!text || text.startsWith('import ') || /^export \{[^}]*\}( from |;)/.test(text)) continue;
        if (!counted.has(dir + '\0' + text)) {
          counted.add(dir + '\0' + text);
          const anys = (text.match(/\bany\b/g) ?? []).length;
          add(dir, 'any', 1, anys ? 1 : 0, { publicAny: anys });
        }
        const m =
          /^(?:export )?(?:declare )?(?:abstract )?(class|interface|type|enum|function|const|let|var|namespace) (\w+)/.exec(
            text,
          );
        if (!m) continue;
        const [, kind, name] = m;
        if (!declared.has(name)) declared.set(name, new Map());
        const entry = declared.get(name).get(dir) ?? { type: false, exported: false };
        entry.type ||= kind === 'interface' || kind === 'type';
        entry.exported ||= exported;
        declared.get(name).set(dir, entry);
      }
    }
  }
  const srcFiles = (dir) =>
    files.filter(
      (f) =>
        f.startsWith(`packages/${dir}/src/`) ||
        (dir === 'shared' && f.startsWith('packages/shared/') && !f.endsWith('.d.ts')),
    );
  for (const dir of packages.concat('shared')) {
    for (const file of srcFiles(dir)) {
      const count = anyByFile.get(file) ?? 0;
      add(dir, 'any', 1, count > (allowlist.any?.[file]?.count ?? 0) ? 1 : 0, { internalAny: count });
    }
  }

  // --- Gate 4: strict flags per package tsconfig (following `extends`).
  const flags = ['strict', 'noImplicitOverride', 'noFallthroughCasesInSwitch'];
  const options = (file) => {
    const config = json(file);
    const base = config.extends ? options(rel(resolve(root, dirname(file), config.extends))) : {};
    return { ...base, ...config.compilerOptions };
  };
  for (const dir of packages) {
    if (!existsSync(join(root, 'packages', dir, 'tsconfig.json'))) continue;
    const on = options(`packages/${dir}/tsconfig.json`);
    const off = flags.filter((f) => on[f] !== true);
    add(dir, 'strict', flags.length, off.length);
    row(dir).strict.off = off;
  }

  // --- Gate 5: duplicate shared types and clashing export names (from the api reports).
  const duplicates = [];
  for (const [name, owners] of declared) {
    if (owners.size < 2) continue;
    const list = [...owners];
    const types = list.filter(([, e]) => e.type).length;
    const exported = list.filter(([, e]) => e.exported).length;
    if (types >= 2 || exported >= 2)
      duplicates.push({ name, kind: types >= 2 ? 'type' : 'export', packages: list.map(([p]) => p) });
  }
  const dupNames = new Set(duplicates.map((d) => d.name));
  for (const [name, owners] of declared)
    for (const dir of owners.keys()) add(dir, 'types', 1, dupNames.has(name) ? 1 : 0);

  // --- Gate 6: TSDoc on exported symbols (TypeScript checker over dist/*.d.ts, like scripts/api-report.js).
  const { API, SymbolFlags } = await import('typescript/unstable/sync');
  const { SyntaxKind } = await import('typescript/unstable/ast');
  const entries = packages.flatMap((dir) =>
    Object.values(json(`packages/${dir}/package.json`).exports ?? {}).map((target) => ({
      dir,
      dts: slash(
        join(root, 'packages', dir, typeof target === 'string' ? target.replace(/\.js$/, '.d.ts') : target.types),
      ),
    })),
  );
  const missing = entries.filter((e) => !existsSync(e.dts));
  if (missing.length) throw new Error(`${missing[0].dts} missing; run npm run build:packages first`);
  const temp = join(root, 'test-results', 'hygiene-tsconfig');
  mkdirSync(temp, { recursive: true });
  writeFileSync(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        lib: ['es2022', 'dom'],
        types: [],
        skipLibCheck: true,
        noEmit: true,
      },
      files: entries.map((e) => e.dts),
    }),
  );
  const undocumented = {};
  const api = new API({ cwd: root });
  try {
    const { checker, program } = api.updateSnapshot({ openProjects: [join(temp, 'tsconfig.json')] }).getProjects()[0];
    const seen = new Set();
    for (const { dir, dts } of entries) {
      const home = slash(join(root, 'packages', dir)).toLowerCase() + '/';
      for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(dts)))) {
        const target = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const declarations = target.declarations ?? [];
        if (!declarations.length || seen.has(target.id) || declarations[0].kind === SyntaxKind.SourceFile) continue;
        if (!slash(declarations[0].path).toLowerCase().startsWith(home)) continue; // re-exported from another package
        seen.add(target.id);
        const documented = declarations.some((d) => {
          const node = d.resolve();
          const statement = node.kind === SyntaxKind.VariableDeclaration ? node.parent.parent : node;
          return (node.jsDoc?.length ?? 0) + (statement.jsDoc?.length ?? 0) > 0;
        });
        add(dir, 'tsdoc', 1, documented ? 0 : 1);
        if (!documented) (undocumented[dir] ??= []).push(symbol.name);
      }
    }
  } finally {
    api.close();
  }

  // --- Gate 7: error convention (typed throws).
  for (const dir of packages.concat('shared')) {
    for (const file of srcFiles(dir)) {
      const throws = [...read(file).matchAll(/\bthrow new (\w+)\(/g)].map((m) => m[1]);
      add(dir, 'errors', throws.length, throws.filter((t) => t === 'Error').length);
    }
  }

  // --- Gate 9: unused files and exports (import graph over every repo source file, parsed with oxc).
  const all = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => code.test(f) && !f.endsWith('.d.ts') && !f.includes('/vendor/') && existsSync(join(root, f)));
  const known = new Set(all);
  const entryOf = new Map(); // bare specifier -> src file
  for (const dir of packages) {
    const manifest = json(`packages/${dir}/package.json`);
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const file = toSource(
        `packages/${dir}/${(typeof target === 'string' ? target : (target.import ?? target.default ?? '')).slice(2)}`,
      );
      if (file) entryOf.set(manifest.name + subpath.slice(1), file);
    }
  }
  function toSource(path) {
    const p = slash(path)
      .replace(/\?.*$/, '')
      .replace(/^(packages\/[^/]+)\/dist\//, '$1/src/');
    const stem = p.replace(/\.(js|mjs|ts|tsx)$/, '');
    return [p, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.js`].find(
      (c) => known.has(c),
    );
  }
  const resolveSpec = (from, spec) => {
    if (entryOf.has(spec)) return entryOf.get(spec);
    if (!spec.startsWith('.')) return undefined;
    return toSource(join(dirname(from), spec));
  };
  const modules = new Map(); // file -> { exports: Set, stars: [file], from: Map(name -> [file, name]), imports: [[file, name|'*']] }
  for (const file of all) {
    let result;
    try {
      result = parseSync(file, read(file));
    } catch {
      continue;
    }
    const m = { exports: new Set(), stars: [], from: new Map(), imports: [], urls: [] };
    const locals = new Map(); // local binding -> [file, imported name]
    for (const node of result.program.body) {
      const target = node.source ? resolveSpec(file, node.source.value) : undefined;
      if (node.type === 'ImportDeclaration') {
        if (!target) continue;
        if (!node.specifiers.length) m.imports.push([target, null]);
        for (const s of node.specifiers) {
          const name =
            s.type === 'ImportNamespaceSpecifier'
              ? '*'
              : s.type === 'ImportDefaultSpecifier'
                ? 'default'
                : (s.imported.name ?? s.imported.value);
          m.imports.push([target, name]);
          locals.set(s.local.name, [target, name]);
        }
      } else if (node.type === 'ExportAllDeclaration') {
        if (!target) continue;
        if (node.exported) {
          m.exports.add(node.exported.name);
          m.from.set(node.exported.name, [target, '*']);
        } else m.stars.push(target);
      } else if (node.type === 'ExportNamedDeclaration') {
        const d = node.declaration;
        if (d?.declarations) for (const v of d.declarations) for (const n of names(v.id)) m.exports.add(n);
        else if (d?.id) m.exports.add(d.id.name);
        for (const s of node.specifiers ?? []) {
          const exported = s.exported.name ?? s.exported.value;
          const local = s.local.name ?? s.local.value;
          m.exports.add(exported);
          if (target) m.from.set(exported, [target, local]);
          else if (locals.has(local)) m.from.set(exported, locals.get(local));
        }
      } else if (node.type === 'ExportDefaultDeclaration') m.exports.add('default');
    }
    for (const d of read(file).matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
      const target = resolveSpec(file, d[1]);
      if (target) m.imports.push([target, '*']);
    }
    for (const u of read(file).matchAll(/new URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url/g)) {
      const target =
        resolveSpec(file, u[1]) ??
        toSource(join(dirname(file), u[1].replace(/^\.\/workers\//, './').replace(/\.js$/, '.worker.ts')));
      if (target) m.urls.push(target);
    }
    modules.set(file, m);
  }
  function names(pattern) {
    if (!pattern) return [];
    if (pattern.type === 'Identifier') return [pattern.name];
    if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap((p) => names(p.value ?? p.argument));
    if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(names);
    if (pattern.type === 'AssignmentPattern') return names(pattern.left);
    if (pattern.type === 'RestElement') return names(pattern.argument);
    return [];
  }
  // Used exports: every import anywhere in the repo, plus everything an entry exposes, followed through re-exports.
  const used = new Map(); // file -> Set(name) ; '*' = all
  const follow = (m, name) => {
    if (m.from.has(name)) mark(...m.from.get(name));
    else if (!m.exports.has(name)) for (const s of m.stars) mark(s, name);
  };
  const mark = (file, name) => {
    const m = modules.get(file);
    if (!m) return;
    const set = used.get(file) ?? new Set();
    used.set(file, set);
    if (set.has(name) || set.has('*')) return;
    set.add(name);
    if (name !== '*') return follow(m, name);
    for (const n of m.exports) follow(m, n);
    for (const s of m.stars) mark(s, '*');
  };
  for (const entry of entryOf.values()) mark(entry, '*');
  for (const m of modules.values()) for (const [target, name] of m.imports) if (name) mark(target, name);
  // Reachable files: from the package entries, worker URLs and files the package's build/config scripts name.
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file) || !modules.has(file)) return;
    reached.add(file);
    const m = modules.get(file);
    for (const [target] of m.imports) visit(target);
    for (const target of [...m.stars, ...m.urls, ...[...m.from.values()].map(([t]) => t)]) visit(target);
  };
  for (const entry of entryOf.values()) visit(entry);
  for (const dir of packages) {
    for (const script of all.filter(
      (f) => f.startsWith(`packages/${dir}/`) && !f.includes('/src/') && !f.includes('/test'),
    ))
      for (const s of read(script).matchAll(/['"`]((?:\.\.?\/)*src\/[\w/.-]+)['"`]/g)) {
        const target = toSource(`packages/${dir}/${s[1].replace(/^(\.\.?\/)+/, '')}`);
        if (target) visit(target);
      }
    for (const file of srcFiles(dir).filter((f) => f.endsWith('.worker.ts'))) visit(file); // scripts/build-workers.js
  }
  for (const script of all.filter((f) => f.startsWith('scripts/')))
    for (const s of read(script).matchAll(/['"`](packages\/[\w-]+\/src\/[\w/.-]+)['"`]/g)) visit(toSource(s[1]));
  const dead = {};
  for (const dir of packages.concat('shared')) {
    for (const file of srcFiles(dir)) {
      const m = modules.get(file);
      if (!m) continue;
      if (!reached.has(file)) {
        add(dir, 'dead', 1 + m.exports.size, 1 + m.exports.size);
        (dead[dir] ??= []).push(file);
        continue;
      }
      const set = used.get(file) ?? new Set();
      const unused = set.has('*') ? [] : [...m.exports].filter((n) => !set.has(n));
      add(dir, 'dead', 1 + m.exports.size, unused.length);
      if (unused.length) (dead[dir] ??= []).push(`${file}: ${unused.join(', ')}`);
    }
  }
  details = { duplicates, undocumented, dead };
}

// --- Scores and output.
const gates = quick ? ['format', 'lint'] : ['format', 'lint', 'any', 'strict', 'types', 'tsdoc', 'errors', 'dead'];
const score = (g) => (g?.units ? Math.max(0, 10 - (100 * g.violations) / g.units) : null);
const totals = {};
for (const gate of gates) {
  const t = { units: 0, violations: 0 };
  for (const r of rows.values())
    if (r[gate]) for (const [k, v] of Object.entries(r[gate])) if (typeof v === 'number') t[k] = (t[k] ?? 0) + v;
  totals[gate] = { ...t, score: round(score(t)), met: t.violations === 0 };
}
const overall = round(mean(gates.map((g) => totals[g].score)));
const packageRows = [...rows]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([name, r]) => ({
    name,
    gates: Object.fromEntries(gates.filter((g) => r[g]).map((g) => [g, { ...r[g], score: round(score(r[g])) }])),
    score: round(mean(gates.map((g) => score(r[g])))),
  }));
function round(x) {
  return x === null || Number.isNaN(x) ? null : Math.round(x * 10) / 10;
}
function mean(xs) {
  const v = xs.filter((x) => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

const cell = (g) => (g?.units ? `${g.violations}/${g.units} ${round(score(g)).toFixed(1)}` : '-');
const header = ['package', ...gates, 'score'];
const lines = packageRows.map((p) => [
  p.name,
  ...gates.map((g) => cell(rows.get(p.name)[g])),
  p.score?.toFixed(1) ?? '-',
]);
lines.push(['OVERALL', ...gates.map((g) => cell(totals[g])), overall?.toFixed(1) ?? '-']);
const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
const fmt = (l) => l.map((c, i) => String(c).padEnd(widths[i])).join('  ');
if (quick) {
  const f = totals.format;
  const l = totals.lint;
  console.log(
    `hygiene (warn): format ${f.violations}/${f.units} files need formatting; lint ${l.warnings ?? 0} warnings in ${l.violations} files` +
      (f.violations ? ' (npm run format fixes them)' : ''),
  );
  if (!biome) console.warn('hygiene: Biome produced no output; run npm install (devDependency @biomejs/biome).');
} else {
  console.log('violations/units score per gate (score: 10 - 1 point per 1% of units in violation)\n');
  console.log(fmt(header));
  for (const l of lines) console.log(fmt(l));
  console.log(`\nHygiene score ${overall} / 10 (mean of gates 1-7 and 9; gate 8 is the manual HANDOFF list).`);
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(
    join(root, 'test-results', 'hygiene.json'),
    JSON.stringify({ score: overall, gates: totals, packages: packageRows, ...details }, null, 2) + '\n',
  );
  console.log('Details: test-results/hygiene.json');
}
if (strict && gates.some((g) => totals[g].violations)) process.exitCode = 1;
