// Public API snapshots (HANDOFF 1h.c). For every `exports` entry of every workspace package, list each exported name with
// its declaration from the emitted dist/*.d.ts (comments and private class members dropped), plus the package-local
// types those declarations reference but the entry does not export. One report per entry in api/, like API Extractor's
// .api.md. `npm run api:check` (default) fails with a diff when a report changed; `npm run api:update` rewrites them and
// docs/api-surface.md. Needs `npm run build:packages` first. Uses TypeScript 7's checker through its
// `typescript/unstable/sync` API (no extra dependency); that API is marked unstable, so a TypeScript bump may need edits.
import { API, SymbolFlags } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const update = process.argv.includes('--update');
const apiDir = join(root, 'api');
const slash = (p) => p.replaceAll('\\', '/');
const key = (p) => slash(p).toLowerCase(); // the checker reports lower-cased paths on Windows
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Packages and their entries, in directory order.
const packages = [];
for (const dir of readdirSync(join(root, 'packages')).sort(byText)) {
  const file = join(root, 'packages', dir, 'package.json');
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const entries = Object.entries(manifest.exports ?? {}).map(([subpath, target]) => {
    const types = typeof target === 'string' ? target.replace(/\.js$/, '.d.ts') : target.types;
    const dts = join(root, 'packages', dir, types);
    if (!existsSync(dts)) throw new Error(`${manifest.name} "${subpath}": ${types} missing; run npm run build:packages`);
    const suffix = subpath === '.' ? '' : '.' + subpath.slice(2).replaceAll('/', '-');
    return { subpath, specifier: manifest.name + subpath.slice(1), dts: slash(dts), report: `${dir}${suffix}.api.md` };
  });
  if (entries.length) packages.push({ dir, name: manifest.name, home: key(join(root, 'packages', dir)) + '/', entries });
}
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

// One program over every entry.
const temp = mkdtempSync(join(tmpdir(), 'margo-api-'));
writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', lib: ['es2022', 'dom'], types: [], skipLibCheck: true, noEmit: true },
  files: packages.flatMap((pkg) => pkg.entries.map((entry) => entry.dts)),
}));
const api = new API({ cwd: root });
const exportedBy = new Map(); // symbol id -> first entry of the declaring package that exports it (for import lines)
let reports;
try {
  const project = api.updateSnapshot({ openProjects: [join(temp, 'tsconfig.json')] }).getProjects()[0];
  const { checker, program } = project;
  for (const pkg of packages) for (const entry of pkg.entries) {
    for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry.dts)))) {
      const target = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const path = target.declarations?.[0]?.path;
      if (path && key(path).startsWith(pkg.home) && !exportedBy.has(target.id)) exportedBy.set(target.id, entry.specifier);
    }
  }
  reports = packages.map((pkg) => pkg.entries.map((entry) => ({ pkg, entry, ...report(project, pkg, entry) })));
} finally {
  api.close();
  rmSync(temp, { recursive: true, force: true });
}

