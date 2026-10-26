// @ts-check
// `margo-convert build`: walk a file or folder, optimise every model, texture and audio file for a preset, write the
// results and a manifest with hashes and sizes, and skip inputs whose content and settings have not changed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { optimizeModel } from './optimize.js';
import { preset as presetFor } from './presets.js';

/** Bumped when the pipeline's output for the same input and preset changes, so cached results are rebuilt. */
export const PIPELINE_VERSION = 1;
/** Name of the manifest, written to the output folder. */
export const MANIFEST_NAME = 'margo-manifest.json';
/** Name of the human-readable size report, written next to the manifest. */
export const REPORT_NAME = 'margo-size-report.txt';

const MODEL = new Set(['.glb', '.gltf']);
const CAD = new Set(['.step', '.stp', '.iges', '.igs', '.brep']);
const TEXTURE = new Set(['.png', '.jpg', '.jpeg']);
const AUDIO = new Set(['.wav', '.mp3', '.ogg', '.opus', '.flac', '.m4a', '.aac']);

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
 * @property {'model'|'cad'|'texture'|'audio'} kind
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
 * @property {boolean} [force] Ignore the previous manifest and rebuild everything.
 * @property {boolean} [hashNames] Put the first 8 hex digits of the content hash in output names, for long-lived caching.
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
  return uris.map((/** @type {string} */ u) => resolve(dirname(file), decodeURIComponent(u.split('?')[0])));
}

/**
 * Builds a file or folder for a preset.
 * @param {BuildOptions} options
 * @returns {Promise<{manifest: Manifest, report: string}>}
 */
export async function build(options) {
  const preset = presetFor(options.preset ?? 'web');
  const presetName = options.preset ?? 'web';
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

  const encoders = await probeEncoders();
  const settingsSha256 = sha256(
    JSON.stringify({ pipeline: PIPELINE_VERSION, preset: presetName, body: preset, encoders }),
  );
  /** @type {Map<string, ManifestEntry>} */ const previous = new Map();
  const manifestPath = join(outDir, MANIFEST_NAME);
  if (!options.force && existsSync(manifestPath)) {
    try {
      for (const entry of JSON.parse(readFileSync(manifestPath, 'utf8')).files) previous.set(entry.source, entry);
    } catch {
      // A damaged manifest is only a cache; rebuild.
    }
  }

  /** @type {ManifestEntry[]} */ const entries = [];
  const ignored = [];
  for (const file of files) {
    options.signal?.throwIfAborted();
    if (consumed.has(resolve(file))) continue;
    const ext = extname(file).toLowerCase();
    const kind = MODEL.has(ext)
      ? 'model'
      : CAD.has(ext)
        ? 'cad'
        : TEXTURE.has(ext)
          ? 'texture'
          : AUDIO.has(ext)
            ? 'audio'
            : null;
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
      await buildOne(entry, file, data, preset, outDir, options.hashNames === true);
    } catch (error) {
      entry.status = 'failed';
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

/** Optional local encoders. @returns {Promise<Record<string, string|null>>} */
export async function probeEncoders() {
  /** @type {Record<string, string|null>} */ const found = { sharp: null };
  try {
    const { loadSharp } = await import('./textures.js');
    const sharp = await loadSharp();
    found.sharp = sharp ? (sharp.versions?.sharp ?? 'unknown') : null;
  } catch {
    // textures.js is optional until the texture pipeline is present
  }
  return found;
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
 * Optimises one model file (STEP, IGES and BREP are converted to GLB first) for a preset.
 * @param {string} file path, used to find the external files of a .gltf and to tell CAD formats apart
 * @param {Uint8Array} data the file's bytes
 * @param {import('./presets.js').Preset} preset
 * @returns {Promise<import('./optimize.js').ModelResult>}
 */
export async function optimizeModelFile(file, data, preset) {
  let bytes = data;
  if (CAD.has(extname(file).toLowerCase())) {
    const { convert, formatOf } = await import('../convert.js');
    bytes = (await convert(data, formatOf(file))).glb;
  }
  return optimizeModel(bytes, preset.model, {
    resolve: (uri) => new Uint8Array(readFileSync(resolve(dirname(file), uri))),
  });
}

/** @param {ManifestEntry} entry @param {string} file @param {Uint8Array} data @param {import('./presets.js').Preset} preset @param {string} outDir @param {boolean} hashNames */
async function buildOne(entry, file, data, preset, outDir, hashNames) {
  const stem = entry.source.replace(/\.[^./]+$/, '');
  if (entry.kind === 'model' || entry.kind === 'cad') {
    const result = await optimizeModelFile(file, data, preset);
    if (entry.kind === 'cad') entry.notes.push('converted from CAD with OCCT');
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
    };
    return;
  }
  // Textures and audio are copied unchanged until their pipelines exist.
  entry.status = 'copied';
  entry.outputs.push(emit(outDir, entry.source, data, hashNames));
}

/** @param {number} n @returns {string} */
const kB = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`);

/**
 * The size report: one line per input, then totals.
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
  const saved = t.inputBytes ? `${(((t.inputBytes - t.outputBytes) / t.inputBytes) * 100).toFixed(1)}%` : '0%';
  const lines = [`margo-convert ${manifest.preset} preset`, '', line(head), ...rows.map(line), ''];
  lines.push(
    `${t.inputs} inputs: ${t.built} built, ${t.cached} cached, ${t.copied} copied, ${t.skipped} skipped, ${t.failed} failed`,
  );
  lines.push(`total ${kB(t.inputBytes)} -> ${kB(t.outputBytes)} (${saved} saved)`);
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
