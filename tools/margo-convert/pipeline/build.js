// @ts-check
// `margo-convert build`: walk a file or folder, optimise every model, texture and audio file for a preset, write the
// results and a manifest with hashes and sizes, and skip inputs whose content and settings have not changed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { findFfmpeg, processAudio } from './audio.js';
import { optimizeModel } from './optimize.js';
import { inside, modelFile } from './paths.js';
import { preset as presetFor } from './presets.js';
import { decodeRgba, encodeDDS, loadSharp, mipChain, processImage, roleOfName } from './textures.js';

/** Bumped when the pipeline's output for the same input and preset changes, so cached results are rebuilt. */
export const PIPELINE_VERSION = 2;
/** Name of the manifest, written to the output folder. */
export const MANIFEST_NAME = 'margo-manifest.json';
/** Name of the human-readable size report, written next to the manifest. */
export const REPORT_NAME = 'margo-size-report.txt';

const MODEL = new Set(['.glb', '.gltf']);
const TEXTURE = new Set(['.png', '.jpg', '.jpeg']);
const AUDIO = new Set(['.wav', '.mp3', '.ogg', '.opus', '.flac', '.m4a', '.aac']);
const IMAGE_EXTENSION = /** @type {Record<string, string>} */ ({
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
});

/** @param {Uint8Array|string} data @returns {string} */
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** @param {string} p @returns {string} path with forward slashes */
const posix = (p) => p.split(sep).join('/');

/**
 * One output file.
 * @typedef {object} OutputFile
 * @property {string} path relative to the output folder, forward slashes
 * @property {number} bytes
 * @property {string} sha256
 */

/**
 * What happened to one input.
 * @typedef {object} ManifestEntry
 * @property {string} source relative to the input folder, forward slashes
 * @property {'model'|'texture'|'audio'} kind
 * @property {number} sourceBytes
 * @property {string} sourceSha256 hash of the file (and of the external files a .gltf reads)
 * @property {string} settingsSha256 hash of the preset, tool version and encoders used
 * @property {'built'|'cached'|'copied'|'skipped'|'failed'} status
 *   `copied` means passed through unchanged; `skipped` means left out with a reason
 * @property {OutputFile[]} outputs
 * @property {string[]} notes what was done, or what could not be and why
 * @property {Record<string, number>} [stats] counts from the model passes
 */

/**
 * @typedef {object} Manifest
 * @property {string} tool
 * @property {number} pipeline
 * @property {string} preset
 * @property {Record<string, string|null>} encoders versions of the optional local tools found, null when absent
 * @property {{inputs: number, built: number, cached: number, copied: number, skipped: number, failed: number, inputBytes: number, outputBytes: number}} totals
 * @property {ManifestEntry[]} files
 */

/**
 * Options of {@link build}.
 * @typedef {object} BuildOptions
 * @property {string} input File or folder to build.
 * @property {string} outDir Output folder; created if missing.
 * @property {string} [preset] Preset name. Default `web`.
 * @property {{texture?: Partial<import('./presets.js').TexturePreset>, audio?: Partial<import('./presets.js').AudioPreset>}} [overrides]
 *   Replace single settings of the preset.
 * @property {boolean} [mipmaps] Also write a DDS file with a full mip chain for every standalone texture.
 * @property {boolean} [force] Ignore the previous manifest and rebuild everything.
 * @property {boolean} [hashNames] Put the first 8 hex digits of the content hash in output names, for long-lived caching.
 * @property {boolean} [sharp] `false` ignores an installed sharp (PNG textures only), to see what a machine without it gets.
 * @property {boolean} [ffmpeg] `false` ignores an installed ffmpeg.
 * @property {(line: string) => void} [log] Receives one progress line per input.
 * @property {AbortSignal} [signal] Stops the build between files.
 */

