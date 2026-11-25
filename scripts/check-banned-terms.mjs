// Fails when a tracked file's path, a tracked text file, or the text a tracked PDF shows, contains a term from
// scripts/banned-terms.json. CAD file import and CAD formats are fine here. The list
// holds hashes, never the words. To fix a hit: remove the text from the public file (for a
// PDF, from the page it is printed from, then print it again). A new allow entry needs a reason and a review.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machinePathAllowed, machinePathLines } from './machine-paths.mjs';
import { pdfText } from './pdf-text.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const LIST = JSON.parse(readFileSync(resolve(root, 'scripts/banned-terms.json'), 'utf8'));
const hash = (word) => createHash('sha256').update(`margo-banned:${word}`).digest('hex').slice(0, 24);
const TOKENS = new Set(LIST.tokens),
  PAIRS = new Set(LIST.pairs),
  PATH_TOKENS = new Set([...LIST.tokens, ...LIST.pathTokens]);

/** The banned-term ids found in a tracked file's path: every piece between non-alphanumerics and camelCase words. */
export function hitsInPath(path) {
  const found = [];
  const words = path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/);
  for (const w of words) if (w && PATH_TOKENS.has(hash(w.toLowerCase()))) found.push(hash(w.toLowerCase()));
  return [...found, ...hitsInLine(path)];
}

/** The banned-term ids found in one line of text (the hash of each hit). */
export function hitsInLine(line) {
  const found = [];
  for (const [word] of line.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)*/gi)) {
    const w = word.toLowerCase();
    // As written, hyphens removed, and each piece of a hyphenated compound (`word-like`, `word-style`).
    for (const form of new Set([w, w.replaceAll('-', ''), ...w.split('-')]))
      if (TOKENS.has(hash(form))) found.push(hash(form));
  }
  // Every adjacent pair of a path, so `a/b/c` checks both `a/b` and `b/c`.
  for (const [path] of line.matchAll(/[a-z0-9-]+(?:\/[a-z0-9-]+)+/gi)) {
    const parts = path.toLowerCase().split('/');
    for (let i = 0; i + 1 < parts.length; i++) {
      const id = hash(`${parts[i]}/${parts[i + 1]}`);
      if (PAIRS.has(id)) found.push(id);
    }
  }
  return found;
}

/** Every hit in a text, as `{ line, id }`; empty for a binary buffer. */
export function scan(buffer) {
  if (buffer.subarray(0, 8192).includes(0)) return [];
  const hits = [];
  buffer
    .toString('utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const id of hitsInLine(line)) hits.push({ line: i + 1, id });
    });
  return hits;
}

const allowed = (file) => LIST.allow.some((a) => a.path === file) || file === 'scripts/banned-terms.json';

const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString()
    .split('\0')
    .filter(Boolean);

/**
 * Scans `files` (every tracked file by default), read through `read`; returns `path:line: banned term <id>` messages.
 * With `named`, a file that does not exist is a problem; in a full scan a tracked file deleted in the working tree is
 * skipped.
 */
export function scanRepo(read = (path) => readFileSync(path), files = tracked(), named = false) {
  const out = [];
  for (const file of files) {
    for (const id of new Set(hitsInPath(file)))
      out.push(`${file}: banned term ${id} in the file or folder name; rename or remove it`);
    const termsAllowed = allowed(file),
      pathsAllowed = machinePathAllowed(file);
    if (termsAllowed && pathsAllowed) continue;
    let data;
    try {
      data = read(resolve(root, file));
    } catch (error) {
      // A tracked file deleted in the working tree has nothing to scan. Any other read failure (a file another process
      // holds open mid-write, EBUSY or EPERM on Windows) would skip a file unscanned, so it fails, naming the reason.
      if (error?.code === 'ENOENT' && !named) continue;
      if (error?.code === 'ENOENT') {
        out.push(`${file}: no such file; a file named on the command line must exist, fix the path`);
        continue;
      }
      out.push(`${file}: could not be read (${error?.code ?? error}); rerun once the process writing it has finished`);
      continue;
    }
    if (file.endsWith('.pdf')) {
      if (termsAllowed) continue;
      const text = pdfText(data);
      if (text === null) out.push(`${file}: no readable text; the banned-terms check must be able to read every PDF`);
      else
        for (const { id } of scan(Buffer.from(text)))
          out.push(`${file}: banned term ${id} in the printed text; remove it from the page it is printed from`);
      continue;
    }
    if (!pathsAllowed)
      for (const line of machinePathLines(data))
        out.push(
          `${file}:${line}: absolute machine path; name a sibling checkout as ../name, a tool cache by its environment variable (see scripts/machine-paths.mjs)`,
        );
    if (termsAllowed) continue;
    for (const { line, id } of scan(data))
      out.push(`${file}:${line}: banned term ${id}; remove it from this public file (see scripts/banned-terms.json)`);
  }
  return out;
}

/**
 * Runs the check and returns its exit code. Every failure names its reason on both streams (KB-BT1: a gate once saw
 * exit 1 and nothing else): the problems on stderr with a summary line on stdout and stderr, or the error that stopped
 * the scan (git ls-files failing on a locked index, say). The exit code is set, never `process.exit`, so nothing
 * written is cut off.
 */
export function main({ scanAll = scanRepo, log = console.log, error = console.error } = {}) {
  let problems;
  try {
    problems = scanAll();
  } catch (failure) {
    const reason = `check:banned-terms could not finish the scan: ${failure?.stack ?? failure}`;
    error(reason);
    log(reason.split('\n')[0]);
    return 1;
  }
  if (problems.length) {
    const summary = `check:banned-terms: ${problems.length} problem(s) in tracked files`;
    error(`${problems.join('\n')}\n${summary}`);
    log(`${summary}; the list is on stderr`);
    return 1;
  }
  log('banned terms: none in tracked files');
  return 0;
}

/** Files that differ from origin/main (committed, staged, edited, or new and untracked), skipping deleted ones. */
export function changedFiles(git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28 }).toString()) {
  const names = (args) => git(args).split('\0').filter(Boolean);
  return [
    ...new Set([
      ...names(['diff', '--name-only', '-z', '--diff-filter=d', 'origin/main']),
      ...names(['ls-files', '-z', '--others', '--exclude-standard']),
    ]),
  ];
}

/** The files the command line selects: `--files a b` (every argument after it), `--changed`, or undefined for all tracked files. */
export function selectFiles(args, changed = changedFiles) {
  const i = args.indexOf('--files');
  if (i >= 0 && i === args.length - 1) throw new Error('--files needs at least one path');
  if (i < 0 && !args.includes('--changed')) return undefined;
  const named = i < 0 ? [] : args.slice(i + 1);
  return [...new Set([...named, ...(args.includes('--changed') ? changed() : [])])];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let files, usage;
  try {
    files = selectFiles(process.argv.slice(2));
  } catch (failure) {
    usage = failure;
  }
  // A usage error ends with code 2 by the event loop, as every check does (KB-OWN-EXIT2).
  if (usage) {
    console.error(`check:banned-terms: ${usage.message}`);
    process.exitCode = 2;
  } else process.exitCode = main({ scanAll: () => scanRepo(undefined, files, files !== undefined) });
}
