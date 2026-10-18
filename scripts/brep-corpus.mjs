// Our kernel (@margoengine/brep) against OpenCascade on every STEP file of the CAD corpus
// (test-results/cad-corpus/manifest.json), and on its own for the B-rep formats OpenCascade's free build cannot read
// (ACIS SAT, format 'sat'; Parasolid XT, format 'xt': .x_t and .x_b). OpenCascade (occt-import-js, a dev dependency) is only the reference here,
// as three.js is for rendering; it never ships in @margoengine/brep. Per file: products, placed bodies and faces from
// both, and parse times; then, unless --no-mesh, both tessellate at the same settings (deflection 0.001 of the size,
// 0.5 rad) and the meshes are compared: triangles, area, enclosed volume, bounds, open edges, faces that failed, time.
// Our open edges are those of solids and tessellated bodies; sheet bodies' borders are counted apart (sheetEdges).
// Last, the surface and edge-curve types the geometry stages must cover.
//   npm run build:packages && node scripts/brep-corpus.mjs [--json=test-results/brep-corpus.json] [--no-occt]
//     [--no-mesh] [--only=<part of a file name>]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseSAT, parseSTEP, parseXT, tessellateSTEP, validateSTEP } from '../packages/brep/dist/index.js';

const require = createRequire(import.meta.url),
  json = process.argv.find((a) => a.startsWith('--json='))?.slice(7),
  only = process.argv.find((a) => a.startsWith('--only='))?.slice(7),
  withOCCT = !process.argv.includes('--no-occt'),
  withMesh = !process.argv.includes('--no-mesh');
const manifest = JSON.parse(readFileSync('test-results/cad-corpus/manifest.json', 'utf8')).filter(
  (entry) => ['step', 'sat', 'xt'].includes(entry.format) && (!only || entry.file.includes(only)),
);

/** Triangles, area, signed volume, open edges (after joining equal positions) and bounds of a triangle mesh. */
function meshStats(positions, indices) {
  const ids = new Map(),
    weld = new Uint32Array(positions.length / 3),
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < weld.length; i++) {
    const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    weld[i] = ids.get(key);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i * 3 + k]);
      max[k] = Math.max(max[k], positions[i * 3 + k]);
    }
  }
  let area = 0,
    volume = 0;
  const directed = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]],
      p = (i, k) => positions[i * 3 + k],
      e1 = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)],
      e2 = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)],
      n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    area += Math.hypot(n[0], n[1], n[2]) / 2;
    volume += (p(a, 0) * n[0] + p(a, 1) * n[1] + p(a, 2) * n[2]) / 6;
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = weld[x] * 4294967296 + weld[y];
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [key, count] of directed) {
    const x = Math.floor(key / 4294967296),
      y = key % 4294967296;
    if (count !== 1 || directed.get(y * 4294967296 + x) !== 1) open++;
  }
  return { triangles: indices.length / 3, area, volume, open, min, max };
}
/** Column-major 4x4 times a point. */
const place = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const det3 = (m) =>
  m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
const ratio = (a, b) => (b ? +(a / b).toFixed(4) : a ? Infinity : 1);
// The reference can abort on a file (STC07): that file records the error, and a fresh instance reads the next.
let occt = withOCCT ? await require('occt-import-js')() : undefined;
const rows = [],
  surfaces = {},
  curves = {};