/** @param {string} dir @param {string[]} skip absolute folders to leave out @returns {string[]} */
function walk(dir, skip) {
  /** @type {string[]} */ const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (skip.includes(resolve(full))) continue;
    if (entry.isDirectory()) out.push(...walk(full, skip));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** The external files a .gltf reads (absolute paths). @param {string} file @returns {string[]} */
function gltfDependencies(file) {
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const uris = [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((/** @type {any} */ x) => x.uri)
    .filter((/** @type {any} */ u) => typeof u === 'string' && !u.startsWith('data:'));
  // A URI that leaves the model's folder is never read, not even to hash it; building the model then fails naming it.
  return uris.flatMap((/** @type {string} */ u) => {
    let path;
    try {
      path = decodeURIComponent(u.split('?')[0]);
    } catch {
      return []; // malformed percent escapes: readModel reports the URI when the model is built
    }
    return inside(dirname(file), path) ?? [];
  });
}

/**
 * A previous manifest's entries, or none when it is damaged: unreadable, the wrong shape, or naming an output that is
 * absolute or outside outDir. Such a manifest is only a cache, so the build starts over and deletes nothing it names.
 * @param {string} outDir @param {string} manifestPath @returns {ManifestEntry[]}
 */
function previousEntries(outDir, manifestPath) {
  let files;
  try {
    files = JSON.parse(readFileSync(manifestPath, 'utf8')).files;
  } catch {
    return [];
  }
  const valid =
    Array.isArray(files) &&
    files.every(
      (/** @type {any} */ e) =>
        e !== null &&
        typeof e === 'object' &&
        typeof e.source === 'string' &&
        Array.isArray(e.outputs) &&
        e.outputs.every(
          (/** @type {any} */ o) => o !== null && typeof o === 'object' && inside(outDir, o.path) !== undefined,
        ),
    );
  return valid ? files : [];
}

/**
 * A preset with single settings replaced.
 * @param {import('./presets.js').Preset} base @param {BuildOptions['overrides']} overrides @param {boolean} [mipmaps]
 * @returns {import('./presets.js').Preset}
 */
export function withOverrides(base, overrides, mipmaps) {
  return {
    ...base,
    texture: { ...base.texture, ...overrides?.texture, ...(mipmaps ? { mipmaps: true } : {}) },
    audio: { ...base.audio, ...overrides?.audio },
  };
}

/**
 * Builds a file or folder for a preset.
 * @param {BuildOptions} options
 * @returns {Promise<{manifest: Manifest, report: string}>}
 */
export async function build(options) {
  const presetName = options.preset ?? 'web';
  const preset = withOverrides(presetFor(presetName), options.overrides, options.mipmaps);
  const input = resolve(options.input),
    outDir = resolve(options.outDir);
  if (!existsSync(input)) throw new Error(`input ${options.input} does not exist`);
  const isDir = statSync(input).isDirectory();
  const base = isDir ? input : dirname(input);
  if (isDir && (outDir === input || input.startsWith(outDir + sep)))
    throw new RangeError('the output folder would contain the input folder; choose another --out');
  mkdirSync(outDir, { recursive: true });
  const files = isDir ? walk(input, [outDir]) : [input];

  // Files a .gltf pulls in are part of that model, not separate inputs.
  /** @type {Set<string>} */ const consumed = new Set();
  for (const f of files) if (extname(f).toLowerCase() === '.gltf') for (const d of gltfDependencies(f)) consumed.add(d);

  const sharp = options.sharp === false ? null : await loadSharp();
  const ffmpeg = options.ffmpeg === false ? null : findFfmpeg();
  const encoders = {
    sharp: sharp ? (sharp.versions?.sharp ?? 'unknown') : null,
    ffmpeg: ffmpeg ? ffmpeg.version : null,
  };
  const settingsSha256 = sha256(
    JSON.stringify({ pipeline: PIPELINE_VERSION, preset: presetName, body: preset, encoders }),
  );
  /** @type {Map<string, ManifestEntry>} */ const previous = new Map();
  const manifestPath = join(outDir, MANIFEST_NAME);
  if (!options.force && existsSync(manifestPath))
    for (const entry of previousEntries(outDir, manifestPath)) previous.set(entry.source, entry);

  /** @type {ManifestEntry[]} */ const entries = [];
  const ignored = [];
  const tools = { sharp, ffmpeg };
  for (const file of files) {
    options.signal?.throwIfAborted();
    if (consumed.has(resolve(file))) continue;
    const ext = extname(file).toLowerCase();
    const kind = MODEL.has(ext) ? 'model' : TEXTURE.has(ext) ? 'texture' : AUDIO.has(ext) ? 'audio' : null;
    const source = posix(relative(base, file)) || basename(file);
    if (!kind) {
      ignored.push(source);
      continue;
    }
    const data = new Uint8Array(readFileSync(file));
    const deps = ext === '.gltf' ? gltfDependencies(file) : [];
    const sourceSha256 = deps.length
      ? sha256(Buffer.concat([data, ...deps.map((d) => (existsSync(d) ? readFileSync(d) : Buffer.alloc(0)))]))
      : sha256(data);
    const old = previous.get(source);
    if (
      old &&
      old.sourceSha256 === sourceSha256 &&
      old.settingsSha256 === settingsSha256 &&
      outputsIntact(outDir, old)
    ) {
      entries.push({ ...old, status: 'cached' });
      options.log?.(`cached   ${source}`);
      continue;
    }
    /** @type {ManifestEntry} */
    const entry = {
      source,
      kind,
      sourceBytes: data.length + deps.reduce((n, d) => n + (existsSync(d) ? statSync(d).size : 0), 0),
      sourceSha256,
      settingsSha256,
      status: 'built',
      outputs: [],
      notes: [],
    };
    try {
      await buildOne(entry, file, data, preset, outDir, options.hashNames === true, tools);
    } catch (error) {
      entry.status = 'failed';
      entry.outputs = [];
      entry.notes.push(error instanceof Error ? error.message : String(error));
    }
    entries.push(entry);
    options.log?.(`${entry.status.padEnd(8)} ${source}`);
  }

  // Outputs of inputs that are gone (or no longer produce that file) would otherwise linger in the output folder.
  const keep = new Set(entries.flatMap((e) => e.outputs.map((o) => o.path)));
  for (const old of previous.values())
    for (const o of old.outputs)
      if (
        !keep.has(o.path) &&
        existsSync(join(outDir, o.path)) &&
        sha256(readFileSync(join(outDir, o.path))) === o.sha256
      )
        rmSync(join(outDir, o.path));

  const totals = {
    inputs: entries.length,
    built: 0,
    cached: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    inputBytes: 0,
    outputBytes: 0,
  };
  for (const e of entries) {
    totals[e.status]++;
    totals.inputBytes += e.sourceBytes;
    totals.outputBytes += e.outputs.reduce((n, o) => n + o.bytes, 0);
  }
  /** @type {Manifest} */
  const manifest = {
    tool: 'margo-convert',
    pipeline: PIPELINE_VERSION,
    preset: presetName,
    encoders,
    totals,
    files: entries,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const report = sizeReport(manifest, ignored);
  writeFileSync(join(outDir, REPORT_NAME), report);
  return { manifest, report };
}

/** @param {string} outDir @param {ManifestEntry} entry @returns {boolean} every output exists with the recorded hash */
function outputsIntact(outDir, entry) {
  if (entry.status === 'failed' || entry.status === 'skipped') return false;
  return entry.outputs.every((o) => {
    const path = join(outDir, o.path);
    return existsSync(path) && statSync(path).size === o.bytes && sha256(readFileSync(path)) === o.sha256;
  });
}

/**
 * Writes `data` into the output folder under `rel` (or a hash-named variant) and returns its record.
 * @param {string} outDir @param {string} rel @param {Uint8Array} data @param {boolean} hashNames @returns {OutputFile}
 */
function emit(outDir, rel, data, hashNames) {
  const hash = sha256(data);
  let name = rel;
  if (hashNames) {
    const ext = extname(rel);
    name = `${rel.slice(0, rel.length - ext.length)}.${hash.slice(0, 8)}${ext}`;
  }
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return { path: posix(name), bytes: data.length, sha256: hash };
}

/**
 * Optimises one model file (GLB or glTF) for a preset.
 * @param {string} file path, used to find the external files of a .gltf
 * @param {Uint8Array} data the file's bytes
 * @param {import('./presets.js').Preset} preset
 * @param {{sharp?: any}} [tools] `sharp`: the sharp module for texture encoding (omit for PNG only)
 * @returns {Promise<import('./optimize.js').ModelResult>}
 */
export async function optimizeModelFile(file, data, preset, tools = {}) {
  return optimizeModel(data, preset.model, {
    resolve: (uri) => new Uint8Array(readFileSync(modelFile(dirname(file), uri))),
    textures: { preset: preset.texture, sharp: tools.sharp ?? null },
  });
}

/**
 * @param {ManifestEntry} entry @param {string} file @param {Uint8Array} data @param {import('./presets.js').Preset} preset
 * @param {string} outDir @param {boolean} hashNames @param {{sharp: any, ffmpeg: {version: string}|null}} tools
 */
async function buildOne(entry, file, data, preset, outDir, hashNames, tools) {
  const stem = entry.source.replace(/\.[^./]+$/, '');
  if (entry.kind === 'model') {
    const result = await optimizeModelFile(file, data, preset, tools);
    if (result.skipped) {
      entry.status = entry.kind === 'model' && extname(file).toLowerCase() === '.glb' ? 'copied' : 'skipped';
      entry.notes.push(`not optimised: ${result.skipped}`);
      if (entry.status === 'copied') entry.outputs.push(emit(outDir, entry.source, data, hashNames));
      return;
    }
    entry.outputs.push(emit(outDir, `${stem}.glb`, result.glb, hashNames));
    entry.notes.push(...result.stats.notes);
    const s = result.stats;
    entry.stats = {
      vertices: s.verticesAfter,
      verticesBefore: s.verticesBefore,
      triangles: s.trianglesAfter,
      trianglesBefore: s.trianglesBefore,
      removedNodes: s.removedNodes,
      removedMeshes: s.removedMeshes,
      removedMaterials: s.removedMaterials,
      removedTextures: s.removedTextures,
      removedImages: s.removedImages,
      removedAttributes: s.removedAttributes,
      dedupedMaterials: s.dedupedMaterials,
      dedupedTextures: s.dedupedTextures,
      dedupedImages: s.dedupedImages,
      dedupedMeshes: s.dedupedMeshes,
      mergedPrimitives: s.mergedPrimitives,
      quantizedAttributes: s.quantizedAttributes,
      meshoptViews: result.compressedViews,
      imageBytesBefore: s.imageBytesBefore,
      imageBytesAfter: s.imageBytesAfter,
    };
    return;
  }
  if (entry.kind === 'texture') {
    const ext = extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const role = roleOfName(basename(file));
    const result = await processImage(data, mime, role, preset.texture, tools.sharp);
    if (result.note) entry.notes.push(result.note);
    const outExt = IMAGE_EXTENSION[result.mimeType] ?? ext;
    const changed = result.bytes !== data;
    entry.status = changed ? 'built' : 'copied';
    entry.outputs.push(emit(outDir, `${stem}${outExt}`, result.bytes, hashNames));
    if (preset.texture.mipmaps) {
      const pixels = await decodeRgba(result.bytes, result.mimeType, tools.sharp);
      if (!pixels) entry.notes.push('no mip chain: this image needs sharp to be read');
      else {
        const levels = mipChain(pixels.data, pixels.width, pixels.height, role === 'color');
        entry.outputs.push(emit(outDir, `${stem}.dds`, encodeDDS(levels), hashNames));
        entry.notes.push(`${levels.length} mip levels in ${stem.split('/').at(-1)}.dds (uncompressed RGBA8)`);
        entry.status = 'built';
      }
    }
    return;
  }
  const result = processAudio(data, extname(file).toLowerCase(), preset.audio, { ffmpeg: tools.ffmpeg });
  if (result.note) entry.notes.push(result.note);
  entry.status = result.status;
  entry.outputs.push(emit(outDir, `${stem}${result.extension}`, result.bytes, hashNames));
}

/** @param {number} n @returns {string} */
const kB = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`);

/**
 * The size report: one line per input, a summary per kind, then totals.
 * @param {Manifest} manifest @param {string[]} ignored @returns {string}
 */
export function sizeReport(manifest, ignored = []) {
  const rows = manifest.files.map((e) => {
    const out = e.outputs.reduce((n, o) => n + o.bytes, 0);
    const saved =
      e.sourceBytes && e.outputs.length ? `${(((e.sourceBytes - out) / e.sourceBytes) * 100).toFixed(1)}%` : '';
    return [
      e.source,
      e.kind,
      e.status,
      kB(e.sourceBytes),
      e.status === 'failed' || e.status === 'skipped' ? '-' : kB(out),
      saved,
    ];
  });
  const head = ['file', 'kind', 'status', 'in', 'out', 'saved'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (/** @type {string[]} */ r) =>
    r.map((c, i) => (i >= 3 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  const t = manifest.totals;
  const pct = (/** @type {number} */ before, /** @type {number} */ after) =>
    before ? `${(((before - after) / before) * 100).toFixed(1)}%` : '0%';
  const tool = (/** @type {string} */ name) => `${name} ${manifest.encoders[name] ?? 'not found'}`;
  const lines = [
    `margo-convert ${manifest.preset} preset (${tool('sharp')}, ${tool('ffmpeg')})`,
    '',
    line(head),
    ...rows.map(line),
    '',
  ];
  lines.push(
    `${t.inputs} inputs: ${t.built} built, ${t.cached} cached, ${t.copied} copied, ${t.skipped} skipped, ${t.failed} failed`,
  );
  for (const kind of ['model', 'texture', 'audio']) {
    const of = manifest.files.filter((e) => e.kind === kind);
    if (!of.length) continue;
    const before = of.reduce((n, e) => n + e.sourceBytes, 0),
      after = of.reduce((n, e) => n + e.outputs.reduce((m, o) => m + o.bytes, 0), 0);
    lines.push(
      `  ${kind.padEnd(8)} ${String(of.length).padStart(3)} files  ${kB(before)} -> ${kB(after)} (${pct(before, after)} saved)`,
    );
  }
  lines.push(`total ${kB(t.inputBytes)} -> ${kB(t.outputBytes)} (${pct(t.inputBytes, t.outputBytes)} saved)`);
  const notes = manifest.files.filter((e) => e.notes.length || e.status === 'failed');
  if (notes.length) {
    lines.push('', 'notes');
    for (const e of notes) for (const n of e.notes) lines.push(`  ${e.source}: ${n}`);
  }
  if (ignored.length)
    lines.push(
      '',
      `ignored ${ignored.length} file${ignored.length === 1 ? '' : 's'} that are not models, textures or audio`,
    );
  return lines.join('\n') + '\n';
}
