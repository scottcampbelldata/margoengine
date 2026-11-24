// Black-box value comparison only: Margo Catmull-Clark against Blender's Subdivision Surface modifier, driven
// through Blender's documented Python API in a temporary folder. No timings and no Blender source inspection.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrimitiveMesh } from '../packages/mesh-edit/dist/index.js';
import { subdivideMesh } from '../packages/mesh-edit/dist/modeling.js';

const blender = process.argv.find((a) => a.startsWith('--blender='))?.slice(10);
assert.ok(blender, 'Supply --blender=<path to blender executable>');
const grid = {
  vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0], [0, 2, 0], [1, 2, 0], [2, 2, 0]],
  faces: [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]].map((vertices, i) => ({
    id: `g${i}`,
    vertices,
    uv: vertices.map(() => [0, 0]),
  })),
};
const cases = [];
for (const [name, mesh] of [
  ['cube', createPrimitiveMesh('cube', 'box')],
  ['cylinder', createPrimitiveMesh('cylinder', 'c')],
  ['wedge', createPrimitiveMesh('wedge', 'w')],
  ['open-grid', grid],
])
  for (const levels of [1, 2]) cases.push({ name, levels, mesh });
const dir = mkdtempSync(join(tmpdir(), 'bp169-mesh-'));
try {
  const input = join(dir, 'in.json'),
    output = join(dir, 'out.json'),
    script = join(dir, 'run.py');
  writeFileSync(
    input,
    JSON.stringify(cases.map((c) => ({ levels: c.levels, v: c.mesh.vertices, f: c.mesh.faces.map((f) => f.vertices) }))),
  );
  writeFileSync(
    script,
    `import bpy, json, sys
cases = json.load(open(sys.argv[-2]))
out = []
for c in cases:
    me = bpy.data.meshes.new('m')
    me.from_pydata(c['v'], [], c['f'])
    ob = bpy.data.objects.new('o', me)
    bpy.context.scene.collection.objects.link(ob)
    md = ob.modifiers.new('s', 'SUBSURF')
    md.subdivision_type = 'CATMULL_CLARK'
    md.levels = c['levels']
    md.use_limit_surface = False
    md.boundary_smooth = 'PRESERVE_CORNERS'
    md.use_creases = False
    ev = ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    out.append({'v': [list(v.co) for v in ev.vertices], 'faces': len(ev.polygons), 'version': bpy.app.version_string})
json.dump(out, open(sys.argv[-1], 'w'))
`,
  );
  execFileSync(blender, ['--background', '--factory-startup', '--python', script, '--', input, output], {
    stdio: 'ignore',
    timeout: 120_000,
  });
  const rival = JSON.parse(readFileSync(output, 'utf8'));
  for (const [i, c] of cases.entries()) {
    let id = 0;
    const margo = subdivideMesh(c.mesh, { levels: c.levels, createId: () => `n${id++}` }).mesh;
    // Each Margo vertex is matched to its nearest Blender vertex (Blender stores Float32 positions).
    let maxError = 0,
      matched = 0;
    const used = new Set();
    for (const p of margo.vertices) {
      let best = -1,
        error = Infinity;
      rival[i].v.forEach((q, j) => {
        const d = Math.max(...q.map((x, a) => Math.abs(x - p[a])));
        if (d < error) [best, error] = [j, d];
      });
      if (error < 1e-5 && !used.has(best)) {
        used.add(best);
        matched++;
      }
      maxError = Math.max(maxError, error);
    }
    console.log(
      JSON.stringify({
        case: `${c.name}-L${c.levels}`,
        blender: rival[i].version,
        margoVertices: margo.vertices.length,
        blenderVertices: rival[i].v.length,
        matched,
        maxError,
        margoFaces: margo.faces.length,
        blenderFaces: rival[i].faces,
      }),
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
