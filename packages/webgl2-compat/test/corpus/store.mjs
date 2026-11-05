// The WGSL corpus on disk: test data for the WGSL front end, recorded by scripts/record-wgsl-corpus.mjs. Two files, so
// reading the whole corpus opens two files however many modules it holds:
//   manifest.json  plain text for review, one line per distinct module (sorted by key): key (first 16 hex digits of
//                  the SHA-256 of the source), bytes, package (the one that created it), packages (every package on
//                  the creating call stack), entry points per stage, flags (features the WebGL2 layer must map),
//                  labels and the pages that created it. `sha256` is the hash of the uncompressed data text, so a
//                  hand edit of either file fails the corpus test.
//   corpus.json.br Brotli of one JSON object: `sources` ({ key: WGSL source }, about 3.3 MB of text), `layouts` (the
//                  distinct pipeline layouts: bind groups with binding types) and `pipelines` (the distinct pipelines:
//                  stage modules by key, entry point, constants, layout by index into `layouts` or 'auto', vertex
//                  buffers, targets, depth, multisample). Compressed it is about 200 KB.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

const here = import.meta.dirname;
export const MANIFEST = join(here, 'manifest.json');
export const DATA = join(here, 'corpus.json.br');

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Entry points by stage, read from the source text (the front end checks them properly in its own tests). */
export function entryPoints(code) {
  const out = { vertex: [], fragment: [], compute: [] };
  const text = code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/@(vertex|fragment|compute)\b(?:\s*@\w+\s*(?:\([^)]*\))?)*\s*fn\s+([A-Za-z_]\w*)/g))
    out[m[1]].push(m[2]);
  return out;
}

