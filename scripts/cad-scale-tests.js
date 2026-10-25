// CAD scale ceiling: how far each load path goes on this machine while staying fast and smooth.
//
//   node scripts/cad-scale-tests.js --class=workstation|laptop|entry [--ladder] [--corpus] [--quiet]
//        [--sizes=1000,2500,5000,10000,25000,50000,100000] [--detail=low|normal|high] [--paths=obj,glb]
//        [--frames=120] [--all] [--only=<part of a corpus file name>]
//
// --ladder (default with no mode flag): generated machinery assemblies (scripts/cad-scale/assembly.mjs) of growing
//   size through two paths: `obj` (world-space parts through parseCADAsync, with PartInstancer: a file a user drops
//   in) and `glb` (repeated parts as GPU instances through gltf-pro: what a STEP-to-GLB converter writes). Each path
//   stops at its first failing size (--all keeps going); its ceiling is the largest size that passed.
// --corpus: every file listed in test-results/cad-corpus/manifest.json ({ file, format, source, license, ... }),
//   loaded the same way and held to the same limits.
// A run passes when it loads without error, keeps every part and triangle (generated assemblies), and meets the
// class's limits below. Each run opens a fresh browser (Edge, physical WebGPU) under the shared GPU lock and saves three
// screenshots: the whole model; cut at its middle height keeping the upper half (the timed section view); and keeping
// the lower half, so the cut surface and its caps face the camera. --only=<text> runs only the corpus files whose
// name contains it. --quiet waits for scripts/quiet-gate.mjs before every run; without it, times are labelled diagnostic.
// Results: test-results/cad-scale/results-<class>.json; screenshots in test-results/cad-scale/shots/<class>/.
// Run after `npm run build:packages`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { waitForQuiet } from './quiet-gate.mjs';
import { GENERATOR, assembly, summary, writeGLB, writeOBJ } from './cad-scale/assembly.mjs';

// Pass limits per machine class (proposed). Frame times include GPU completion.
export const CLASSES = {
  workstation: {
    loadMs: 10_000,
    orbitMedianMs: 1000 / 60,
    orbitP95Ms: 1000 / 30,
    pickMs: 100,
    sectionMedianMs: 1000 / 30,
  },
  laptop: { loadMs: 20_000, orbitMedianMs: 1000 / 30, orbitP95Ms: 1000 / 20, pickMs: 150, sectionMedianMs: 1000 / 20 },
  entry: { loadMs: 30_000, orbitMedianMs: 1000 / 30, orbitP95Ms: 1000 / 15, pickMs: 250, sectionMedianMs: 1000 / 15 },
};
const CAD_MAX_BYTES = 64 * 1024 * 1024, // parseCADAsync's input cap (packages/machinery/src/cad-parser.ts maxBytes)
  OUT = 'test-results/cad-scale',
  PORT = 5233;

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.includes('=') ? hit.slice(name.length + 3) : true;
};
const machine = arg('class', null),
  limits = CLASSES[machine];
if (!limits) throw new TypeError('--class must be workstation, laptop or entry');
const ladder = arg('ladder', false) || !arg('corpus', false),
  corpus = arg('corpus', false),
  quiet = arg('quiet', false),
  all = arg('all', false),
  frames = Number(arg('frames', 120)),
  detail = arg('detail', 'normal'),
  paths = String(arg('paths', 'obj,glb')).split(','),
  only = arg('only', null),
  sizes = String(arg('sizes', '1000,2500,5000,10000,25000,50000,100000')).split(',').map(Number);
assert.ok(
  sizes.every((n) => Number.isInteger(n) && n > 0),
  '--sizes must be positive integers',
);
assert.ok(
  paths.every((p) => p === 'obj' || p === 'glb'),
  '--paths takes obj and/or glb',
);

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages'], { encoding: 'utf8' }).trim() !== '';

