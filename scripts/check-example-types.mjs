// `npm run check:examples-types`: type-checks the examples against the built package types, so a wrong engine call in a
// demo fails here instead of in a browser. `npm run typecheck` covers packages/ only. Each project in
// scripts/support/example-projects.mjs is one `tsc --noEmit -p` run; the projects run side by side, each under a hard
// time limit (its whole process tree is ended at it).
//   node scripts/check-example-types.mjs                       every project
//   node scripts/check-example-types.mjs --projects=js,vite    only those (check:merge passes the ones a change can affect)
// Needs `npm run build:packages` first: the packages are read through their dist/*.d.ts files.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitOnHelp } from './support/help.mjs';
import { margoError } from '../packages/shared/errors.js';
import { PROJECTS } from './support/example-projects.mjs';
import { killTree } from './gpu-lock.mjs';

const root = resolve(import.meta.dirname, '..');

/** Hard limit for one project, in minutes. The slowest takes a few seconds. */
export const PROJECT_MINUTES = 5;

/**
 * Runs the named projects (all when `ids` is empty) side by side. Resolves `[{ id, ok, seconds, output }]`.
 * `cwd` is the repository root and `projects` the list to pick from (tests pass their own).
 */
export async function checkExampleTypes({
  ids = [],
  cwd = root,
  projects = PROJECTS,
  limitMs = PROJECT_MINUTES * 60_000,
} = {}) {
  const unknown = ids.filter((id) => !projects.some((p) => p.id === id));
  if (unknown.length)
    throw margoError(
      'EXAMPLE_TYPES_PROJECT_UNKNOWN',
      `unknown example project ${unknown.join(', ')}; use some of ${projects.map((p) => p.id).join(', ')}`,
    );
  const picked = ids.length ? projects.filter((p) => ids.includes(p.id)) : projects;
  const compiler = resolve(cwd, 'node_modules/typescript/bin/tsc');
  if (!existsSync(compiler))
    throw margoError(
      'EXAMPLE_TYPES_NO_COMPILER',
      `${compiler} is missing; run npm ci in this checkout`,
    );
  if (!existsSync(resolve(cwd, 'packages/core/dist/index.d.ts')))
    throw margoError('EXAMPLE_TYPES_NOT_BUILT', 'packages/core/dist is missing; run npm run build:packages first');
  return Promise.all(picked.map(({ id, config }) => runProject({ id, config, cwd, compiler, limitMs })));
}

/** One tsc run with its output kept (the projects run side by side) and a hard limit that ends its process tree. */
function runProject({ id, config, cwd, compiler, limitMs }) {
  return new Promise((done) => {
    const started = performance.now(),
      chunks = [],
      child = spawn(process.execPath, [compiler, '-p', config, '--noEmit', '--pretty', 'false'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, limitMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => chunks.push(chunk));
    const finish = (code) => {
      clearTimeout(timer);
      done({
        id,
        config,
        ok: !timedOut && code === 0,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        output: Buffer.concat(chunks).toString(),
        message: timedOut
          ? `type-check of the ${id} examples hung: no result after ${Math.round(limitMs / 1000)} s, killed`
          : undefined,
      });
    };
    child.once('error', () => finish(1));
    child.once('close', finish);
  });
}

export const USAGE = `usage: node scripts/check-example-types.mjs [--projects=<id>,<id>]

Type-checks the examples against the built package types (run npm run build:packages first).
Projects: ${PROJECTS.map((p) => p.id).join(', ')}.`;

async function main() {
  const given = process.argv.find((a) => a.startsWith('--projects='));
  const started = performance.now();
  const results = await checkExampleTypes({ ids: given ? given.slice(11).split(',').filter(Boolean) : [] });
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} (${r.config}) ${r.seconds} s`);
    if (!r.ok) console.log(r.output.trimEnd() || r.message);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length
      ? `Example type check FAILED in ${failed.map((r) => r.id).join(', ')}.`
      : `Example type check passed for ${results.length} project${results.length === 1 ? '' : 's'} in ${Math.round((performance.now() - started) / 100) / 10} s.`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(USAGE);
  await main();
}
