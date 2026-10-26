#!/usr/bin/env node
// @ts-check
// margo-convert: `build` and `optimize` run the asset pipeline (pipeline/cli.js); anything else is the offline
// STEP / IGES / BREP -> GLB converter (cad-cli.js).
const mode = process.argv[2];
if (mode === 'build' || mode === 'optimize') {
  const { run } = await import('./pipeline/cli.js');
  process.exitCode = await run(mode, process.argv.slice(3));
} else await import('./cad-cli.js');