/** Writes (or reuses) the generated OBJ and GLB for `parts`; returns their paths and the assembly's summary. */
async function generated(parts) {
  const base = `${OUT}/assemblies/assembly-${parts}-${detail}`,
    meta = `${base}.json`,
    cached = existsSync(meta) ? JSON.parse(await readFile(meta, 'utf8')) : null;
  if (cached?.generator === GENERATOR) return cached;
  await mkdir(`${OUT}/assemblies`, { recursive: true });
  const parts_ = assembly(parts, { detail }),
    info = summary(parts_),
    stream = createWriteStream(`${base}.obj`),
    obj = await writeOBJ(
      parts_,
      async (chunk) => {
        if (!stream.write(chunk)) await once(stream, 'drain');
      },
      { limitBytes: CAD_MAX_BYTES },
    );
  stream.end();
  await once(stream, 'finish');
  const glb = writeGLB(parts_);
  await writeFile(`${base}.glb`, glb);
  const record = {
    generator: GENERATOR,
    detail,
    ...info,
    obj: { file: `${base}.obj`, bytes: obj.bytes, oversize: obj.oversize },
    glb: { file: `${base}.glb`, bytes: glb.length },
  };
  await writeFile(meta, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** One load in a fresh browser; returns the page's result plus hardware and two screenshot paths (whole, section). */
async function measure({ file, format, label, bounds, smoothing = true }) {
  if (quiet) await waitForQuiet();
  const q = new URLSearchParams({ url: `/${file.replaceAll('\\', '/')}`, format, frames: String(frames) });
  if (!smoothing) q.set('smoothing', 'false');
  if (bounds)
    ['minx', 'miny', 'minz', 'maxx', 'maxy', 'maxz'].forEach((k, i) =>
      q.set(k, String(i < 3 ? bounds.min[i] : bounds.max[i - 3])),
    );
  const browser = await openBrowser({ startPath: `/tests/cad-scale.html?${q}`, port: PORT });
  try {
    const { page, hardware } = browser;
    if (!hardware.webgpu || hardware.webgpu.fallback === true)
      throw new Error(`Physical WebGPU adapter required: ${JSON.stringify(hardware.webgpu)}`);
    // A run that never finishes (a hang, a lost device) is a failure of that run, not of the whole ladder.
    const finished = await page
      .waitForFunction(() => window.cadScale, null, { timeout: 15 * 60_000 })
      .then(
        () => true,
        () => false,
      );
    if (!finished) return { ok: false, stage: 'timeout', error: 'No result within 15 minutes', hardware, shots: [] };
    const result = await page.evaluate(() => window.cadScale),
      shots = [];
    if (result.ok) {
      await mkdir(`${OUT}/shots/${machine}`, { recursive: true });
      for (const view of ['whole', 'section', 'cap']) {
        const shot = `${OUT}/shots/${machine}/${label.replace(/[^\w.-]+/g, '_')}-${view}.png`;
        await page.evaluate((v) => window.cadScaleShot(v), view);
        await page.locator('canvas').screenshot({ path: shot });
        shots.push(shot);
      }
    }
    return { ...result, hardware, shots };
  } finally {
    await browser.close();
  }
}

/** Why a run fails its class (empty: it passes). `expected` holds the generated counts, when known. */
function failures(result, expected) {
  if (!result.ok) return [`${result.stage}: ${result.error ?? result.errors?.join('; ')}`];
  const out = [];
  if (result.errors?.length) out.push(`errors: ${result.errors.join('; ')}`);
  if (expected && result.parts !== expected.parts) out.push(`parts ${result.parts} != ${expected.parts}`);
  if (expected && result.triangles !== expected.triangles)
    out.push(`triangles ${result.triangles} != ${expected.triangles}`);
  const over = (name, value, limit) =>
    value > limit && out.push(`${name} ${value.toFixed(1)} ms > ${limit.toFixed(1)}`);
  over('load', result.loadMs, limits.loadMs);
  over('orbit median', result.orbit.median, limits.orbitMedianMs);
  over('orbit p95', result.orbit.p95, limits.orbitP95Ms);
  over('pick median', result.pick.median, limits.pickMs);
  over('section median', result.section.median, limits.sectionMedianMs);
  return out;
}

const report = {
  class: machine,
  limits,
  commit,
  dirty,
  timing: quiet ? 'quiet-gated' : 'diagnostic',
  detail,
  started: new Date().toISOString(),
  hardware: null,
  ladder: {},
  corpus: [],
};
const row = (r) =>
  r.ok
    ? `${String(r.parts).padStart(7)} parts ${String(r.triangles).padStart(10)} tris  load ${r.loadMs.toFixed(0).padStart(6)} ms  orbit ${r.orbit.median.toFixed(1)}/${r.orbit.p95.toFixed(1)} ms (encode ${r.orbit.encode.median.toFixed(1)})  pick ${r.pick.median.toFixed(0)} ms  section ${r.section.median.toFixed(1)} ms (encode ${r.section.encode.median.toFixed(1)})  draws ${r.draws}`
    : `FAILED at ${r.stage}: ${r.error ?? r.errors?.join('; ')}`;

const release = await acquire({ owner: 'cad-scale-tests' });
try {
  if (ladder)
    for (const path of paths) {
      const runs = [];
      let ceiling = 0,
        firstFailure = null;
      for (const size of sizes) {
        const asset = await generated(size),
          expected = { parts: asset.parts, triangles: asset.triangles };
        let result, why;
        if (path === 'obj' && asset.obj.oversize) {
          result = { ok: false, stage: 'file', error: `OBJ passes ${CAD_MAX_BYTES} bytes, parseCADAsync's input cap` };
          why = [result.error];
        } else {
          result = await measure({
            file: path === 'obj' ? asset.obj.file : asset.glb.file,
            format: path,
            label: `ladder-${path}-${size}`,
            bounds: asset.bounds,
          });
          report.hardware ??= result.hardware;
          why = failures(result, expected);
        }
        runs.push({
          size,
          asset: {
            parts: asset.parts,
            geometries: asset.geometries,
            triangles: asset.triangles,
            bytes: asset[path].bytes,
          },
          result,
          failures: why,
        });
        console.log(
          `${path} ${String(size).padStart(7)}: ${why.length ? 'FAIL' : 'pass'}  ${row(result)}${why.length ? `\n    ${why.join('\n    ')}` : ''}`,
        );
        if (why.length) {
          firstFailure ??= { size, failures: why };
          if (!all) break;
        } else if (!firstFailure) ceiling = size;
      }
      report.ladder[path] = { ceiling, firstFailure, runs };
    }
  if (corpus) {
    const manifest = JSON.parse(await readFile('test-results/cad-corpus/manifest.json', 'utf8'));
    for (const entry of manifest) {
      if (only && !entry.file.includes(only)) continue;
      const file = `test-results/cad-corpus/${entry.file}`,
        result = await measure({ file, format: entry.format, label: `corpus-${entry.file}` });
      report.hardware ??= result.hardware;
      const why = failures(result, null);
      report.corpus.push({ ...entry, result, failures: why });
      console.log(
        `corpus ${entry.file}: ${why.length ? 'FAIL' : 'pass'}  ${row(result)}${why.length ? `\n    ${why.join('\n    ')}` : ''}`,
      );
    }
  }
} finally {
  release();
  report.finished = new Date().toISOString();
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/results-${machine}.json`, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`\nCeilings on ${machine} (${report.timing}, ${commit}${dirty ? ', packages dirty' : ''}):`);
for (const [path, r] of Object.entries(report.ladder))
  console.log(
    `  ${path}: ${r.ceiling ? `${r.ceiling} parts pass` : 'no size passed'}${r.firstFailure ? `; first failure at ${r.firstFailure.size}: ${r.firstFailure.failures[0]}` : '; every size passed'}`,
  );
if (report.corpus.length)
  console.log(`  corpus: ${report.corpus.filter((c) => !c.failures.length).length}/${report.corpus.length} files pass`);
console.log(`Results: ${OUT}/results-${machine}.json`);
