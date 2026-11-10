// Public API snapshots. For every `exports` entry of every workspace package, list each exported name with
// its declaration from the emitted dist/*.d.ts (comments and private class members dropped), plus the package-local
// types those declarations reference but the entry does not export. One report per entry in api/, like API Extractor's
// .api.md. `npm run api:check` (default) fails with a diff when a report changed; `npm run api:update` rewrites them and
// docs/api-surface.md. `--package=<name>` and optional `--entry=<subpath>` limit checking and updates to one package
// or entry; the program still loads every package's declarations, because another package's `declare module` changes
// this package's symbols, so a scoped report is the same text the full run writes. Needs `npm run build:packages` (packages whose dist no longer matches their sources are rebuilt first). Uses TypeScript 7's checker through its
// `typescript/unstable/async` API (no extra dependency); that API is marked unstable, so a TypeScript bump may need edits.
// Not the sync API: on Windows its client gives a new tsgo a fixed ~5 s to open a named pipe and throws "SyncRpcChannel:
// timed out connecting to named pipe" on a loaded machine; the async client talks over stdio and waits for the process
// (tests/typescript-api-transport.test.js).
import { API, SymbolFlags } from 'typescript/unstable/async';
import { SyntaxKind } from 'typescript/unstable/ast';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isUmbrellaAlias } from './umbrella.mjs';
import {
  ENTRY_SIZES,
  gzipCell,
  mergeScopedApiSurface,
  packageMatchesApiReportScope,
  parseApiReportArguments,
  refreshSurfaceGzip,
} from './api-report-scope.mjs';
import { createGlobalReports } from './api-report-globals.mjs';
import { stalePackages } from './package-stamps.mjs';
import { execFileSync } from 'node:child_process';

