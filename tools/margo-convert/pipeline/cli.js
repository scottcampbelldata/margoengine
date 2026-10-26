// @ts-check
// Command line of `margo-convert build` and `margo-convert optimize`.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { build, optimizeModelFile } from './build.js';
import { PRESET_NAMES, PRESETS, preset as presetFor } from './presets.js';

const presetList = PRESET_NAMES.map((n) => `${n.padEnd(7)} ${PRESETS[n].summary}`).join('\n    ');

export const USAGE = `Usage:
  margo-convert build <folder|file> [--out dist] [--preset web] [options]
  margo-convert optimize <model.glb|.gltf|.step> [output.glb] [--preset web] [options]

build walks a folder (or takes one file), optimises every model, texture and audio file for the preset, and writes
the results with ${'margo-manifest.json'} (hashes and sizes) and margo-size-report.txt to --out (default ./dist).
Inputs whose content and settings did not change since the last build are skipped.
optimize does the same for one model and writes one GLB (default <name>.optimized.glb).

Options:
  --preset <name>    ${PRESET_NAMES.join(' | ')} (default web)
  --out <folder>     build: output folder (default dist)
  --force            build: ignore the previous manifest and rebuild everything
  --hash-names       build: put the first 8 hex digits of the content hash in output file names
  --json             build: print the manifest instead of the size report
  --quiet            print nothing on success
  --help             this text

Presets:
    ${presetList}`;

/**
 * Runs `build` or `optimize`.
 * @param {'build'|'optimize'} mode
 * @param {string[]} argv arguments after the mode
 * @returns {Promise<number>} the exit code
 */
export async function run(mode, argv) {
  const fail = (/** @type {string} */ message) => {
    console.error(`margo-convert ${mode}: ${message}`);
    return 1;
  };
  /** @type {ReturnType<typeof parseArgs>} */ let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        preset: { type: 'string' },
        out: { type: 'string' },
        force: { type: 'boolean' },
        'hash-names': { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);
  }
  const values = /** @type {Record<string, any>} */ (parsed.values),
    positionals = parsed.positionals;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const presetName = values.preset ?? 'web';
  try {
    presetFor(presetName);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (mode === 'build') {
    if (positionals.length !== 1) return fail(`expected one folder or file to build\n\n${USAGE}`);
    try {
      const { manifest, report } = await build({
        input: positionals[0],
        outDir: values.out ?? 'dist',
        preset: presetName,
        force: values.force === true,
        hashNames: values['hash-names'] === true,
        log: values.quiet || values.json ? undefined : (line) => console.log(line),
      });
      if (values.json) console.log(JSON.stringify(manifest, null, 2));
      else if (!values.quiet) console.log(`\n${report}`);
      return manifest.totals.failed ? 1 : 0;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (positionals.length < 1 || positionals.length > 2)
    return fail(`expected a model and an optional output file\n\n${USAGE}`);
  const [
    input,
    output = join(dirname(positionals[0]), `${basename(positionals[0], extname(positionals[0]))}.optimized.glb`),
  ] = positionals;
  if (output === input) return fail('output would overwrite the input');
  try {
    const data = new Uint8Array(readFileSync(input));
    const result = await optimizeModelFile(input, data, presetFor(presetName));
    if (result.skipped) return fail(`${input} was not optimised: ${result.skipped}`);
    writeFileSync(output, result.glb);
    if (!values.quiet) {
      const s = result.stats;
      console.log(
        `${input} (${data.length.toLocaleString('en-US')} bytes) -> ${output} (${result.glb.length.toLocaleString('en-US')} bytes, ${(((data.length - result.glb.length) / data.length) * 100).toFixed(1)}% smaller)`,
      );
      console.log(
        `  vertices ${s.verticesBefore.toLocaleString('en-US')} -> ${s.verticesAfter.toLocaleString('en-US')}, triangles ${s.trianglesBefore.toLocaleString('en-US')} -> ${s.trianglesAfter.toLocaleString('en-US')}, ${result.compressedViews} meshopt views`,
      );
      for (const note of s.notes) console.log(`  ${note}`);
    }
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
