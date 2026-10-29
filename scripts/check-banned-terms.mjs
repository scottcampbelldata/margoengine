// Fails when a tracked file's path, a tracked text file, or the text a tracked PDF shows, contains a term from
// scripts/banned-terms.json: CAD
// import and CAD tooling are not part of this repository (AGENTS.md), so their package, file, function and format names
// must not come back. The list holds hashes, never the words. To fix a hit: remove the text from the public file (for a
// PDF, from the page it is printed from, then print it again). A new allow entry needs a reason and a review.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    for (const form of new Set([w, w.replaceAll('-', '')])) if (TOKENS.has(hash(form))) found.push(hash(form));
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

/** Scans every tracked file; returns `path:line: banned term <id>` messages. */
export function scanRepo() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString()
    .split('\0')
    .filter(Boolean);
  const out = [];
  for (const file of files) {
    for (const id of new Set(hitsInPath(file)))
      out.push(`${file}: banned term ${id} in the file or folder name; rename or remove it`);
    if (allowed(file)) continue;
    let data;
    try {
      data = readFileSync(resolve(root, file));
    } catch {
      continue;
    }
    if (file.endsWith('.pdf')) {
      const text = pdfText(data);
      if (text === null) out.push(`${file}: no readable text; the banned-terms check must be able to read every PDF`);
      else
        for (const { id } of scan(Buffer.from(text)))
          out.push(`${file}: banned term ${id} in the printed text; remove it from the page it is printed from`);
      continue;
    }
    for (const { line, id } of scan(data))
      out.push(`${file}:${line}: banned term ${id}; remove it from this public file (see scripts/banned-terms.json)`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = scanRepo();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('banned terms: none in tracked files');
}
