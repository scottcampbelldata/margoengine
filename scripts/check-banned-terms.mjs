// Fails when a tracked text file contains a term from scripts/banned-terms.json (the private CAD kernel's repo name
// and package paths, and a commercial kernel's name). The list holds hashes, never the words. To fix a hit: remove the
// text from the public file. A new allow entry needs a reason and a review.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const LIST = JSON.parse(readFileSync(resolve(root, 'scripts/banned-terms.json'), 'utf8'));
const hash = (word) => createHash('sha256').update(`margo-banned:${word}`).digest('hex').slice(0, 24);
const TOKENS = new Set(LIST.tokens),
  PAIRS = new Set(LIST.pairs);

/** The banned-term ids found in one line of text (the hash of each hit). */
export function hitsInLine(line) {
  const found = [];
  for (const [word] of line.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)*/gi)) {
    const w = word.toLowerCase();
    for (const form of new Set([w, w.replaceAll('-', '')])) if (TOKENS.has(hash(form))) found.push(hash(form));
  }
  for (const [pair] of line.matchAll(/[a-z0-9-]+\/[a-z0-9-]+/gi))
    if (PAIRS.has(hash(pair.toLowerCase()))) found.push(hash(pair.toLowerCase()));
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
    if (allowed(file)) continue;
    let data;
    try {
      data = readFileSync(resolve(root, file));
    } catch {
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