// The canonical path: the checker reports files by their real long path, so a checkout reached through a Windows 8.3
// name (C:\Users\\..., what os.tmpdir() gives) matched no package and every cross-package import line
// vanished from the reports (found by the fresh-clone check).
const root = realpathSync.native(resolve(import.meta.dirname, '..'));
const { update, packageSelector, entrySelector } = parseApiReportArguments(process.argv.slice(2));
const apiDir = join(root, 'api');
const slash = (p) => p.replaceAll('\\', '/');
const key = (p) => slash(p).toLowerCase(); // the checker reports lower-cased paths on Windows
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Every package's declarations load below, scoped or not. After a rebase the dist of a package changed upstream still
// holds its old build: a new entry had no .d.ts and a changed one its old declarations, so the report failed on packages
// nobody touched until build:packages ran again. Rebuild just the packages whose dist does not match their sources
// (scripts/package-stamps.mjs); a current build is left alone.
const stale = stalePackages(root);
if (stale.length) {
  console.error(`API report: rebuilding ${stale.length} package(s) whose dist does not match their sources: ${stale.join(', ')}`);
  execFileSync(process.execPath, ['scripts/build-modern.js', '--precompiled', `--only=${stale.join(',')}`], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

// Packages and their entries, in directory order.
const packages = [];
for (const dir of readdirSync(join(root, 'packages')).sort(byText)) {
  const file = join(root, 'packages', dir, 'package.json');
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  // margoengine/<x> aliases re-export @margoengine/<x>, which has its own report (scripts/umbrella.mjs).
  const entries = Object.entries(manifest.exports ?? {})
    .filter(([subpath]) => !isUmbrellaAlias(manifest.name, subpath))
    .map(([subpath, target]) => {
      const types = typeof target === 'string' ? target.replace(/\.js$/, '.d.ts') : target.types;
      const dts = join(root, 'packages', dir, types);
      if (!existsSync(dts))
        throw new Error(`${manifest.name} "${subpath}": ${types} missing; run npm run build:packages`);
      const suffix = subpath === '.' ? '' : '.' + subpath.slice(2).replaceAll('/', '-');
      return {
        subpath,
        specifier: manifest.name + subpath.slice(1),
        dts: slash(dts),
        report: `${dir}${suffix}.api.md`,
      };
    });
  if (entries.length)
    packages.push({ dir, name: manifest.name, home: key(join(root, 'packages', dir)) + '/', entries });
}
const scopedPackage = packageSelector
  ? packages.find((pkg) => packageMatchesApiReportScope(packageSelector, pkg.dir, pkg.name))
  : undefined;
if (packageSelector && !scopedPackage)
  throw new RangeError(
    `Unknown API report package ${packageSelector}; use a packages/<dir> name or its full package name`,
  );
if (entrySelector && !scopedPackage.entries.some((entry) => entry.subpath === entrySelector))
  throw new RangeError(`Package ${scopedPackage.name} has no exports entry ${entrySelector}`);
const reportPackages = scopedPackage ? [scopedPackage] : packages;
const shared = key(join(root, 'packages', 'shared')) + '/'; // copied into each bundle, so it counts as package-local
// The package a declaration file belongs to; undefined for TypeScript's own lib files.
const ownerOf = (path) => {
  const p = key(path);
  for (const pkg of packages) if (p.startsWith(pkg.home)) return pkg.name;
  const nm = p.lastIndexOf('/node_modules/');
  if (nm < 0) return undefined;
  const [a, b] = p.slice(nm + 14).split('/');
  const name = a === '@types' ? b.replace(/^(.+)__/, '@$1/') : a.startsWith('@') ? `${a}/${b}` : a;
  return name === 'typescript' || a === '@typescript' ? undefined : name;
};

// One program over every entry, scoped or not: a scoped program without the other packages missed their `declare module`
// merges, so `--package=core` dropped a class from api/core.extension.api.md that the full run keeps.
const temp = mkdtempSync(join(tmpdir(), 'margo-api-'));
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
    files: packages.flatMap((pkg) => pkg.entries.map((entry) => entry.dts)),
  }),
);
const api = new API({ cwd: root });
// Entry .d.ts (checker path key) -> its specifier, for namespace imports of a whole entry.
const entryOf = new Map(packages.flatMap((pkg) => pkg.entries.map((entry) => [key(entry.dts), entry.specifier])));
const exportedBy = new Map(); // symbol id -> first entry of the declaring package that exports it (for import lines)
let reports;
try {
  const project = (await api.updateSnapshot({ openProjects: [join(temp, 'tsconfig.json')] })).getProjects()[0];
  const { checker, program } = project;
  const globalReport = createGlobalReports(program, {
    key,
    compare: byText,
    render: (statement) =>
      statement.kind === SyntaxKind.ModuleDeclaration && /^declare\s+global\b/.test(statement.getText())
        ? 'declare ' + clean(statement)
        : undefined,
  });
  for (const pkg of packages)
    for (const entry of pkg.entries) {
      const source = await program.getSourceFile(entry.dts);
      if (!source) continue;
      const module = await checker.getSymbolAtLocation(source);
      if (!module) continue;
      for (const symbol of await checker.getExportsOfModule(module)) {
        const target = symbol.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(symbol) : symbol;
        const path = target.declarations?.[0]?.path;
        if (path && key(path).startsWith(pkg.home) && !exportedBy.has(target.id))
          exportedBy.set(target.id, entry.specifier);
      }
    }
  reports = [];
  for (const pkg of reportPackages) {
    const rows = [];
    const globals = await globalReport(pkg.home);
    for (const entry of pkg.entries) rows.push({ pkg, entry, ...(await report(project, pkg, entry, globals)) });
    reports.push(rows);
  }
} finally {
  await api.close();
  rmSync(temp, { recursive: true, force: true });
}