const FLAGS = [
  ['storage-read', /var\s*<\s*storage\s*(,\s*read\s*)?>/],
  ['storage-read-write', /var\s*<\s*storage\s*,\s*read_write\s*>/],
  ['atomics', /\batomic\s*</],
  ['workgroup-memory', /var\s*<\s*workgroup\s*>/],
  ['barriers', /\b(workgroup|storage|texture)Barrier\s*\(/],
  ['storage-textures', /\btexture_storage_/],
  ['multisampled-textures', /\btexture(_depth)?_multisampled_2d\b/],
  ['depth-textures', /\btexture_depth_/],
  ['comparison-samplers', /\bsampler_comparison\b/],
  ['overrides', /(^|[^\w])override\s+[A-Za-z_]/m],
  ['sample-mask', /@builtin\s*\(\s*(sample_mask|sample_index)\s*\)/],
  ['frag-depth', /@builtin\s*\(\s*frag_depth\s*\)/],
  ['f16', /\benable\s+f16\b/],
  ['dual-source-blending', /\benable\s+dual_source_blending\b/],
  ['array-length', /\barrayLength\s*\(/],
  ['derivatives', /\b(dpdx|dpdy|fwidth)(Coarse|Fine)?\s*\(/],
  ['discard', /\bdiscard\s*;/],
];

/** Feature flags of a source, by pattern (the manifest's `flags`). */
export function flagsOf(code) {
  const text = code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return FLAGS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/**
 * The package a recorded module belongs to: the label's /packages/<name>/ path, else the innermost non-shared frame,
 * else `(bundled page)`.
 */
function owner(module) {
  for (const label of module.labels ?? []) {
    const m = /\/packages\/([a-z0-9-]+)\//.exec(label);
    if (m) return { package: m[1], packages: [...new Set([m[1], ...module.packages])] };
  }
  const packages = module.packages ?? [];
  // Bundled site pages (demos, apps) have no package paths on the stack.
  return { package: packages.find((p) => p !== 'shared') ?? packages[0] ?? '(bundled page)', packages };
}

/**
 * What the corpus does with one merged record: `keep` (compiled with zero errors and declares an entry point),
 * `fragment` (failed to compile alone, or has no entry point) or `unknown` (its compile result never arrived).
 */
export function classify(record) {
  if (record.errors === undefined) return 'unknown';
  const points = entryPoints(record.code);
  if (record.errors > 0 || points.vertex.length + points.fragment.length + points.compute.length === 0)
    return 'fragment';
  return 'keep';
}

/**
 * Writes manifest.json and corpus.json.br (into `dir`, default this folder) from merged records
 * (scripts/support/wgsl-corpus.mjs mergeShards). Keeps the records {@link classify} keeps; returns what was kept
 * and dropped.
 */
export function writeCorpus(records, { date = new Date().toISOString().slice(0, 10), dir = here } = {}) {
  const byKey = new Map(),
    keys = new Map(records.map((r) => [r.key, sha(r.code).slice(0, 16)]));
  let fragments = 0,
    unknown = 0;
  for (const record of records) {
    const kind = classify(record);
    if (kind === 'unknown') unknown++;
    if (kind === 'fragment') fragments++;
    if (kind !== 'keep') continue;
    const points = entryPoints(record.code);
    const key = sha(record.code).slice(0, 16),
      who = owner(record),
      known = byKey.get(key);
    if (known) continue;
    byKey.set(key, {
      key,
      bytes: Buffer.byteLength(record.code),
      package: who.package,
      packages: who.packages,
      entryPoints: Object.fromEntries(Object.entries(points).filter(([, list]) => list.length)),
      flags: flagsOf(record.code),
      labels: (record.labels ?? []).map((l) => l.replace(/^check-wgsl:/, 'check:wgsl ')),
      pages: record.pages ?? [],
      pipelines: (record.pipelines ?? []).map((p) => renameModules(p, keys)),
      code: record.code,
    });
  }
  // Pipelines and layouts are shared by modules: store each once.
  const layouts = new Map(),
    pipelines = new Map();
  for (const m of byKey.values())
    for (const p of m.pipelines) {
      if (Array.isArray(p.layout)) {
        const text = JSON.stringify(p.layout);
        if (!layouts.has(text)) layouts.set(text, layouts.size);
        p.layout = layouts.get(text);
      }
      const text = JSON.stringify(p);
      if (!pipelines.has(text)) pipelines.set(text, p);
    }
  const modules = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    sources = Object.fromEntries(modules.map((m) => [m.key, m.code])),
    data = { sources, layouts: [...layouts.keys()].map((k) => JSON.parse(k)), pipelines: [...pipelines.values()] },
    text = `${JSON.stringify(data)}\n`;
  writeFileSync(
    join(dir, 'corpus.json.br'),
    brotliCompressSync(text, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: text.length },
    }),
  );
  const packages = [...new Set(modules.map((m) => m.package))].sort();
  const head = {
    about:
      'WGSL corpus for @margoengine/webgl2-compat: every distinct module the packages created in the real-GPU checks. Generated by `npm run record:wgsl-corpus`; do not edit by hand.',
    recorded: date,
    sha256: sha(text),
    count: modules.length,
    bytes: modules.reduce((n, m) => n + m.bytes, 0),
    packages,
  };
  // One line per module, so a re-recording diffs line by line.
  const modulesText = modules.map(({ code, pipelines: _, ...rest }) => `  ${JSON.stringify(rest)}`).join(',\n');
  writeFileSync(
    join(dir, 'manifest.json'),
    `${JSON.stringify(head, null, 1).slice(0, -2)},\n "modules": [\n${modulesText}\n ]\n}\n`,
  );
  return { kept: modules.length, bytes: modules.reduce((n, m) => n + m.bytes, 0), packages, fragments, unknown };
}

// Pipelines name modules by the recorder's page key; the manifest names them by its own key.
function renameModules(pipeline, keys) {
  const copy = structuredClone(pipeline);
  delete copy.t;
  for (const s of [copy.vertex, copy.fragment, copy.compute]) if (s) s.module = keys.get(s.module) ?? s.module;
  return copy;
}

/** The modules of a read corpus as `writeCorpus` records, so a recording can add to them. All of them compiled. */
export function recordsOf({ modules }) {
  return modules.map((module) => ({ ...module, errors: 0 }));
}

/** Reads the corpus: the manifest and every module's source, checked against the manifest's hash. */
export function readCorpus(dir = here) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
    text = brotliDecompressSync(readFileSync(join(dir, 'corpus.json.br'))).toString('utf8');
  if (sha(text) !== manifest.sha256)
    throw new Error('WGSL corpus corpus.json.br does not match manifest.json; run npm run record:wgsl-corpus again');
  const { sources, layouts, pipelines } = JSON.parse(text),
    byModule = new Map();
  for (const p of pipelines) {
    const full = { ...p, layout: typeof p.layout === 'number' ? layouts[p.layout] : p.layout };
    for (const s of [p.vertex, p.fragment, p.compute])
      if (s) byModule.set(s.module, [...(byModule.get(s.module) ?? []), full]);
  }
  return {
    manifest,
    modules: manifest.modules.map((m) => ({ ...m, code: sources[m.key], pipelines: byModule.get(m.key) ?? [] })),
  };
}
