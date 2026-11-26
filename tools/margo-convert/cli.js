#!/usr/bin/env node
// @ts-check
// margo-convert: `build` and `optimize` run the asset pipeline (pipeline/cli.js), `thumbnail` renders a model
// (pipeline/thumbnail.js), `sequence` writes a mesh sequence as a geometry cache (pipeline/sequence.js), `playable` writes one
// self-contained playable-ad HTML file (pipeline/playable.js), `mobile` writes a Capacitor project (pipeline/mobile.js); anything else prints the usage
// (exit 0 for --help, 1 otherwise).
const mode = process.argv[2];
const { run, USAGE } = await import('./pipeline/cli.js');
if (mode === 'build' || mode === 'optimize') process.exitCode = await run(mode, process.argv.slice(3));
else if (mode === 'thumbnail') {
  const { runThumbnail } = await import('./pipeline/thumbnail.js');
  process.exitCode = await runThumbnail(process.argv.slice(3));
} else if (mode === 'sequence') {
  const { runSequence } = await import('./pipeline/sequence.js');
  process.exitCode = await runSequence(process.argv.slice(3));
} else if (mode === 'playable') {
  const { runPlayable } = await import('./pipeline/playable.js');
  process.exitCode = await runPlayable(process.argv.slice(3));
} else if (mode === 'mobile') {
  const { runMobile } = await import('./pipeline/mobile.js');
  process.exitCode = await runMobile(process.argv.slice(3));
} else if (mode === '--help' || mode === '-h') console.log(USAGE);
else {
  console.error(USAGE);
  process.exitCode = 1;
}
