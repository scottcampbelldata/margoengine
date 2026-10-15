// margo-convert (tools/margo-convert) on the occt-import-js sample files: input vs GLB size (raw and gzip), triangles,
// parts, Khronos glTF-Validator counts, conversion time (median of 5 in one process; OCCT load measured once), a cold
// CLI run (new process, OCCT load included) and how long the GLB takes to parse in Node with gltf-pro and the light
// glTF loader. Browser loadCAD numbers for the same files are in docs/cad-performance.md.
// Run after `npm run build:packages` on AC power (waits for a quiet machine):
//   node examples/package-benchmarks/margo-convert.mjs   (writes results/margo-convert.json)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseGLTFAsync } from '../../packages/gltf-pro/dist/index.js';
import { parseGLTF } from '../../packages/gltf/dist/index.js';
import { convert, formatOf, loadOCCT } from '../../tools/margo-convert/convert.js';
import { headless, headlessModels } from '../../tests/support/pbr-snapshot.js';
import { cpuLoad, onAC, waitForQuiet } from '../../scripts/quiet-gate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)),
  samples = join(root, 'node_modules/occt-import-js/test/testfiles');
const validator = createRequire(import.meta.url)('gltf-validator');
const files = [
  'cax-if/as1-oc-214.stp',
  'cax-if/as1-tu-203.stp',
  'cax-if/dm1-oc-214.stp',
  'cube-10x10mm/Cube 10x10.stp',
  'cube-10x10mm/Cube 10x10.igs',
  'cax-if-brep/as1_pe_203.brep',
];
const median = (list) => list.sort((a, b) => a - b)[list.length >> 1];
const time = async (run, count = 5) => {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = performance.now();
    await run();
    out.push(performance.now() - t);
  }
  return +median(out).toFixed(1);
};

// --diagnostic skips the quiet gate (busy machine) and records the CPU load instead; such numbers are not publishable.
const diagnostic = process.argv.includes('--diagnostic');
const machine = diagnostic
  ? { diagnostic: true, cpuLoadPercent: cpuLoad(), ac: onAC() }
  : await waitForQuiet({ timeout: 3600 });
const start = performance.now();
await loadOCCT();
const results = {
  node: process.version,
  date: new Date().toISOString(),
  machine,
  occtLoadMs: +(performance.now() - start).toFixed(1),
  cases: [],
};
const temp = mkdtempSync(join(tmpdir(), 'margo-convert-bench-'));
try {
  for (const file of files) {
    const data = new Uint8Array(readFileSync(join(samples, file))),
      format = formatOf(file);
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push((await convert(data, format)).stats);
    const { glb, stats } = await convert(data, format),
      edged = await convert(data, format, { edges: 30 });
    const report = (await validator.validateBytes(glb, { maxIssues: 0 })).issues,
      edgeReport = (await validator.validateBytes(edged.glb, { maxIssues: 0 })).issues;
    const cold = file.endsWith('as1-oc-214.stp')
      ? await time(
          () =>
            execFileSync(process.execPath, [
              join(root, 'tools/margo-convert/cli.js'),
              join(samples, file),
              join(temp, 'out.glb'),
              '--quiet',
            ]),
          3,
        )
      : undefined;
    const proMs = await headlessModels(async () => time(async () => parseGLTFAsync(await headless(), glb.slice())));
    const lightMs = await time(async () => parseGLTF(await headless(), glb));
    const row = {
      file,
      inputBytes: data.length,
      inputGzip: gzipSync(data).length,
      glbBytes: glb.length,
      glbGzip: gzipSync(glb).length,
      edgesGlbBytes: edged.glb.length,
      parts: stats.parts,
      meshes: stats.meshes,
      instanced: stats.instanced,
      triangles: stats.triangles,
      edgeSegments: edged.stats.edges,
      tessellateMs: median(runs.map((s) => s.tessellateMs)).toFixed(1) * 1,
      writeMs: median(runs.map((s) => s.writeMs)).toFixed(1) * 1,
      coldCliMs: cold,
      validator: { errors: report.numErrors, warnings: report.numWarnings, infos: report.numInfos },
      edgesValidator: { errors: edgeReport.numErrors, warnings: edgeReport.numWarnings, infos: edgeReport.numInfos },
      nodeParseMs: { gltfPro: proMs, gltf: lightMs },
    };
    results.cases.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(
  new URL(diagnostic ? './results/margo-convert-diagnostic.json' : './results/margo-convert.json', import.meta.url),
  JSON.stringify(results, null, 2) + '\n',
);
