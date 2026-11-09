import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseSync } from 'rolldown/utils';

const declaration = (path) => path.replace(/\.(m|c)?js$/, (_, kind = '') => `.d.${kind}ts`);
const inside = (directory, path) => {
  const rest = relative(directory, path);
  return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
};
function references(filename, text) {
  const parsed = parseSync(filename, text);
  if (parsed.errors.length) throw new Error(`Cannot package declarations in ${filename}: ${parsed.errors[0].message}`);
  const out = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const source = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'TSImportType'].includes(
      node.type,
    )
      ? node.source
      : node.type === 'TSExternalModuleReference'
        ? node.expression
        : undefined;
    if (typeof source?.value === 'string' && source.value.startsWith('.'))
      out.push({ specifier: source.value, start: source.start + 1, end: source.end - 1, module: true });
    for (const [key, value] of Object.entries(node))
      if (key !== 'comments') {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
  }
  walk(parsed.program);
  for (const comment of parsed.comments) {
    if (comment.type !== 'Line' || comment.end > parsed.program.start) continue;
    const match = /^\/\/\/\s*<reference\b[^>]*\bpath\s*=\s*(['"])([^'"]+)\1/.exec(
      text.slice(comment.start, comment.end),
    );
    if (!match) continue;
    const start = comment.start + match[0].lastIndexOf(match[2]);
    out.push({ specifier: match[2], start, end: start + match[2].length, module: false });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The comment that marks a declaration import of an optional engine peer (see {@link guardOptionalPeers}). */
export const OPTIONAL_PEER_GUARD = '// @ts-ignore optional peer: its types apply when it is installed';
const packageOf = (specifier) => specifier.split('/', specifier.startsWith('@') ? 2 : 1).join('/');

/**
 * Makes a published declaration file type-check when an optional engine peer is not installed (a strict consumer,
 * `skipLibCheck: false`, otherwise gets TS2307 for every peer it left out). Each module-level `import`/`export ... from`
 * of an optional `@margoengine/*` peer gets {@link OPTIONAL_PEER_GUARD} on the line before its module name: installed,
 * the peer's own types apply; absent, its names are `any`, the same as the feature that needs it. Throws for what a
 * guard cannot cover: a bare module the package does not declare as a dependency or peer (never installed for its
 * users), and an inline `import('peer')` type of an optional engine peer (write it as a module-level `import type`).
 * Third-party optional peers are left alone: `react` is optional only so that the one-install package does not install
 * React for apps without it, and the React bindings' declarations are React types.
 */
export function guardOptionalPeers(filename, text, manifest) {
  const declared = new Set([
      manifest.name,
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
    optional = new Set(
      Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([name, meta]) => meta?.optional && name.startsWith('@margoengine/'))
        .map(([name]) => name),
    );
  const parsed = parseSync(filename, text);
  if (parsed.errors.length) throw new Error(`Cannot guard declarations in ${filename}: ${parsed.errors[0].message}`);
  const bare = (node) =>
    typeof node?.value === 'string' && !node.value.startsWith('.') && !node.value.startsWith('node:') ? node : null;
  const check = (source) => {
    const name = packageOf(source.value);
    if (!declared.has(name))
      throw new Error(
        `${filename} imports types from ${source.value}, but ${manifest.name} does not declare ${name} as a dependency or peer: its users never get it installed`,
      );
    return optional.has(name);
  };
  const guarded = new Set();
  for (const statement of parsed.program.body) {
    const source = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type)
      ? bare(statement.source)
      : null;
    if (source && check(source)) guarded.add(source);
  }
  const parameterEdits = [];
  let parameterId = 0;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    // A declaration needs a typed parameter, not its implementation's destructuring. When
    // an absent optional peer supplies inherited fields, binding names otherwise produce
    // TS2339 even though its import is guarded. Preserve the complete annotation and arity.
    if (guarded.size && Array.isArray(node.params)) {
      for (const parameter of node.params) {
        if (!['ObjectPattern', 'ArrayPattern'].includes(parameter.type) || !parameter.typeAnnotation) continue;
        let name;
        do {
          name = `_arg${parameterId++}`;
        } while (text.includes(name));
        parameterEdits.push({
          start: parameter.start,
          end: parameter.typeAnnotation.start,
          value: name + (parameter.optional ? '?' : ''),
        });
      }
    }
    if (node.type === 'TSImportType') {
      const source = bare(node.source ?? node.argument?.literal ?? node.argument);
      if (source && check(source))
        throw new Error(
          `${filename} names optional peer ${source.value} in an inline import() type; use a module-level \`import type\` so the published declarations can guard it`,
        );
    }
    for (const [key, value] of Object.entries(node))
      if (key !== 'comments') {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
  })(parsed.program);
  // TypeScript reports a missing module at its name, and @ts-ignore covers the line after the comment.
  const lines = new Set(
    [...guarded]
      .map((source) => text.lastIndexOf('\n', source.start - 1) + 1)
      .filter((start) => {
        const before = text.slice(0, Math.max(0, start - 1));
        return !before.slice(before.lastIndexOf('\n') + 1).startsWith(OPTIONAL_PEER_GUARD);
      }),
  );
  let output = '',
    end = 0;
  const edits = [
    ...parameterEdits,
    ...[...lines].map((start) => ({
      start,
      end: start,
      value: OPTIONAL_PEER_GUARD + '\n',
    })),
  ].sort((a, b) => a.start - b.start);
  for (const edit of edits) {
    output += text.slice(end, edit.start) + edit.value;
    end = edit.end;
  }
  return output + text.slice(end);
}

/** Keep shared type dependencies inside the files shipped by an individual npm package. Runtime modules are untouched. */
export async function packageDeclarations(root) {
  const dist = resolve(root, 'dist'),
    shared = resolve(root, '../shared'),
    visited = new Set();
  const manifestFile = join(root, 'package.json'),
    manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : null;
  async function visit(source, destination) {
    if (visited.has(source)) return;
    visited.add(source);
    const text = await readFile(source, 'utf8');
    let output = '',
      end = 0;
    for (const reference of references(source, text)) {
      const specifier = reference.specifier,
        target = declaration(resolve(dirname(source), specifier));
      let next;
      if (inside(dist, target)) next = target;
      else if (inside(shared, target)) next = join(dist, 'shared', relative(shared, target));
      else throw new Error(`Declaration dependency escapes ${root}: ${specifier} in ${source}`);
      await visit(target, next);
      let replacement = relative(dirname(destination), next).split(sep).join('/');
      // Triple-slash references name declarations; module references name their JavaScript counterpart.
      if (reference.module) replacement = replacement.replace(/\.d\.(m|c)?ts$/, (_, kind = '') => `.${kind}js`);
      if (!replacement.startsWith('.')) replacement = './' + replacement;
      output += text.slice(end, reference.start) + replacement;
      end = reference.end;
    }
    output += text.slice(end);
    if (manifest) output = guardOptionalPeers(source, output, manifest);
    if (source !== destination || output !== text) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, output);
    }
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.d\.(?:m|c)?ts$/.test(entry.name)) await visit(file, file);
    }
  }
  await walk(dist);
}

