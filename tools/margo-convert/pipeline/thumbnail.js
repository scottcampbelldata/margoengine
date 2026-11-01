// @ts-check
// `margo-convert thumbnail`: renders a model to PNG files with no page, through a WebGPU binding the user installs
// (this tool ships none: a binding is a large download that runs code when installed). Images decode with sharp, since
// Node has no createImageBitmap, and reach gltf-pro as raw pixels. Draco and KTX2 need Workers, so they are refused.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { splitGLB } from '@margoengine/exporters';
import { dataUri } from './gltf-io.js';
import { margoError, modelFile, sameFile } from './paths.js';
import { loadSharp } from './textures.js';

/** Where the camera looks from, as a direction from the model's centre. */
export const VIEWS = /** @type {Record<string, [number, number, number]>} */ ({
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.001],
  iso: [1, 0.8, 1],
});
const NEEDS_WORKERS = /** @type {Record<string, string>} */ ({
  KHR_draco_mesh_compression: 'Draco',
  KHR_texture_basisu: 'KTX2',
});
const MAX_SIZE = 4096;

/**
 * Reads a GLB or .gltf and what it names beside it.
 * @param {string} file
 * @returns {{doc: any, buffers: Uint8Array[]}}
 */
function readModelFile(file) {
  const bytes = new Uint8Array(readFileSync(file)),
    read = (/** @type {string} */ uri) =>
      dataUri(uri) ?? new Uint8Array(readFileSync(modelFile(dirname(file), decodeURIComponent(uri))));
  if (extname(file).toLowerCase() === '.glb') {
    const { json, bin } = splitGLB(bytes);
    return { doc: json, buffers: [bin ?? new Uint8Array(0)] };
  }
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  return {
    doc,
    buffers: (doc.buffers ?? []).map((/** @type {any} */ def) => (def.uri ? read(def.uri) : new Uint8Array(0))),
  };
}

/**
 * Refuses what cannot load here, before anything is installed.
 * @param {any} doc
 */
function assertLoadable(doc) {
  for (const name of [...(doc.extensionsRequired ?? []), ...(doc.extensionsUsed ?? [])])
    if (NEEDS_WORKERS[name])
      throw margoError(
        'unsupported',
        `this model uses ${NEEDS_WORKERS[name]} (${name}), whose decoder needs Workers a thumbnail run does not have. Export it uncompressed; margo-convert optimize then compresses it with meshopt, which decodes in Node`,
      );
}

/**
 * Every image in the model as raw RGBA, in the shape gltf-pro uploads directly.
 * @param {any} doc @param {Uint8Array[]} buffers @param {string} file @param {any} sharp
 */
async function decodeImages(doc, buffers, file, sharp) {
  const images = doc.images ?? [];
  if (!images.length) return [];
  if (!sharp)
    throw margoError(
      'unsupported',
      'this model has textures, and decoding them in Node needs sharp. Install sharp (npm i sharp) and do not pass --no-sharp',
    );
  return Promise.all(
    images.map(async (/** @type {any} */ image) => {
      /** @type {Uint8Array} */ let bytes;
      if (image.uri)
        bytes =
          dataUri(image.uri) ?? new Uint8Array(readFileSync(modelFile(dirname(file), decodeURIComponent(image.uri))));
      else {
        const view = doc.bufferViews[image.bufferView];
        bytes = buffers[view.buffer].subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      }
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        { width, height } = info;
      return { format: 'rgba8unorm', width, height, mipmaps: [{ width, height, data: new Uint8Array(data) }] };
    }),
  );
}

/**
 * Imports the WebGPU binding named by --gpu, from the user's project. It exports `create(args)`, as `webgpu` does, or
 * `gpu`, and optionally `globals`.
 * @param {string} name
 * @returns {Promise<{gpu: any, globals?: Record<string, unknown>}>}
 */
async function loadBinding(name) {
  const local = name.startsWith('.') || isAbsolute(name);
  /** @type {any} */ let module;
  try {
    module = local
      ? await import(pathToFileURL(resolve(name)).href)
      : await import(pathToFileURL(createRequire(join(process.cwd(), 'noop.js')).resolve(name)).href);
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error).code;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw margoError(
      'unsupported',
      `WebGPU binding ${name} is not installed. Install webgpu (npm i webgpu) or pass --gpu <module>`,
    );
  }
  const gpu = module.gpu ?? module.create?.([]);
  if (!gpu) throw margoError('unsupported', `module ${name} exports neither create nor gpu; pass a WebGPU binding`);
  return { gpu, globals: module.globals };
}