async function report({ program, checker }, pkg, entry, globals) {
  const local = (path) => {
    const p = key(path);
    return p.startsWith(pkg.home) || p.startsWith(shared);
  };
  const resolveAlias = async (symbol) =>
    symbol.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(symbol) : symbol;
  const queue = []; // local declarations whose type references still need a look
  const exported = new Set();
  const imports = new Set();
  const namespaces = new Set(); // "spec\0localName" of namespace imports (`import * as localName from spec`)
  const counts = { exports: 0, any: 0, unexported: 0 };

  // One request at a time, in export order: rendering pushes onto `queue` and reads `exported`, so the text is stable.
  const renderModule = async (moduleSymbol, indent) => {
    const exports = [...(await checker.getExportsOfModule(moduleSymbol))].sort((a, b) => byText(a.name, b.name));
    for (const symbol of exports) exported.add((await resolveAlias(symbol)).id);
    const texts = [];
    for (const symbol of exports) texts.push(await renderExport(symbol, indent));
    return texts.join('\n\n');
  };
  const renderExport = async (symbol, indent) => {
    const target = await resolveAlias(symbol);
    // Another package's `declare module` merges into this symbol: that is its API, not this entry's.
    const merged = target.declarations ?? [],
      own = merged.filter((declaration) => local(declaration.path)),
      declarations = own.length ? own : merged;
    if (!declarations.length) return `${indent}export { ${symbol.name} }; // unresolved`;
    if (declarations[0].kind === SyntaxKind.SourceFile)
      return `${indent}export namespace ${symbol.name} {\n${await renderModule(target, indent + '    ')}\n${indent}}`;
    const rename = target.name === symbol.name ? '' : `${target.name} as `;
    if (!local(declarations[0].path))
      return `${indent}export { ${rename}${symbol.name} } from "${ownerOf(declarations[0].path)}";`;
    queue.push(...declarations);
    const texts = (await renderDeclarations(declarations)).map(
      (text) => indent + (rename ? '' : 'export ') + text.replaceAll('\n', '\n' + indent),
    );
    return (rename ? `${indent}export { ${rename}${symbol.name} };\n` : '') + texts.join('\n');
  };

  const entrySymbol = await checker.getSymbolAtLocation(await program.getSourceFile(entry.dts));
  counts.exports = (await checker.getExportsOfModule(entrySymbol)).length;
  let body = await renderModule(entrySymbol, '');

  // Package-local types that exported declarations mention but this entry does not export (API Extractor's
  // "forgotten exports"): their shape is part of this entry's API, so they are snapshotted too.
  const seen = new Map(); // symbol id -> unexported item (null when not package-local)
  const unexported = [];
  while (queue.length) {
    const declaration = queue.pop();
    const references = [];
    const visit = (node) => {
      let name;
      if (node.kind === SyntaxKind.TypeReference) name = node.typeName;
      else if (node.kind === SyntaxKind.ExpressionWithTypeArguments) name = node.expression;
      else if (node.kind === SyntaxKind.TypeQuery) name = node.exprName;
      while (name && (name.kind === SyntaxKind.QualifiedName || name.kind === SyntaxKind.PropertyAccessExpression))
        name = name.left ?? name.expression;
      if (name && name.getText() !== 'this') references.push(name);
      node.forEachChild(visit);
    };
    visit(await declaration.resolve());
    if (!references.length) continue;
    const symbols = await checker.getSymbolAtLocation(references);
    for (const [index, found] of symbols.entries()) {
      if (!found) continue;
      const symbol = await resolveAlias(found);
      if (exported.has(symbol.id) || symbol.flags & SymbolFlags.TypeParameter) continue;
      if (seen.has(symbol.id)) {
        seen.get(symbol.id)?.used.add(references[index].getText());
        continue;
      }
      seen.set(symbol.id, null);
      const all = symbol.declarations ?? [];
      // `import type * as Name from 'other-package'` resolves to that module, whose symbol name is its file path: report
      // it as the namespace import it is, never as a named import of that (machine-specific) path.
      if (all[0]?.kind === SyntaxKind.SourceFile && !local(all[0].path)) {
        const spec = entryOf.get(key(all[0].path)) ?? ownerOf(all[0].path);
        if (spec) namespaces.add(`${spec}\0${references[index].getText()}`);
        continue;
      }
      const owner = all.length && !local(all[0].path) ? ownerOf(all[0].path) : undefined;
      const workspace = packages.some((p) => p.name === owner);
      if (owner)
        imports.add(`${exportedBy.get(symbol.id) ?? (workspace ? owner + '#internal' : owner)}\0${symbol.name}`);
      const declarations = [];
      for (const d of all) if (local(d.path) && topLevel(await d.resolve())) declarations.push(d);
      if (!declarations.length) continue;
      const item = {
        name: symbol.name,
        path: key(declarations[0].path),
        used: new Set([references[index].getText()]),
        text: (await renderDeclarations(declarations)).join('\n'),
      };
      // A `declare module` in another package gives the same declaration a second, merged symbol.
      const twin = unexported.find((other) => other.path === item.path && other.text === item.text);
      if (twin) {
        twin.used.add(references[index].getText());
        seen.set(symbol.id, twin);
        continue;
      }
      seen.set(symbol.id, item);
      unexported.push(item);
      queue.push(...declarations);
    }
  }
  unexported.sort((a, b) => byText(a.name, b.name) || byText(a.path, b.path));
  counts.unexported = unexported.length;
  const note = ({ name, used }) => {
    const aliases = [...used].filter((u) => u !== name).sort(byText);
    return aliases.length ? `// used as ${aliases.join(', ')}\n` : '';
  };
  if (unexported.length)
    body +=
      '\n\n// Not exported from this entry, but used by the exports above:\n\n' +
      unexported.map((u) => note(u) + u.text).join('\n\n');

  // Types from other packages that the declarations above use.
  const from = new Map();
  for (const item of [...imports].sort(byText)) {
    const [owner, name] = item.split('\0');
    from.set(owner, [...(from.get(owner) ?? []), name]);
  }
  const importLine = ([spec, names]) =>
    spec.endsWith('#internal')
      ? `import { ${names.join(', ')} } from "${spec.slice(0, -9)}"; // not exported by any entry of that package`
      : `import { ${names.join(', ')} } from "${spec}";`;
  const lines = [...from].map(importLine);
  for (const item of [...namespaces].sort(byText)) {
    const [spec, name] = item.split('\0');
    lines.push(`import * as ${name} from "${spec}";`);
  }
  if (lines.length) body = lines.join('\n') + '\n\n' + body;

  // Global augmentations in the package's loaded declaration files (they apply whenever the package's types load).
  if (globals) body += '\n\n' + globals;

  counts.any = (body.match(/\bany\b/g) ?? []).length;
  const text = `## API Report File for "${entry.specifier}"\n\n> Do not edit this file. It is a report generated by \`npm run api:update\`.\n\n\`\`\`ts\n${body}\n\`\`\`\n`;
  return { text, counts };
}