for (const entry of manifest) {
  const bytes = readFileSync(`test-results/cad-corpus/${entry.file}`),
    row = { file: entry.file, bytes: bytes.length };
  let start = performance.now();
  try {
    const model = entry.format === 'sat' ? parseSAT(bytes) : entry.format === 'xt' ? parseXT(bytes) : parseSTEP(bytes),
      faces = model.instances.reduce((sum, i) => sum + model.bodies[i.body].faces.length, 0);
    row.ours = {
      ms: +(performance.now() - start).toFixed(1),
      schema: entry.format === 'step' ? (model.header.schema[0]?.split(' ')[0] ?? '') : entry.format,
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
    if (withMesh) {
      start = performance.now();
      const meshes = tessellateSTEP(model, { relativeDeflection: 0.001, angle: 0.5 }),
        ms = performance.now() - start,
        bodies = meshes.map((m) => ({ ...meshStats(m.positions, m.indices), unit: m.unit })),
        mesh = { ms: +ms.toFixed(1), triangles: 0, area: 0, volume: 0, open: 0, sheetEdges: 0, failed: 0, reasons: {} },
        min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (const m of meshes) {
        mesh.failed += m.failures.length;
        for (const f of m.failures) {
          const reason = f.reason.replace(/#\d+/g, '#').slice(0, 120);
          mesh.reasons[reason] = (mesh.reasons[reason] ?? 0) + 1;
        }
      }
      for (const instance of model.instances) {
        const b = bodies[instance.body],
          d = det3(instance.matrix);
        if (!b.triangles) continue;
        mesh.triangles += b.triangles;
        // A sheet body (SHELL_BASED_SURFACE_MODEL) is open by nature: its border is counted apart from solids' gaps.
        if (model.bodies[instance.body].kind === 'shell') mesh.sheetEdges += b.open;
        else mesh.open += b.open;
        mesh.area += b.area * b.unit ** 2 * Math.abs(d) ** (2 / 3);
        mesh.volume += b.volume * b.unit ** 3 * d;
        // The placed points themselves: a rotated body's box corners would overstate its extent.
        const p = meshes[instance.body].positions;
        for (let i = 0; i < p.length; i += 3) {
          const w = place(instance.matrix, [p[i] * b.unit, p[i + 1] * b.unit, p[i + 2] * b.unit]);
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], w[k]);
            max[k] = Math.max(max[k], w[k]);
          }
        }
      }
      row.ours.mesh = { ...mesh, min, max };
      // The file's own validation properties (volume, area, centre, box, facets) against our meshes.
      row.ours.validation = validateSTEP(model, meshes).map((c) => ({
        label: c.property.label,
        tessellated: c.property.tessellated,
        bodies: c.property.bodies?.length ?? 'product',
        differences: c.differences,
        ok: c.ok,
        ...(c.note ? { note: c.note } : {}),
      }));
    }
    for (const [k, v] of Object.entries(model.census.surfaces)) surfaces[k] = (surfaces[k] ?? 0) + v;
    for (const [k, v] of Object.entries(model.census.curves)) curves[k] = (curves[k] ?? 0) + v;
  } catch (error) {
    row.ours = { ms: +(performance.now() - start).toFixed(1), error: String(error) };
  }
  if (occt && entry.format === 'step') {
    start = performance.now();
    // Metres, and the same deflection settings as ours.
    let result;
    try {
      result = occt.ReadStepFile(new Uint8Array(bytes), {
        linearUnit: 'meter',
        linearDeflectionType: 'bounding_box_ratio',
        linearDeflection: 0.001,
        angularDeflection: 0.5,
      });
    } catch (error) {
      row.occtError = String(error);
      occt = await require('occt-import-js')();
    }
    row.occt = {
      ms: +(performance.now() - start).toFixed(1),
      success: !!result?.success,
      meshes: result?.meshes?.length ?? 0,
      faces: (result?.meshes ?? []).reduce((sum, m) => sum + (m.brep_faces?.length ?? 0), 0),
    };
    if (withMesh) {
      const mesh = { triangles: 0, area: 0, volume: 0, open: 0 },
        min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (const m of result?.meshes ?? []) {
        const s = meshStats(m.attributes.position.array, m.index.array);
        for (const k of ['triangles', 'area', 'volume', 'open']) mesh[k] += s[k];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], s.min[k]);
          max[k] = Math.max(max[k], s.max[k]);
        }
      }
      row.occt.mesh = { ...mesh, min, max };
    }
  }
  rows.push(row);
  // Written after every file, so a run that dies part way keeps what it measured.
  if (json) writeFileSync(json, `${JSON.stringify({ rows, surfaces, curves, complete: false }, null, 2)}\n`);
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
  const om = o.mesh,
    rm = r?.mesh;
  if (om) {
    const diagonal = Math.hypot(...om.max.map((v, k) => v - om.min[k])),
      boundsOff = rm
        ? Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(om.min[k] - rm.min[k]), Math.abs(om.max[k] - rm.max[k])]))
        : 0;
    if (rm)
      row.compare = {
        triangles: ratio(om.triangles, rm.triangles),
        area: ratio(om.area, rm.area),
        volume: ratio(om.volume, rm.volume),
        bounds: diagonal ? +(boundsOff / diagonal).toFixed(5) : 0,
        time: ratio(o.ms + om.ms, r.ms),
      };
    const c = row.compare,
      same = c && Math.abs(c.area - 1) <= 0.01 && Math.abs(c.volume - 1) <= 0.01 && c.bounds <= 0.005;
    console.log(
      '  mesh'.padEnd(48),
      `ours ${om.triangles} triangles, area ${om.area.toPrecision(6)} m2, volume ${om.volume.toPrecision(6)} m3, ${om.open} open edges${om.sheetEdges ? ` (+${om.sheetEdges} sheet border)` : ''}, ${om.failed} faces failed, ${om.ms} ms`,
      rm
        ? `| occt ${rm.triangles} triangles, area ${rm.area.toPrecision(6)}, volume ${rm.volume.toPrecision(6)}, ${rm.open} open edges | ratio tri ${c.triangles} area ${c.area} vol ${c.volume} bounds ${c.bounds} time ${c.time} | ${same ? 'MESH MATCH' : 'MESH DIFFERS'}`
        : '',
    );
    for (const [reason, count] of Object.entries(om.reasons).slice(0, 5))
      console.log('    failed'.padEnd(48), `${count} x ${reason}`);
    const checks = o.validation ?? [];
    if (checks.length) {
      const passed = checks.filter((v) => v.ok).length;
      console.log(
        '  file says'.padEnd(48),
        `${checks.length} validation checks, ${passed} within 0.5% | ${passed === checks.length ? 'SELF MATCH' : 'SELF DIFFERS'}`,
      );
      for (const v of checks.filter((c) => !c.ok).slice(0, 8))
        console.log(
          '    differs'.padEnd(48),
          `${v.label}${v.tessellated ? ' (tessellated)' : ''}, ${v.bodies === 'product' ? 'whole product' : `${v.bodies} bodies`}: ` +
            Object.entries(v.differences)
              .map(([k, d]) => `${k} ${k === 'facets' ? d : +d.toPrecision(3)}`)
              .join(', ') +
            (v.note ? ` (${v.note})` : ''),
        );
    }
  }
}
console.log('\nSurface types:', surfaces);
console.log('Edge-curve types:', curves);
if (json) writeFileSync(json, `${JSON.stringify({ rows, surfaces, curves, complete: true }, null, 2)}\n`);