/**
 * Renders one model to one PNG per view.
 * @param {{input: string, out: string, size?: number, views?: string[], gpu?: string, sharp?: any}} options
 * @returns {Promise<string[]>} the files written
 */
export async function thumbnail({ input, out, size = 512, views = ['iso'], gpu = 'webgpu', sharp = null }) {
  const { doc, buffers } = readModelFile(input);
  assertLoadable(doc);
  const images = await decodeImages(doc, buffers, input, sharp),
    binding = await loadBinding(gpu),
    [{ Camera, Engine }, { parseGLTFAsync }, { createHeadlessCanvas, installGPU, toPNG }] = await Promise.all([
      import('@margoengine/core'),
      import('@margoengine/gltf-pro'),
      import('@margoengine/headless'),
    ]),
    installed = installGPU({ gpu: binding.gpu, globals: binding.globals });
  /** @type {any} */ let engine;
  /** @type {any} */ let model;
  try {
    engine = await Engine.create(createHeadlessCanvas({ width: size, height: size }), { backend: 'webgpu' });
    model = await parseGLTFAsync(engine, doc, buffers, images);
    const bounds = model.bounds,
      min = /** @type {[number, number, number]} */ ([bounds[0], bounds[1], bounds[2]]),
      max = /** @type {[number, number, number]} */ ([bounds[3], bounds[4], bounds[5]]),
      radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
      files = [];
    for (const view of views) {
      const camera = new Camera({
        position: VIEWS[view],
        target: [0, 0, 0],
        near: Math.max(radius * 0.01, 1e-4),
        far: Math.max(radius * 100, 1),
      });
      camera.fitToBoundingBox(min, max, { aspect: 1, duration: 0 });
      engine.render({ camera });
      const file = views.length === 1 ? out : join(dirname(out), `${basename(out, extname(out))}.${view}.png`);
      mkdirSync(dirname(resolve(file)), { recursive: true });
      writeFileSync(file, await toPNG(engine));
      files.push(file);
    }
    return files;
  } finally {
    model?.dispose();
    engine?.dispose();
    installed.dispose();
  }
}

/**
 * Runs `margo-convert thumbnail`.
 * @param {string[]} argv arguments after the mode
 * @returns {Promise<number>} the exit code
 */
export async function runThumbnail(argv) {
  const fail = (/** @type {unknown} */ error) => {
    console.error(`margo-convert thumbnail: ${error instanceof Error ? error.message : error}`);
    return 1;
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        out: { type: 'string' },
        size: { type: 'string' },
        views: { type: 'string' },
        gpu: { type: 'string' },
        sharp: { type: 'boolean' },
        quiet: { type: 'boolean' },
      },
    });
    if (positionals.length !== 1) throw new TypeError('expected one model: margo-convert thumbnail <model.glb|.gltf>');
    const input = positionals[0],
      kind = extname(input).toLowerCase(),
      size = Number(values.size ?? 512),
      views = [...new Set((values.views ?? 'iso').split(','))],
      out = values.out ?? join(dirname(input), `${basename(input, extname(input))}.thumb.png`);
    if (kind !== '.glb' && kind !== '.gltf') throw new TypeError(`expected a .glb or .gltf file, got ${input}`);
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE)
      throw new RangeError(`--size needs a whole number from 1 to ${MAX_SIZE}, got ${values.size}`);
    for (const view of views)
      if (!Object.hasOwn(VIEWS, view))
        throw new RangeError(`unknown view ${view}: use ${Object.keys(VIEWS).join(', ')}`);
    if (sameFile(input, out)) throw new RangeError('output would overwrite the input; choose another --out');
    const sharp = values.sharp === false ? null : await loadSharp(),
      files = await thumbnail({ input, out, size, views, gpu: values.gpu, sharp });
    if (!values.quiet) for (const file of files) console.log(file);
    return 0;
  } catch (error) {
    return fail(error);
  }
}
