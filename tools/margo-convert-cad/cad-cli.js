#!/usr/bin/env node
// @ts-check
// The CAD converter, bin margo-convert-cad: margo-convert-cad part.step [part.glb] [options] (STEP / IGES / SAT / XT / JT -> GLB).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { convert, formatOf } from './convert.js';
import { sameFile } from './pipeline/paths.js';

const usage = `Usage: margo-convert-cad <input.step|.stp|.iges|.igs|.sat|.x_t|.x_b|.jt> [output.glb] [options]

  --linear-deflection <mm>   largest chord-to-surface distance (default: 0.1% of each body's size, as loadCAD)
  --angular-deflection <deg> largest turn between neighbouring edge samples (default 28.65, as loadCAD)
  --merge                    one node per material, world-space geometry (no assembly tree, no instancing)
  --no-instancing            write every repeated part as its own mesh
  --edges                    bake feature edges into mesh extras.featureEdges (machinery's featureEdges)
  --edge-angle <deg>         dihedral angle for --edges (default 30, as FeatureEdges)
  --quiet                    print nothing on success
Output: binary glTF 2.0 in metres (each format converts from its own unit), axes unchanged as with loadCAD.
.brep files (the native format of the earlier importer's kernel) are not read: export STEP from the CAD tool instead.`;

/** A failure the command reports in one line, then ends with exit code 1. */
class CliError extends Error {}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new CliError(`margo-convert-cad: ${message}`);
}

const options = /** @type {const} */ ({
  'linear-deflection': { type: 'string' },
  'angular-deflection': { type: 'string' },
  merge: { type: 'boolean' },
  instancing: { type: 'boolean' },
  edges: { type: 'boolean' },
  'edge-angle': { type: 'string' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
});
const args = () => {
  try {
    return parseArgs({ allowPositionals: true, allowNegative: true, options });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : error}\n\n${usage}`);
  }
};
async function main() {
  const { values, positionals } = args();
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length < 1 || positionals.length > 2)
    fail(`expected an input file and an optional output file\n\n${usage}`);

  /** @param {'linear-deflection'|'angular-deflection'|'edge-angle'} name @returns {number|undefined} */
  const number = (name) => {
    const text = values[name];
    if (text === undefined) return undefined;
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value)) fail(`--${name} needs a number, got ${text}`);
    return value;
  };

  const [input, output = input.replace(/\.[^./\\]+$/, '') + '.glb'] = positionals;
  if (sameFile(input, output)) fail('output would overwrite the input; choose another output path');

  try {
    const data = readFileSync(input),
      started = performance.now();
    const { glb, stats } = await convert(data, formatOf(input), {
      linearDeflection: number('linear-deflection'),
      angularDeflection: number('angular-deflection'),
      merge: values.merge === true,
      instancing: values.instancing !== false,
      edges: values.edges ? (number('edge-angle') ?? 30) : undefined,
    });
    writeFileSync(output, glb);
    if (!values.quiet) {
      const kB = (/** @type {number} */ n) => `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kB`,
        ms = (/** @type {number} */ n) => `${Math.round(n).toLocaleString('en-US')} ms`;
      console.log(`${input} (${kB(data.length)}) -> ${output} (${kB(glb.length)})`);
      if (stats.failedFaces) console.log(`  ${stats.failedFaces} faces the kernel could not mesh were left out`);
      console.log(
        `  ${stats.parts} parts, ${stats.meshes} meshes (${stats.instanced} instanced), ${stats.triangles.toLocaleString('en-US')} triangles${values.edges ? `, ${stats.edges.toLocaleString('en-US')} edge segments` : ''}`,
      );
      console.log(
        `  tessellation ${ms(stats.tessellateMs)}, write ${ms(stats.writeMs)}, total ${ms(performance.now() - started)}`,
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  console.error(error instanceof CliError ? error.message : error);
  process.exitCode = 1;
});
