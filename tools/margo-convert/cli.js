#!/usr/bin/env node
// @ts-check
// margo-convert: `build` and `optimize` run the asset pipeline (pipeline/cli.js); anything else prints the usage
// (exit 0 for --help, 1 otherwise).
const mode = process.argv[2];
const { run, USAGE } = await import('./pipeline/cli.js');
if (mode === 'build' || mode === 'optimize') process.exitCode = await run(mode, process.argv.slice(3));
else if (mode === '--help' || mode === '-h') console.log(USAGE);
else {
  console.error(USAGE);
  process.exitCode = 1;
}
