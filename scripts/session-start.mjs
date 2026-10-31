// SessionStart hook output: the stop orders (private/control.json in the main checkout) and AGENTS.md's rule sections.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const here = process.cwd();
let main = here;
try {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: here,
    encoding: 'utf8',
  }).trim();
  main = dirname(common);
} catch {}

try {
  console.log(`private/control.json:\n${readFileSync(resolve(main, 'private/control.json'), 'utf8')}`);
} catch {
  console.log('private/control.json: not found');
}

const rules = readFileSync(resolve(here, 'AGENTS.md'), 'utf8');
const start = rules.indexOf('## Before every push to main');
console.log(`AGENTS.md rules:\n${start >= 0 ? rules.slice(start) : rules}`);