function topLevel(node) {
  const statement = node.kind === SyntaxKind.VariableDeclaration ? node.parent.parent : node;
  return statement.parent?.kind === SyntaxKind.SourceFile;
}

// All declarations of one symbol (overloads, merged interfaces, class + namespace), in source order.
async function renderDeclarations(handles) {
  const nodes = (await Promise.all(handles.map((h) => h.resolve()))).filter(Boolean);
  nodes.sort((a, b) => byText(key(a.getSourceFile().fileName), key(b.getSourceFile().fileName)) || a.pos - b.pos);
  return [
    ...new Set(
      nodes.map((node) => {
        if (node.kind !== SyntaxKind.VariableDeclaration) return clean(node);
        const statement = node.parent.parent;
        if (node.parent.declarations.length === 1) return clean(statement);
        return (
          statement.getText().match(/^(?:export\s+)?(?:declare\s+)?(const|let|var)\b/)[1] + ' ' + clean(node) + ';'
        );
      }),
    ),
  ];
}

// Declaration text without comments, private members, blank lines, export/declare keywords or nesting indentation.
function clean(node) {
  const source = node.getSourceFile().text;
  const start = node.getStart();
  const column = start - source.lastIndexOf('\n', start - 1) - 1;
  return stripComments(source.slice(start, node.end).replaceAll('\r\n', '\n'))
    .split('\n')
    .map((line, i) => (i && line.startsWith(' '.repeat(column)) ? line.slice(column) : line).trimEnd())
    .filter((line) => line.trim() && !/^\s*(?:private\b[^:(]*|#private);$/.test(line))
    .join('\n')
    .replace(/, ([}\]])/g, ' $1') // tsc copies a source trailing comma in binding patterns: `{ a, b, }`
    .replace(/^(?:(?:export|default|declare)\s+)+/, '');
}

function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      if (/(?:^|\n)[ \t]*$/.test(out)) while (text[i + 1] === ' ') i++; // `/** doc */ name` at a line start
    } else out += c;
  }
  return out;
}

// Write or compare.
const selectedReports = reports.flat().filter((item) => !entrySelector || item.entry.subpath === entrySelector);
const expected = new Map(selectedReports.map((item) => [item.entry.report, item.text]));
// A scoped run also sets every row's Gzip cell from entry-sizes.json, as the full run does: those cells need no build, and
// a scoped check that kept them passed on 72 stale cells (f235e21f0).
const summary = scopedPackage
  ? refreshSurfaceGzip(
      mergeScopedApiSurface(readFileSync(join(root, 'docs', 'api-surface.md'), 'utf8'), {
        packageName: scopedPackage.name,
        row: surfaceRow(reports[0]),
        entries: reports[0].length,
        exports: reports[0].reduce((sum, item) => sum + item.counts.exports, 0),
      }),
      entrySizes(),
    )
  : surface();
