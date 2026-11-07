// Type-checks the examples of the package READMEs and guides as a reader would paste them, against the built packages.
// Three callers: `npm run check:readmes` (scripts/check-readme-types.mjs, a step of `npm run verify`, so nothing lands
// without it), modern-package-tests.js (the same examples against the packed tarballs) and the scene and worker tests.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));

/** The package folder of a test file two levels down. */
export const packageFolder = (url) => dirname(dirname(fileURLToPath(url)));

/** The compiler options of a README example: what a strict consumer project uses. */
export const README_OPTIONS = {
  strict: true,
  noEmit: true,
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  jsx: 'react-jsx',
  lib: ['ES2022', 'ESNext.Disposable', 'DOM'],
  types: ['node'],
};

/**
 * Stands in for the `webgpu` binding in the examples' project: the binding's own types load
 * `@webgpu/types`, whose globals clash with the DOM library in every other example of the same program.
 */
export const README_BINDING = 'export declare function create(flags: string[]): GPU;';

/**
 * Browser globals of WebGPU that TypeScript's DOM library leaves out, though every WebGPU browser has them. Only real globals
 * go here: a name an example needs set up is written in the example.
 */
export const README_GLOBALS = `declare const GPUBufferUsage: Readonly<Record<'MAP_READ' | 'MAP_WRITE' | 'COPY_SRC' | 'COPY_DST' | 'INDEX' | 'VERTEX' | 'UNIFORM' | 'STORAGE' | 'INDIRECT' | 'QUERY_RESOLVE', number>>;
declare const GPUTextureUsage: Readonly<Record<'COPY_SRC' | 'COPY_DST' | 'TEXTURE_BINDING' | 'STORAGE_BINDING' | 'RENDER_ATTACHMENT', number>>;
`;

/** The compiler options of a project holding the binding's stand-in as `readme-binding.d.ts`. */
export const README_PROJECT = { ...README_OPTIONS, paths: { webgpu: ['./readme-binding.d.ts'] } };

/**
 * The examples of a Markdown text. A `ts`, `tsx` or `js` block that imports starts an example; one that does not carries
 * on the example before it, whose setup it uses. Each ends in `export {}`: a file without one would be a global script,
 * and a name one example declares would pass in another.
 */
export function readmeExamples(markdown) {
  return readmeEntries(markdown).map(({ code }) => code);
}

/** The examples of a Markdown text with the heading each starts under: [{ code, heading }], heading '' before the first. */
export function readmeEntries(markdown) {
  const entries = [];
  for (const { 1: code, index } of markdown.matchAll(/```(?:tsx?|js)\r?\n([\s\S]*?)```/g)) {
    if (!entries.length || /^\s*(?:import\s|const\s+\{[^}]+\}\s*=\s*await\s+import\s*\()/m.test(code))
      entries.push({ code, heading: lastHeading(markdown.slice(0, index)) });
    else entries.at(-1).code += `\n${code}`;
  }
  return entries.map(({ code, heading }) => ({ code: `${code}\nexport {};\n`, heading }));
}

/** The last Markdown heading of `text`; a `#` line inside a code block is not one. */
function lastHeading(text) {
  const prose = text.replace(/^```[\s\S]*?^```/gm, '');
  return [...prose.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*\r?$/gm)].at(-1)?.[1] ?? '';
}

/**
 * The id of each example of one document, `<package>/<document>-<heading>-<hash>`, in the order given. The id comes from what
 * the example says and the heading above it, never its place in the file, so a new example above a listed one leaves the
 * known list as it stands. Line endings do not count: a Windows and a Linux checkout agree. Two identical examples under one
 * heading are told apart by a number, and changing a listed example changes its id, as it is a different example now.
 */
