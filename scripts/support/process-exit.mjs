// KB-OWN-EXIT2: `process.exit` can hang a Node process for ever. It shuts the V8 platform down while the isolate is
// still alive, so a V8 background task waiting for a main-thread collection is never woken and the exit's join waits on
// it (KB-OWN-EXIT1, nodejs/node#54918). A script that ends by its event loop (`process.exitCode = code`, then nothing
// left to run) disposes the isolate first, which wakes such a task. This check finds every `process.exit(` call in the
// repository's tracked JavaScript and TypeScript: one is allowed only where the line says why the process must end at
// once (`// process.exit: <reason>`, such as a second Ctrl+C), and the files that still owe the change are listed in
// scripts/support/exit-owed.json, each to be fixed and taken off; a new file with a call fails, and so does a listed
// file that no longer has one.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * True when a line calls `process.exit(` with no `// process.exit: <reason>` on it. Comment text (a `//` tail, a line of
 * a block comment) and string literals (code a test hands to a child process) are not calls.
 */
export const unjustifiedExit = (line) =>
  !/^\s*(\*|\/\*)/.test(line) &&
  /\bprocess\.exit\s*\(/.test(line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '')) &&
  !/\/\/ process\.exit: \S/.test(line);

/** The files (repository paths, sorted) whose text calls process.exit without a reason. */
export function exitFiles(files, read) {
  return files.filter((file) => read(file).split(/\r?\n/).some(unjustifiedExit)).sort();
}

/** The tracked script and source files the check reads. */
export function trackedScripts(root) {
  return execFileSync('git', ['ls-files', '-z', '--', '*.js', '*.mjs', '*.cjs', '*.ts', '*.mts', '*.cts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  })
    .split('\0')
    .filter((f) => f && !f.endsWith('.d.ts') && !/(^|\/)(dist|vendor|node_modules)\//.test(f));
}

/** Failures of the repository against the owed list: new files that call process.exit and listed files that no longer do. */
export function exitFailures(found, owed) {
  const have = new Set(found),
    listed = new Set(owed);
  return [
    ...found
      .filter((f) => !listed.has(f))
      .map((f) => `${f} calls process.exit: set process.exitCode and let the event loop end (KB-OWN-EXIT2)`),
    ...owed
      .filter((f) => !have.has(f))
      .map((f) => `${f} no longer calls process.exit: take it off scripts/support/exit-owed.json`),
  ];
}

/**
 * The owed files as repository paths. exit-owed.json groups them under their top folder (`{"scripts": ["umbrella.mjs"]}`)
 * so it names no script by its path: scripts/support/affected-gpu.mjs follows a named path into the steps of the file
 * that names it, and the list is data this check compares against, not a script hygiene runs.
 */
export function owedFiles(root) {
  const { files } = JSON.parse(readFileSync(join(root, 'scripts/support/exit-owed.json'), 'utf8'));
  return Object.entries(files).flatMap(([top, list]) => list.map((file) => `${top}/${file}`));
}

export function assertNoProcessExit(root) {
  const owed = owedFiles(root),
    failures = exitFailures(
      exitFiles(trackedScripts(root), (f) => readFileSync(join(root, f), 'utf8')),
      owed,
    );
  if (failures.length) throw new Error(`process.exit check (KB-OWN-EXIT2):\n  ${failures.join('\n  ')}`);
}
