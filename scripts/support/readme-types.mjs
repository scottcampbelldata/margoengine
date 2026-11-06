// Type-checks the examples of the package READMEs and guides as a reader would paste them, against the built packages.
// Three callers: `npm run check:readmes` (scripts/check-readme-types.mjs, a step of `npm run verify`, so nothing lands
// without it), modern-package-tests.js (the same examples against the packed tarballs) and the scene and worker tests.
import { spawnSync } from 'node:child_process';
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

/** The compiler options of a project holding the binding's stand-in as `readme-binding.d.ts`. */
export const README_PROJECT = { ...README_OPTIONS, paths: { webgpu: ['./readme-binding.d.ts'] } };

/**
 * The examples of a Markdown text. A `ts`, `tsx` or `js` block that imports starts an example; one that does not carries
 * on the example before it, whose setup it uses. Each ends in `export {}`: a file without one would be a global script,
 * and a name one example declares would pass in another.
 */
export function readmeExamples(markdown) {
  const examples = [];
  for (const [, code] of markdown.matchAll(/```(?:tsx?|js)\r?\n([\s\S]*?)```/g)) {
    if (!examples.length || /^\s*(?:import\s|const\s+\{[^}]+\}\s*=\s*await\s+import\s*\()/m.test(code))
      examples.push(code);
    else examples[examples.length - 1] += `\n${code}`;
  }
  return examples.map((code) => `${code}\nexport {};\n`);
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
  writeFileSync(
    join(scratch, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: README_PROJECT, include: ['**/*.tsx'] }),
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

/** Type-checks one package folder's examples on their own; returns the compiler's lines, an empty list passes. */
export function readmeTypeErrors(folder) {
  if (!packageMarkdown(folder).some(({ markdown }) => readmeExamples(markdown).length))
    return [`${folder}/README.md has no examples`];
  // Inside the package, so its package.json makes the files modules and node_modules resolves as for a consumer.
  const scratch = mkdtempSync(join(resolve(folder), '.readme-check-'));
  try {
    writeExamples(scratch, [{ name: basename(folder), folder }]);
    return compile(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