function report({ program, checker }, pkg, entry) {
  const local = (path) => { const p = key(path); return p.startsWith(pkg.home) || p.startsWith(shared); };
  const resolveAlias = (symbol) => (symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const queue = []; // local declarations whose type references still need a look
  const exported = new Set();
  const imports = new Set();
  const counts = { exports: 0, any: 0, unexported: 0 };

  const renderModule = (moduleSymbol, indent) => {
    const exports = [...checker.getExportsOfModule(moduleSymbol)].sort((a, b) => byText(a.name, b.name));
    for (const symbol of exports) exported.add(resolveAlias(symbol).id);
    return exports.map((symbol) => renderExport(symbol, indent)).join('\n\n');
  };
  const renderExport = (symbol, indent) => {
    const target = resolveAlias(symbol);
    const declarations = target.declarations ?? [];
    if (!declarations.length) return `${indent}export { ${symbol.name} }; // unresolved`;
    if (declarations[0].kind === SyntaxKind.SourceFile) return `${indent}export namespace ${symbol.name} {\n${renderModule(target, indent + '    ')}\n${indent}}`;
    const rename = target.name === symbol.name ? '' : `${target.name} as `;
    if (!local(declarations[0].path)) return `${indent}export { ${rename}${symbol.name} } from "${ownerOf(declarations[0].path)}";`;
    queue.push(...declarations);
    const texts = renderDeclarations(declarations).map((text) => indent + (rename ? '' : 'export ') + text.replaceAll('\n', '\n' + indent));
    return (rename ? `${indent}export { ${rename}${symbol.name} };\n` : '') + texts.join('\n');
  };

  const entrySymbol = checker.getSymbolAtLocation(program.getSourceFile(entry.dts));
  counts.exports = checker.getExportsOfModule(entrySymbol).length;
  let body = renderModule(entrySymbol, '');

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
      while (name && (name.kind === SyntaxKind.QualifiedName || name.kind === SyntaxKind.PropertyAccessExpression)) name = name.left ?? name.expression;
      if (name && name.getText() !== 'this') references.push(name);
      node.forEachChild(visit);
    };
    visit(declaration.resolve());
    if (!references.length) continue;
    const symbols = checker.getSymbolAtLocation(references);
    for (const [index, found] of symbols.entries()) {
      if (!found) continue;
      const symbol = resolveAlias(found);
      if (exported.has(symbol.id) || symbol.flags & SymbolFlags.TypeParameter) continue;
      if (seen.has(symbol.id)) { seen.get(symbol.id)?.used.add(references[index].getText()); continue; }
      seen.set(symbol.id, null);
      const all = symbol.declarations ?? [];
      const owner = all.length && !local(all[0].path) ? ownerOf(all[0].path) : undefined;
      const workspace = packages.some((p) => p.name === owner);
      if (owner) imports.add(`${exportedBy.get(symbol.id) ?? (workspace ? owner + '#internal' : owner)}\0${symbol.name}`);
      const declarations = all.filter((d) => local(d.path) && topLevel(d.resolve()));
      if (!declarations.length) continue;
      const item = { name: symbol.name, path: key(declarations[0].path), used: new Set([references[index].getText()]), text: renderDeclarations(declarations).join('\n') };
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
  if (unexported.length) body += '\n\n// Not exported from this entry, but used by the exports above:\n\n' + unexported.map((u) => note(u) + u.text).join('\n\n');

  // Types from other packages that the declarations above use.
  const from = new Map();
  for (const item of [...imports].sort(byText)) {
    const [owner, name] = item.split('\0');
    from.set(owner, [...(from.get(owner) ?? []), name]);
  }
  const importLine = ([spec, names]) => spec.endsWith('#internal')
    ? `import { ${names.join(', ')} } from "${spec.slice(0, -9)}"; // not exported by any entry of that package`
    : `import { ${names.join(', ')} } from "${spec}";`;
  if (from.size) body = [...from].map(importLine).join('\n') + '\n\n' + body;

  // Global augmentations in the package's loaded declaration files (they apply whenever the package's types load).
  const globals = [];
  for (const file of program.getSourceFileNames().filter((f) => key(f).startsWith(pkg.home)).sort((a, b) => byText(key(a), key(b)))) {
    for (const statement of program.getSourceFile(file)?.statements ?? []) {
      if (statement.kind === SyntaxKind.ModuleDeclaration && /^declare\s+global\b/.test(statement.getText())) globals.push('declare ' + clean(statement));
    }
  }
  if (globals.length) body += '\n\n' + [...new Set(globals)].join('\n\n');

  counts.any = (body.match(/\bany\b/g) ?? []).length;
  const text = `## API Report File for "${entry.specifier}"\n\n> Do not edit this file. It is a report generated by \`npm run api:update\`.\n\n\`\`\`ts\n${body}\n\`\`\`\n`;
  return { text, counts };
}

function topLevel(node) {
  let statement = node.kind === SyntaxKind.VariableDeclaration ? node.parent.parent : node;
  return statement.parent?.kind === SyntaxKind.SourceFile;
}

// All declarations of one symbol (overloads, merged interfaces, class + namespace), in source order.
function renderDeclarations(handles) {
  const nodes = handles.map((h) => h.resolve()).filter(Boolean);
  nodes.sort((a, b) => byText(key(a.getSourceFile().fileName), key(b.getSourceFile().fileName)) || a.pos - b.pos);
  return [...new Set(nodes.map((node) => {
    if (node.kind !== SyntaxKind.VariableDeclaration) return clean(node);
    const statement = node.parent.parent;
    if (node.parent.declarations.length === 1) return clean(statement);
    return statement.getText().match(/^(?:export\s+)?(?:declare\s+)?(const|let|var)\b/)[1] + ' ' + clean(node) + ';';
  }))];
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
    } else out += c;
  }
  return out;
}

