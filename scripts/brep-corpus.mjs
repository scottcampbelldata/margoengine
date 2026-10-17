// Our STEP reader (@margoengine/brep) against OpenCascade on every STEP file of the CAD corpus
// (test-results/cad-corpus/manifest.json). OpenCascade (occt-import-js, a dev dependency) is only the reference here,
// as three.js is for rendering; it never ships in @margoengine/brep. Per file: products, placed bodies and faces from
// both, and parse times; then the surface and edge-curve types the geometry stages must cover.
//   npm run build:packages && node scripts/brep-corpus.mjs [--json=test-results/brep-corpus.json] [--no-occt]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseSTEP } from '../packages/brep/dist/index.js';

const require = createRequire(import.meta.url),
  json = process.argv.find((a) => a.startsWith('--json='))?.slice(7),
  withOCCT = !process.argv.includes('--no-occt');
const manifest = JSON.parse(readFileSync('test-results/cad-corpus/manifest.json', 'utf8')).filter(
  (entry) => entry.format === 'step',
);
const occt = withOCCT ? await require('occt-import-js')() : undefined;
const rows = [],
  surfaces = {},
  curves = {};
for (const entry of manifest) {
  const bytes = readFileSync(`test-results/cad-corpus/${entry.file}`),
    row = { file: entry.file, bytes: bytes.length };
  let start = performance.now();
  try {
    const model = parseSTEP(bytes),
      faces = model.instances.reduce((sum, i) => sum + model.bodies[i.body].faces.length, 0);
    row.ours = {
      ms: +(performance.now() - start).toFixed(1),
      schema: model.header.schema[0]?.split(' ')[0] ?? '',
      products: model.products.length,
      roots: model.roots.length,
      bodies: model.bodies.length,
      instances: model.instances.length,
      faces,
      colored: model.bodies.filter((b) => b.color).length,
      faceColors: model.faceColors.size,
      units: [...new Set(model.bodies.map((b) => b.unit))],
      warnings: model.warnings,
    };
    for (const [k, v] of Object.entries(model.census.surfaces)) surfaces[k] = (surfaces[k] ?? 0) + v;
    for (const [k, v] of Object.entries(model.census.curves)) curves[k] = (curves[k] ?? 0) + v;
  } catch (error) {
    row.ours = { ms: +(performance.now() - start).toFixed(1), error: String(error) };
  }
  if (occt) {
    start = performance.now();
    const result = occt.ReadStepFile(new Uint8Array(bytes), null);
    row.occt = {
      ms: +(performance.now() - start).toFixed(1),
      success: !!result?.success,
      meshes: result?.meshes?.length ?? 0,
      faces: (result?.meshes ?? []).reduce((sum, m) => sum + (m.brep_faces?.length ?? 0), 0),
    };
  }
  rows.push(row);
  const o = row.ours,
    r = row.occt;
  console.log(
    entry.file.padEnd(48),
    o.error
      ? `OURS FAILED: ${o.error}`
      : `ours ${o.products} products, ${o.instances} placed bodies (${o.bodies} distinct), ${o.faces} faces, ${o.ms} ms, unit ${o.units.join('/')} m, ${o.colored} coloured bodies, ${o.warnings.length} warnings`,
    r ? `| occt ${r.meshes} meshes, ${r.faces} faces, ${r.ms} ms${r.success ? '' : ' FAILED'}` : '',
    r && !o.error ? (r.meshes === o.instances && r.faces === o.faces ? '| MATCH' : '| DIFFERS') : '',
  );
}
console.log('\nSurface types:', surfaces);
console.log('Edge-curve types:', curves);
if (json) writeFileSync(json, `${JSON.stringify({ rows, surfaces, curves }, null, 2)}\n`);
