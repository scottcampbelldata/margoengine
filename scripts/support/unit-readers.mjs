// The root unit tests a changed document can affect (KB-GATE-DOCREADERS1). A lane's fast gate runs the tests of the
// packages it changed, and a document (any .md file, the site pages, records) belongs to no package, so an edit to
// docs/limits.md or docs/whitepaper/claims.md ran no test at all while tests/claims-file.test.js reads both: two such
// edits reached main red (80ca93fe2c, f7a229b5ad). `npm run hygiene`, which every lane gate runs, now runs every root
// test that names a changed document in code.
//
// A test names a document when its source, comments removed, holds the document's repo path (`docs/limits.md`), or a
// template literal path whose file name is written out (`packages/${folder}/README.md`): each `${...}` there stands for
// one path segment or part of one (a leading one for any prefix). A README edit in a package once ran no test while
// tests/package-readmes.test.js, which reads every package README through such a template, failed on main
// (aad1fb5ee7, KB-GATE-READMEREADERS1). A path built from parts any other way is not found; such a test belongs in the
// map by naming the path once in code.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from './file-classes.mjs';

const posix = (path) => path.replaceAll('\\', '/');

/** Source text with block comments and line comments removed (a `//` inside a URL's `://` stays). Approximate. */
export function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

/**
 * Whether code holds the file's own name in quotes (a table keyed by name, as public-truth.test.js keys claims.md),
 * for a name that is not generic: a README or an index names no one file.
 */
const quotedName = (file, code) => {
  const base = file.split('/').at(-1);
  return (
    !/^(index|main|README|package|manifest|config)\./.test(base) &&
    ["'", '"', '`'].some((q) => code.includes(`${q}${base}${q}`))
  );
};

/**
 * Path patterns a test writes as template literals with a literal file name at the end (`packages/${folder}/README.md`,
 * `${root}docs/${name}/notes.md`), as anchored regular expressions. A template with a space, or whose last segment holds
 * a placeholder (`${dir}/${name}.html`), names no file and is skipped.
 */
export function templatePaths(code) {
  const found = [];
  for (const [, body] of code.matchAll(/`([^`\s]*\$\{[^`\s]*)`/g)) {
    const tail = body.split('/').at(-1);
    if (!/^[\w.-]+\.[A-Za-z]+$/.test(tail) || !body.includes('/')) continue;
    const parts = body.replace(/^(?:\.\.?\/)+/, '').split(/\$\{[^}]*\}/);
    if (parts.some((part) => part.includes('{') || part.includes('}'))) continue;
    const escaped = parts.map((text) => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&')),
      // A leading placeholder (`${root}`) stands for any prefix, the others for one segment or part of one.
      source = escaped[0] === '' ? `.*${escaped.slice(1).join('[^/]+')}` : escaped.join('[^/]+');
    found.push(new RegExp(`^${source}$`));
  }
  return found;
}

/** The documents among `files`: the files whose class is `inert` (every .md file, site pages, records). */
export const documentsAmong = (files) => files.map(posix).filter((file) => classify(file).cls === 'inert');

/**
 * `{ test, documents }` for each root test (`tests/*.test.js`) that names at least one of the changed documents in
 * code, in name order. `files` is every changed file; code and other classes are ignored (their own checks run).
 */
export function unitReaders(root, files) {
  const documents = documentsAmong(files);
  if (!documents.length) return [];
  return readdirSync(join(root, 'tests'))
    .filter((name) => /^[\w.-]+\.test\.js$/.test(name))
    .sort()
    .flatMap((name) => {
      const code = withoutComments(readFileSync(join(root, 'tests', name), 'utf8')),
        patterns = templatePaths(code),
        named = documents.filter(
          (file) => code.includes(file) || quotedName(file, code) || patterns.some((re) => re.test(file)),
        );
      return named.length ? [{ test: `tests/${name}`, documents: named }] : [];
    });
}

/** Files changed against origin/main's merge base, tracked and untracked; empty when git cannot say. */
export function changedAgainstMain(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }),
    lines = (text) => text.split('\0').filter(Boolean);
  try {
    const base = git('merge-base', 'HEAD', 'origin/main').trim();
    return [
      ...new Set([
        ...lines(git('diff', '--name-only', '--no-renames', '-z', base)),
        ...lines(git('ls-files', '--others', '--exclude-standard', '-z')),
      ]),
    ];
  } catch {
    return [];
  }
}

/**
 * Runs the readers of the changed documents (all together, `node --test`) and throws naming the failing tests. `files`
 * defaults to the changes against origin/main.
 */
export function assertDocumentReadersPass(root, files = changedAgainstMain(root), { timeout = 300000 } = {}) {
  const readers = unitReaders(root, files);
  if (!readers.length) return readers;
  const run = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--test', `--test-timeout=${timeout}`, ...readers.map((r) => r.test)],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: timeout + 60000,
      maxBuffer: 1 << 28,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  if (run.status !== 0) {
    const failed = (run.stdout ?? '').split('\n').filter((line) => /^\s*not ok /.test(line));
    throw new Error(
      `a root test that reads a changed document failed (${readers.map((r) => r.test).join(', ')}):\n${failed.join('\n')}\n${(run.stdout ?? '').slice(-3000)}${run.stderr ?? ''}`,
    );
  }
  return readers;
}
