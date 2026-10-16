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

/** Keep shared type dependencies inside the files shipped by an individual npm package. Runtime modules are untouched. */
export async function packageDeclarations(root) {
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