/**
 * The runtime twin of {@link packageDeclarations} for packages emitted by plain tsc (bvh, exporters, loaders, react):
 * copies every packages/shared module their dist JavaScript imports (and the shared modules those import) to
 * dist/shared and points the imports there, so the packed package runs without the repository around it.
 */
export async function packageRuntime(root) {
  const dist = resolve(root, 'dist'),
    shared = resolve(root, '../shared'),
    visited = new Set();
  async function visit(source, destination) {
    if (visited.has(source)) return;
    visited.add(source);
    const text = await readFile(source, 'utf8');
    let output = '',
      end = 0;
    for (const reference of references(source, text)) {
      if (!reference.module) continue;
      const target = resolve(dirname(source), reference.specifier);
      let next;
      if (inside(dist, target)) next = target;
      else if (inside(shared, target)) next = join(dist, 'shared', relative(shared, target));
      else if (inside(shared, source))
        throw new Error(`Runtime dependency escapes ${root}: ${reference.specifier} in ${source}`);
      else continue;
      await visit(target, next);
      let replacement = relative(dirname(destination), next).split(sep).join('/');
      if (!replacement.startsWith('.')) replacement = './' + replacement;
      output += text.slice(end, reference.start) + replacement;
      end = reference.end;
    }
    output += text.slice(end);
    if (source !== destination || output !== text) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, output);
    }
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:m|c)?js$/.test(entry.name)) await visit(file, file);
    }
  }
  await walk(dist);
}
