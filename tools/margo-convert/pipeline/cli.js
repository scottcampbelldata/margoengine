// @ts-check
// Command line of `margo-convert build` and `margo-convert optimize`.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { build, optimizeModelFile, withOverrides } from './build.js';
import { sameFile } from './paths.js';
import { PRESET_NAMES, PRESETS, preset as presetFor } from './presets.js';
import { loadSharp } from './textures.js';

const presetList = PRESET_NAMES.map((n) => `${n.padEnd(7)} ${PRESETS[n].summary}`).join('\n    ');

export const USAGE = `Usage:
  margo-convert build <folder|file> [--out dist] [--preset web] [options]
  margo-convert optimize <model.glb|.gltf|.step> [output.glb] [--preset web] [options]

build walks a folder (or takes one file), optimises every model, texture and audio file for the preset, and writes
the results with margo-manifest.json (hashes and sizes) and margo-size-report.txt to --out (default ./dist).
Inputs whose content and settings did not change since the last build are skipped.
optimize does the same for one model and writes one GLB (default <name>.optimized.glb).

Options:
  --preset <name>           ${PRESET_NAMES.join(' | ')} (default web)
  --out <folder>            build: output folder (default dist)
  --max-texture <px>        largest texture side (default from the preset; images are never enlarged)
  --texture-format <name>   webp | avif | png | jpeg | keep (default from the preset)
  --texture-quality <1-100> lossy quality (default from the preset)
  --mipmaps                 build: also write a DDS with a full mip chain for every standalone texture
  --no-sharp                ignore an installed sharp: PNG textures only
  --no-ffmpeg               ignore an installed ffmpeg: no Ogg Vorbis
  --force                   build: ignore the previous manifest and rebuild everything
  --hash-names              build: put the first 8 hex digits of the content hash in output file names
  --json                    build: print the manifest instead of the size report
  --quiet                   print nothing on success
  --help                    this text

Presets:
    ${presetList}`;

const TEXTURE_FORMATS = ['webp', 'avif', 'png', 'jpeg', 'keep'];

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
      allowNegative: true,
      options: {
        preset: { type: 'string' },
        out: { type: 'string' },
        'max-texture': { type: 'string' },
        'texture-format': { type: 'string' },
        'texture-quality': { type: 'string' },
        mipmaps: { type: 'boolean' },
        sharp: { type: 'boolean' },
        ffmpeg: { type: 'boolean' },
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
  /** @type {Partial<import('./presets.js').TexturePreset>} */
  const texture = {};
  const whole = (/** @type {string} */ name, /** @type {number} */ min, /** @type {number} */ max) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new RangeError(`--${name} needs a whole number from ${min} to ${max}, got ${values[name]}`);
    return n;
  };
  try {
    if (values['max-texture'] !== undefined) texture.maxSize = whole('max-texture', 1, 16384);
    if (values['texture-quality'] !== undefined) texture.quality = whole('texture-quality', 1, 100);
    if (values['texture-format'] !== undefined) {
      if (!TEXTURE_FORMATS.includes(values['texture-format']))
        throw new RangeError(
          `--texture-format must be one of ${TEXTURE_FORMATS.join(', ')}, got ${values['texture-format']}`,
        );
      texture.format = values['texture-format'];
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const overrides = { texture };
  if (mode === 'build') {
    if (positionals.length !== 1) return fail(`expected one folder or file to build\n\n${USAGE}`);
    try {
      const { manifest, report } = await build({
        input: positionals[0],
        outDir: values.out ?? 'dist',
        preset: presetName,
        overrides,
        mipmaps: values.mipmaps === true,
        sharp: values.sharp !== false,
        ffmpeg: values.ffmpeg !== false,
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
  if (sameFile(input, output)) return fail('output would overwrite the input; choose another output path');
  try {
    const data = new Uint8Array(readFileSync(input));
    const sharp = values.sharp === false ? null : await loadSharp();
    const result = await optimizeModelFile(input, data, withOverrides(presetFor(presetName), overrides), { sharp });
    if (result.skipped) return fail(`${input} was not optimised: ${result.skipped}`);
    writeFileSync(output, result.glb);
    if (!values.quiet) {
      const s = result.stats;
      const n = (/** @type {number} */ v) => v.toLocaleString('en-US');
      console.log(
        `${input} (${n(data.length)} bytes) -> ${output} (${n(result.glb.length)} bytes, ${(((data.length - result.glb.length) / data.length) * 100).toFixed(1)}% smaller)`,
      );
      console.log(
        `  vertices ${n(s.verticesBefore)} -> ${n(s.verticesAfter)}, triangles ${n(s.trianglesBefore)} -> ${n(s.trianglesAfter)}, ${result.compressedViews} meshopt views`,
      );
      if (s.imageBytesBefore) console.log(`  images ${n(s.imageBytesBefore)} -> ${n(s.imageBytesAfter)} bytes`);
      for (const note of s.notes) console.log(`  ${note}`);
    }
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