export function exampleIds(name, document, entries) {
  const seen = new Map();
  return entries.map(({ code, heading }) => {
    const words = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, ''),
      hash = createHash('sha256').update(code.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 6),
      id = `${name}/${document}-${words ? `${words}-` : ''}${hash}`,
      count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}-${count}`;
  });
}

/**
 * The stand-ins of a Markdown text: every `declare` of a value in its examples, as trimmed lines. Such a line satisfies
 * the compiler but holds nothing at run time, so the example it serves does not run as pasted.
 */
export function standIns(markdown) {
  const found = [];
  for (const [, code] of markdown.matchAll(/```(?:tsx?|js)\r?\n([\s\S]*?)```/g))
    for (const [line] of code.matchAll(/^[ \t]*declare\s+(?:const|let|var|function|class)\b.*$/gm))
      found.push(line.trim());
  return found;
}

/** The README and guides (docs/*.md) of a package folder: [{ document, markdown }]; `readme` first. */
export function packageMarkdown(folder) {
  const found = [];
  if (existsSync(join(folder, 'README.md')))
    found.push({ document: 'readme', markdown: readFileSync(join(folder, 'README.md'), 'utf8') });
  if (existsSync(join(folder, 'docs')))
    for (const file of readdirSync(join(folder, 'docs')).sort())
      if (file.endsWith('.md'))
        found.push({
          document: `docs-${basename(file, '.md')}`,
          markdown: readFileSync(join(folder, 'docs', file), 'utf8'),
        });
  return found;
}

/** Writes the examples of each `{ name, folder }` under `scratch/<name>/`, with a tsconfig; returns how many it wrote. */
export function writeExamples(scratch, packages) {
  let count = 0;
  for (const { name, folder } of packages)
    for (const { document, markdown } of packageMarkdown(folder))
      readmeExamples(markdown).forEach((code, index) => {
        mkdirSync(join(scratch, name), { recursive: true });
        writeFileSync(join(scratch, name, `${document}-${index}.tsx`), code);
        count++;
      });
  writeFileSync(join(scratch, 'readme-binding.d.ts'), README_BINDING);
  writeFileSync(join(scratch, 'readme-globals.d.ts'), README_GLOBALS);
  writeFileSync(
    join(scratch, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: README_PROJECT, include: ['**/*.tsx', 'readme-globals.d.ts'] }),
  );
  return count;
}

/** Runs the compiler on a folder written by writeExamples; returns its output lines, none when everything passes. */
export function compile(scratch) {
  const run = spawnSync(process.execPath, [compiler, '-p', scratch, '--pretty', 'false'], {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 2 ** 20,
  });
  if (run.error) throw run.error;
  if (run.status === null) throw new Error(`tsc ended on ${run.signal}`);
  return run.status === 0 ? [] : `${run.stdout}${run.stderr}`.split(/\r?\n/).filter(Boolean);
}

/**
 * The errors in compiler output: [{ name, key, line }]. `name` is the package, by the example's folder or a declaration's
 * path; `key` has the code and message without the place, so editing a README moves no key and a new mistake is a new one.
 */
export function parseErrors(lines, root) {
  const slashed = resolve(root).replaceAll('\\', '/');
  const errors = [];
  for (const line of lines) {
    const match = /^(.+?)\(\d+,\d+\): error (TS\d+: .*)$/.exec(line);
    if (match) {
      const [, file, message] = match;
      errors.push({
        name: /(?:^|\/)(?:readme-types|packages)\/([^/]+)\//.exec(file)?.[1] ?? file,
        key: message.replaceAll(slashed, '<root>'),
        line,
      });
    } else if (!errors.length || !/^\s/.test(line)) errors.push({ name: '(compiler)', key: line, line });
    else errors.at(-1).line += `\n${line}`;
  }
  return errors;
}

/** Counts errors as `{ package: { key: count } }`, sorted, the shape of the known list. */
export function tally(errors) {
  const counts = {};
  for (const { name, key } of errors) (counts[name] ??= {})[key] = (counts[name][key] ?? 0) + 1;
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((name) => [
        name,
        Object.fromEntries(
          Object.keys(counts[name])
            .sort()
            .map((key) => [key, counts[name][key]]),
        ),
      ]),
  );
}

/**
 * Compares errors with the known list. `fresh` is every error past its known count: those fail. `gone` is every known
 * count the examples no longer reach: those fail too, so the list only ever shrinks.
 */
export function compareKnown(errors, known) {
  const left = structuredClone(known),
    fresh = [];
  for (const error of errors) {
    if (left[error.name]?.[error.key] > 0) left[error.name][error.key]--;
    else fresh.push(error);
  }
  const gone = Object.entries(left).flatMap(([name, keys]) =>
    Object.entries(keys)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => ({ name, key, count })),
  );
  return { fresh, gone };
}

/**
 * A new scratch folder for `folder`'s examples. Inside the package, so its package.json makes the files modules and
 * node_modules resolves as for a consumer; under test-results, which git and the tests that walk the sources skip, so
 * a walk running beside a package's own test never meets files about to go.
 */
export function readmeScratch(folder) {
  const parent = join(resolve(folder), 'test-results');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'readme-check-'));
}

/** Type-checks one package folder's examples on their own; returns the compiler's lines, an empty list passes. */
export function readmeTypeErrors(folder) {
  if (!packageMarkdown(folder).some(({ markdown }) => readmeExamples(markdown).length))
    return [`${folder}/README.md has no examples`];
  const scratch = readmeScratch(folder);
  try {
    writeExamples(scratch, [{ name: basename(folder), folder }]);
    return compile(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
