#!/usr/bin/env node
// @ts-check
// npx margo-convert part.step [part.glb] [options]: offline STEP / IGES / BREP -> GLB.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { convert, formatOf } from './convert.js';

const usage = `Usage: margo-convert <input.step|.stp|.iges|.igs|.brep> [output.glb] [options]

  --linear-deflection <mm>   largest chord-to-surface distance (default: 0.1% of the model size, as loadCAD)
  --angular-deflection <deg> largest angle between neighbouring facets (default 28.65, as loadCAD)
  --merge                    one node per material, world-space geometry (no assembly tree, no instancing)
  --no-instancing            write every repeated part as its own mesh
  --edges                    bake feature edges into mesh extras.featureEdges (machinery's featureEdges)
  --edge-angle <deg>         dihedral angle for --edges (default 30, as FeatureEdges)
  --units <mm|cm|m|in|ft>    units of a BREP file (default mm; STEP and IGES carry their own)
  --quiet                    print nothing on success
Output: binary glTF 2.0 in metres (STEP/IGES convert from their own unit), axes unchanged as with loadCAD.`;

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`margo-convert: ${message}`);
  process.exit(1);
}

const options = /** @type {const} */ ({
  'linear-deflection': { type: 'string' },
  'angular-deflection': { type: 'string' },
  merge: { type: 'boolean' },
  instancing: { type: 'boolean' },
  edges: { type: 'boolean' },
  'edge-angle': { type: 'string' },
  units: { type: 'string' },
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
const { values, positionals } = args();
if (values.help) {
  console.log(usage);
  process.exit(0);
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
if (output === input) fail('output would overwrite the input');
const units = values.units;
if (units !== undefined && units !== 'mm' && units !== 'cm' && units !== 'm' && units !== 'in' && units !== 'ft')
  fail('--units must be mm, cm, m, in or ft');

try {
  const data = readFileSync(input),
    started = performance.now();
  const { glb, stats } = await convert(data, formatOf(input), {
    linearDeflection: number('linear-deflection'),
    angularDeflection: number('angular-deflection'),
    merge: values.merge === true,
    instancing: values.instancing !== false,
    edges: values.edges ? (number('edge-angle') ?? 30) : undefined,
    units,
  });
  writeFileSync(output, glb);
  if (!values.quiet) {
    const kB = (/** @type {number} */ n) => `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kB`,
      ms = (/** @type {number} */ n) => `${Math.round(n).toLocaleString('en-US')} ms`;
    console.log(`${input} (${kB(data.length)}) -> ${output} (${kB(glb.length)})`);
    console.log(
      `  ${stats.parts} parts, ${stats.meshes} meshes (${stats.instanced} instanced), ${stats.triangles.toLocaleString('en-US')} triangles${values.edges ? `, ${stats.edges.toLocaleString('en-US')} edge segments` : ''}`,
    );
    console.log(
      `  OCCT load ${ms(stats.initMs)}, tessellation ${ms(stats.tessellateMs)}, write ${ms(stats.writeMs)}, total ${ms(performance.now() - started)}`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