// Write or compare.
const expected = new Map(reports.flat().map((r) => [r.entry.report, r.text]));
const summary = surface();
if (update) {
  mkdirSync(apiDir, { recursive: true });
  for (const file of readdirSync(apiDir)) if (file.endsWith('.api.md') && !expected.has(file)) rmSync(join(apiDir, file));
  for (const [file, text] of expected) writeIfChanged(join(apiDir, file), text);
  writeIfChanged(join(root, 'docs', 'api-surface.md'), summary);
  console.log(`API reports: ${expected.size} entries, ${total('exports')} exports written to api/ and docs/api-surface.md.`);
} else {
  const problems = [];
  const present = existsSync(apiDir) ? readdirSync(apiDir).filter((f) => f.endsWith('.api.md')) : [];
  for (const file of present) if (!expected.has(file)) problems.push(`api/${file}: entry no longer exists`);
  for (const [file, text] of expected) {
    const path = join(apiDir, file);
    if (!existsSync(path)) { problems.push(`api/${file}: new entry, no report yet`); continue; }
    const old = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    if (old !== text) problems.push(`api/${file} changed:\n${diff(old, text)}`);
  }
  if (problems.length) {
    console.error(problems.join('\n\n'));
    console.error(`\nPublic API changed in ${problems.length} report(s). If intended, run \`npm run api:update\` and commit the api/ diff.`);
    process.exit(1);
  }
  console.log(`API reports match: ${expected.size} entries, ${total('exports')} exports.`);
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
  const x = a.split('\n'), y = b.split('\n');
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines = [];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { lines.push([' ', x[i]]); i++; j++; }
    else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) lines.push(['-', x[i++]]);
    else lines.push(['+', y[j++]]);
  }
  const keep = lines.map((_, k) => lines.slice(Math.max(0, k - 2), k + 3).some(([m]) => m !== ' '));
  return lines.map(([m, text], k) => (keep[k] ? `${m} ${text}` : keep[k - 1] ? '  ...' : null)).filter((l) => l !== null).join('\n');
}

function surface() {
  const sizesFile = join(root, 'test-results', 'modern-bundle-sizes.json');
  const sizes = existsSync(sizesFile) ? JSON.parse(readFileSync(sizesFile, 'utf8')) : {};
  const rows = reports.map((entries) => {
    const { pkg } = entries[0];
    const list = entries.map((r) => `\`${r.entry.subpath}\` ${r.counts.exports}`).join(', ');
    const sum = (field) => entries.reduce((s, r) => s + r.counts[field], 0);
    const gzip = sizes[pkg.dir]?.gzip;
    return `| ${pkg.name} | ${list} | ${sum('unexported') || ''} | ${sum('any') || ''} | ${gzip ? gzip.toLocaleString('en-US') : ''} |`;
  });
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
    '- Gzip: root entry min+gzip bytes from `test-results/modern-bundle-sizes.json` at the last `api:update` (blank: not measured).',
    '',
    '| Package | Exports per entry | Unexported | `any` | Gzip |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}