if (update) {
  mkdirSync(apiDir, { recursive: true });
  if (!scopedPackage)
    for (const file of readdirSync(apiDir))
      if (file.endsWith('.api.md') && !expected.has(file)) rmSync(join(apiDir, file));
  for (const [file, text] of expected) writeIfChanged(join(apiDir, file), text);
  writeIfChanged(join(root, 'docs', 'api-surface.md'), summary);
  console.log(
    scopedPackage
      ? `API reports: ${expected.size} selected ${expected.size === 1 ? 'entry' : 'entries'} for ${scopedPackage.name} written without changing other packages.`
      : `API reports: ${expected.size} entries, ${total('exports')} exports written to api/ and docs/api-surface.md.`,
  );
} else {
  const problems = [];
  if (!scopedPackage) {
    const present = existsSync(apiDir) ? readdirSync(apiDir).filter((f) => f.endsWith('.api.md')) : [];
    for (const file of present) if (!expected.has(file)) problems.push(`api/${file}: entry no longer exists`);
  }
  for (const [file, text] of expected) {
    const path = join(apiDir, file);
    if (!existsSync(path)) {
      problems.push(`api/${file}: new entry, no report yet`);
      continue;
    }
    const old = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    if (old !== text) problems.push(`api/${file} changed:\n${diff(old, text)}`);
  }
  // Both modes compare the summary: the full check once skipped it, so a scoped update that wrote a wrong row passed.
  const surfacePath = join(root, 'docs', 'api-surface.md');
  const oldSurface = existsSync(surfacePath) ? readFileSync(surfacePath, 'utf8').replaceAll('\r\n', '\n') : '';
  if (oldSurface !== summary) problems.push(`docs/api-surface.md changed:\n${diff(oldSurface, summary)}`);
  if (problems.length) {
    console.error(problems.join('\n\n'));
    const updateCommand = scopedPackage
      ? `node scripts/api-report.js --update --package=${scopedPackage.dir}${entrySelector ? ` --entry=${entrySelector}` : ''}`
      : 'npm run api:update';
    console.error(
      `\nPublic API changed in ${problems.length} report(s). If intended, run \`${updateCommand}\` and commit the selected API diff.`,
    );
    process.exit(1);
  }
  console.log(
    scopedPackage
      ? `API reports match: ${expected.size} selected ${expected.size === 1 ? 'entry' : 'entries'} for ${scopedPackage.name}.`
      : `API reports match: ${expected.size} entries, ${total('exports')} exports.`,
  );
}

function writeIfChanged(path, text) {
  if (existsSync(path) && readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === text) return; // keep the checkout's line endings
  writeFileSync(path, text);
}

function total(field) {
  return reports.flat().reduce((sum, r) => sum + r.counts[field], 0);
}

// Line diff (longest common subsequence), changed lines with two lines of context.
function diff(a, b) {
  const x = a.split('\n'),
    y = b.split('\n');
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines = [];
  let i = 0,
    j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      lines.push([' ', x[i]]);
      i++;
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) lines.push(['-', x[i++]]);
    else lines.push(['+', y[j++]]);
  }
  const keep = lines.map((_, k) => lines.slice(Math.max(0, k - 2), k + 3).some(([m]) => m !== ' '));
  return lines
    .map(([m, text], k) => (keep[k] ? `${m} ${text}` : keep[k - 1] ? '  ...' : null))
    .filter((l) => l !== null)
    .join('\n');
}

function entrySizes() {
  const sizesFile = join(root, ENTRY_SIZES);
  return existsSync(sizesFile) ? JSON.parse(readFileSync(sizesFile, 'utf8')) : {};
}

function surface() {
  const sizes = entrySizes();
  const rows = reports.map((entries) => surfaceRow(entries, sizes));
  return [
    '# Public API surface',
    '',
    'Generated by `npm run api:update` from the reports in `api/` (one per package `exports` entry; `npm run api:check`,',
    'part of `npm run verify`, fails when a report no longer matches the build). For the "settle APIs before 1.0" review.',
    '',
    `${reports.length} packages, ${reports.flat().length} entries, ${total('exports')} exported names.`,
    '',
    '- Exports: exported names per entry (re-exports of other packages included).',
    '- Unexported: package-local types the exports use but the entry does not export (summed over entries).',
    '- `any`: occurrences of `any` in the reports (summed over entries).',
    '- Gzip: root entry min+gzip bytes, other packages external, from the committed',
    '  [entry-sizes.json](../examples/package-benchmarks/results/entry-sizes.json) (`node examples/package-benchmarks/entry-sizes.mjs`).',
    '',
    '| Package | Exports per entry | Unexported | `any` | Gzip |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

function surfaceRow(entries, providedSizes) {
  const sizes = providedSizes ?? entrySizes();
  const { pkg } = entries[0];
  const list = entries.map((item) => `\`${item.entry.subpath}\` ${item.counts.exports}`).join(', ');
  const sum = (field) => entries.reduce((total, item) => total + item.counts[field], 0);
  return `| ${pkg.name} | ${list} | ${sum('unexported') || ''} | ${sum('any') || ''} | ${gzipCell(sizes, pkg.name)} |`;
}
