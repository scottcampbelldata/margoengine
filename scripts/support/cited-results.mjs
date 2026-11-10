import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// Every docs/whitepaper/results/<name>.json that a tracked markdown file links to must itself be tracked.
export function missingCitedResults(root) {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 << 20 });
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const tracked = new Set(files);
  const missing = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\]\(([^)#\s]*\/)?(results\/[\w.-]+\.json)[)#]/g)) {
      const path = posix.normalize(posix.join(posix.dirname(file), m[1] ?? '', m[2]));
      if (path.startsWith('docs/whitepaper/results/') && !tracked.has(path)) missing.push(`${file} cites ${path}`);
    }
  }
  return missing;
}

export function assertCitedResultsTracked(root) {
  const missing = missingCitedResults(root);
  if (missing.length)
    throw new Error(`Docs cite results files that are not tracked; commit the measurement:\n${missing.join('\n')}`);
}
