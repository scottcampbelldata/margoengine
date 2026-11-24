// @ts-check
// `margo-convert sequence`: a folder of per-frame mesh files (a meshed fluid or fracture bake, such as Blender's OBJ
// export with Animation on, one file a frame) to one geometry cache (.mgc) for GeometryCachePlayer of
// @margoengine/animation/geometry-cache. Frames are ordered by the last number in their names, read one at a time and
// streamed out chunk by chunk, so a long bake never sits in memory whole. Consecutive frames of one topology share a
// chunk; a change of topology (as a fluid surface has every frame) starts a new one.
import { createWriteStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { streamMeshSequence } from '@margoengine/animation/geometry-cache';
import { parseOBJ, parsePLY, parseSTL } from '@margoengine/loaders';

/** Extensions read as frames. */
export const SEQUENCE_FORMATS = ['.obj', '.ply', '.stl'];

export const SEQUENCE_USAGE = `Usage:
  margo-convert sequence <folder> [--out sequence.mgc] [--fps 24] [--chunk <frames>] [--no-normals] [--no-uvs]

sequence reads every .obj, .ply or .stl file in <folder>, ordered by the last number in each name (fluid_0001.obj,
fluid_0002.obj, ...), and writes one geometry cache for GeometryCachePlayer (@margoengine/animation/geometry-cache).
Frames of one topology share a chunk; a frame whose mesh changes starts a new one.

Options:
  --out <file>      output file (default <folder name>.mgc beside the folder)
  --fps <n>         frames a second (default 24)
  --chunk <n>       most frames a chunk (default the fps rounded)
  --no-normals      leave the files' normals out (the player computes smooth ones)
  --no-uvs          leave the files' UVs out
  --quiet           print nothing on success
  --help            this text`;

/**
 * The frame files of a folder, in frame order: sorted by the last run of digits in each name, then by name.
 * @param {string} folder
 * @returns {string[]} full paths
 */
export function sequenceFiles(folder) {
  const number = (/** @type {string} */ name) => {
    const all = name.slice(0, -extname(name).length).match(/\d+/g);
    return all ? Number(all[all.length - 1]) : -1;
  };
  return readdirSync(folder)
    .filter((name) => SEQUENCE_FORMATS.includes(extname(name).toLowerCase()) && statSync(join(folder, name)).isFile())
    .sort((a, b) => number(a) - number(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => join(folder, name));
}

/**
 * One frame file as a mesh-sequence frame: its triangles, positions and (unless left out) normals and UVs.
 * @param {string} file
 * @param {{ normals?: boolean, uvs?: boolean }} [options]
 * @returns {Promise<import('@margoengine/animation/geometry-cache').MeshSequenceFrame>}
 */
export async function readSequenceFrame(file, options = {}) {
  const bytes = new Uint8Array(readFileSync(file)),
    ext = extname(file).toLowerCase(),
    mesh = ext === '.obj' ? await parseOBJ(bytes) : ext === '.ply' ? parsePLY(bytes) : parseSTL(bytes);
  if (mesh.kind !== 'mesh' || !mesh.indices?.length)
    throw new RangeError(`${file} holds no triangles; export the frames as meshes`);
  /** @type {import('@margoengine/animation/geometry-cache').MeshSequenceFrame} */
  const frame = { positions: mesh.positions, indices: mesh.indices };
  if (options.normals !== false && mesh.normals?.length === mesh.positions.length) frame.normals = mesh.normals;
  if (options.uvs !== false && mesh.uvs?.length === (mesh.positions.length / 3) * 2) frame.uvs = mesh.uvs;
  return frame;
}

/**
 * Converts the frame files of a folder to one geometry cache.
 * @param {string} folder
 * @param {string} out output path
 * @param {{ fps?: number, maxChunkFrames?: number, normals?: boolean, uvs?: boolean }} [options]
 * @returns {Promise<{ frames: number, bytes: number }>}
 */
export async function convertSequence(folder, out, options = {}) {
  const files = sequenceFiles(folder),
    fps = options.fps ?? 24;
  if (!files.length)
    throw new RangeError(`${folder} holds no ${SEQUENCE_FORMATS.join(', ')} frames; pass the bake's folder`);
  async function* frames() {
    for (const file of files) yield readSequenceFrame(file, options);
  }
  const stream = createWriteStream(out);
  let bytes = 0;
  try {
    for await (const part of streamMeshSequence(fps, frames(), { maxChunkFrames: options.maxChunkFrames })) {
      bytes += part.length;
      if (!stream.write(part)) await new Promise((done) => stream.once('drain', done));
    }
  } finally {
    await new Promise((done, fail) =>
      stream.end((/** @type {unknown} */ error) => (error ? fail(error) : done(undefined))),
    );
  }
  return { frames: files.length, bytes };
}

/**
 * Runs `margo-convert sequence`.
 * @param {string[]} argv arguments after `sequence`
 * @returns {Promise<number>} the exit code
 */
export async function runSequence(argv) {
  /** @type {ReturnType<typeof parseArgs>} */ let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        out: { type: 'string' },
        fps: { type: 'string' },
        chunk: { type: 'string' },
        normals: { type: 'boolean' },
        uvs: { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    console.error(`margo-convert sequence: ${error instanceof Error ? error.message : error}\n\n${SEQUENCE_USAGE}`);
    return 1;
  }
  const values = /** @type {Record<string, any>} */ (parsed.values);
  if (values.help) {
    console.log(SEQUENCE_USAGE);
    return 0;
  }
  const folder = parsed.positionals[0];
  if (!folder || parsed.positionals.length > 1) {
    console.error(`margo-convert sequence: pass one folder of frames\n\n${SEQUENCE_USAGE}`);
    return 1;
  }
  const fps = values.fps === undefined ? 24 : Number(values.fps),
    chunk = values.chunk === undefined ? undefined : Number(values.chunk);
  if (!(fps > 0 && Number.isFinite(fps))) {
    console.error('margo-convert sequence: --fps must be a number above 0');
    return 1;
  }
  const out = values.out ?? `${folder.replace(/[\\/]+$/, '')}.mgc`;
  try {
    const { frames, bytes } = await convertSequence(folder, out, {
      fps,
      maxChunkFrames: chunk,
      normals: values.normals,
      uvs: values.uvs,
    });
    if (!values.quiet) console.log(`${out}: ${frames} frames at ${fps} fps, ${bytes} bytes`);
    return 0;
  } catch (error) {
    console.error(`margo-convert sequence: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
