// @ts-check
// The model optimiser: read a GLB or .gltf, run the passes a preset asks for, write a GLB.
import { readModel, writeModel, Unsupported } from './gltf-io.js';
import { dedupe, measure, mergeMeshes, newStats, prune, quantize, weld } from './passes.js';
import { processModelTextures } from './textures.js';

/** @typedef {import('./passes.js').ModelStats} ModelStats */
/** @typedef {import('./passes.js').QuantizeOptions} QuantizeOptions */

/**
 * What the model passes do. Every field is optional; the preset supplies defaults.
 * @typedef {object} ModelOptions
 * @property {boolean} [prune] Remove unused attributes, meshes, materials, textures, images and nodes.
 * @property {boolean} [pruneEmptyNodes] Also remove nodes that carry nothing (engines may use them as sockets).
 * @property {boolean} [dedupe] Merge identical images, textures, materials and meshes.
 * @property {boolean} [weld] Merge identical vertices and drop degenerate triangles.
 * @property {boolean} [merge] Merge static meshes that share a material into one primitive.
 * @property {QuantizeOptions|false} [quantize] Quantise vertex attributes (KHR_mesh_quantization).
 * @property {boolean} [meshopt] Compress with EXT_meshopt_compression (a reader needs the extension).
 */

/**
 * Result of optimising one model.
 * @typedef {object} ModelResult
 * @property {Uint8Array} glb the optimised GLB, or the unchanged input when `skipped`
 * @property {ModelStats} stats
 * @property {number} compressedViews buffer views written with meshopt
 * @property {string|null} skipped why the model was passed through unchanged, or null
 */

/** @param {Uint8Array} bytes */
const isGLB = (bytes) =>
  bytes.length > 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;

/**
 * Optimises a model. A file that uses an extension the optimiser does not rewrite is returned unchanged with
 * `skipped` saying why.
 * @param {Uint8Array} bytes GLB or glTF JSON
 * @param {ModelOptions} options
 * @param {{resolve?: (uri: string) => Uint8Array, textures?: {preset: import('./presets.js').TexturePreset, sharp: any}}} [io]
 *   `resolve` reads the external files of a .gltf; `textures` resizes and re-encodes the model's images (`sharp` is the
 *   sharp module, or null for PNG only); without it images are kept as they are
 * @returns {Promise<ModelResult>}
 */
export async function optimizeModel(bytes, options, io = {}) {
  const stats = newStats();
  /** @type {import('./gltf-io.js').Model} */ let model;
  try {
    model = readModel(bytes, io.resolve);
  } catch (error) {
    if (error instanceof Unsupported) return { glb: bytes, stats, compressedViews: 0, skipped: error.message };
    throw error;
  }
  const before = measure(model);
  stats.verticesBefore = before.vertices;
  stats.trianglesBefore = before.triangles;
  if (options.prune !== false) prune(model, stats, { emptyNodes: options.pruneEmptyNodes });
  if (options.dedupe !== false) dedupe(model, stats);
  if (options.weld !== false) weld(model, stats);
  if (options.merge) mergeMeshes(model, stats);
  if (options.prune !== false) prune(model, stats, { emptyNodes: options.pruneEmptyNodes });
  if (options.dedupe !== false) dedupe(model, stats);
  if (options.quantize) quantize(model, options.quantize, stats);
  if (io.textures) await processModelTextures(model, io.textures.preset, io.textures.sharp, stats);
  const after = measure(model);
  stats.verticesAfter = after.vertices;
  stats.trianglesAfter = after.triangles;
  const { glb, compressedViews } = writeModel(model, { meshopt: options.meshopt === true });
  // A tiny file can grow (meshopt's fallback buffer, quantisation nodes); never hand back more than came in.
  if (glb.length >= bytes.length && isGLB(bytes)) {
    stats.notes.push(`optimised ${glb.length} bytes is not smaller than the input's ${bytes.length}; kept the input`);
    return { glb: bytes, stats, compressedViews: 0, skipped: null };
  }
  return { glb, stats, compressedViews, skipped: null };
}
