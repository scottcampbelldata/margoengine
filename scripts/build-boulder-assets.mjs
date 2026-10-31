// Builds examples/assets/boulder-robot.glb, the climber of the Boulder demo, from the Blender export.
//
// Step 1 (Blender 5.x, once; the source is examples/assets/source/skinning_ik/build_robot.py): run build_robot.py with
// VARIANT = "boulder" in a live Blender session. It authors the robot in its own scene and writes the raw GLB to
// test-results/boulder/boulder-robot.raw.glb (see examples/assets/source/skinning_ik/README.md).
// Step 2 (this script): margo-convert's `optimize` (web preset: quantised, meshopt compressed) writes the shipped GLB,
// then the Khronos validator checks it.
//
// Run: node scripts/build-boulder-assets.mjs [--input raw.glb] [--output out.glb]
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from '../tools/margo-convert/pipeline/cli.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));

/**
 * Optimizes a raw Boulder GLB and validates the result.
 * @param {{ input?: string, output?: string }} [paths]
 * @returns {Promise<{ input: string, output: string, rawBytes: number, bytes: number, errors: number, warnings: number }>}
 */
export async function buildBoulderAssets({
  input = resolve(root, 'test-results/boulder/boulder-robot.raw.glb'),
  output = resolve(root, 'examples/assets/boulder-robot.glb'),
} = {}) {
  mkdirSync(dirname(output), { recursive: true });
  const code = await run('optimize', [input, output, '--preset', 'web', '--quiet']);
  if (code !== 0) throw new Error(`margo-convert optimize failed (exit ${code}) for ${input}`);
  const report = await require('gltf-validator').validateBytes(new Uint8Array(readFileSync(output)), {
    uri: 'boulder-robot.glb',
    maxIssues: 1000,
  });
  return {
    input,
    output,
    rawBytes: statSync(input).size,
    bytes: statSync(output).size,
    errors: report.issues.numErrors,
    warnings: report.issues.numWarnings,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
  const result = await buildBoulderAssets({
    ...(values.input ? { input: resolve(values.input) } : {}),
    ...(values.output ? { output: resolve(values.output) } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.errors || result.warnings) process.exitCode = 1;
}
