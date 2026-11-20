import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { polygonMeshEdges } from '@margoengine/mesh-edit';
import { bridgeMeshEdgeLoops, dissolveMeshComponents, fillMeshHoles } from '@margoengine/mesh-edit/modeling';

// A flat disc: one center vertex and `count` rim vertices, one triangle per rim edge. Its rim is one open boundary
// of `count` edges, past the about 125,000 arguments V8 takes in one Math.min(...values) call.
function fan(count) {
  const vertices = [[0, 0, 0]],
    faces = [];
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    vertices.push([Math.cos(a), 0, Math.sin(a)]);
    faces.push({ id: `f${i}`, vertices: [0, 1 + ((i + 1) % count), 1 + i], uv: [[0, 0], [1, 0], [0, 1]] });
  }
  return { vertices, faces };
}

const big = fan(130_000);

test('a hole with 130,000 border vertices fills', () => {
  const { holes, mesh } = fillMeshHoles(big, { refine: false, fair: false });
  assert.equal(holes.length, 1);
  assert.equal(holes[0].vertices.length, 130_000);
  assert.equal(mesh.faces.length, 130_000 + holes[0].faces.length);
  assert.ok(holes[0].faces.length >= 130_000, 'the hole is covered');
  for (const face of mesh.faces) for (const uv of face.uv) assert.ok(uv.every((x) => x >= 0 && x <= 1));
});

test('dissolving a region with 130,000 border edges names the border limit', () => {
  assert.throws(
    () => dissolveMeshComponents(big, { mode: 'face', faces: big.faces.map((face) => face.id) }),
    (error) => error.code === 'unsupported' && /130000 corners, over the 4096/.test(error.message),
  );
});

test('dissolving a region past the splitter limit says so instead of reporting a fold', () => {
  const mesh = fan(5000);
  assert.throws(
    () => dissolveMeshComponents(mesh, { mode: 'face', faces: mesh.faces.map((face) => face.id) }),
    (error) => error.code === 'unsupported' && /5000 corners, over the 4096/.test(error.message),
  );
});

test('a bridge loop of 130,000 edges is walked', () => {
  const rim = polygonMeshEdges(big)
    .filter((edge) => edge.incidences.length === 1)
    .map((edge) => edge.id);
  assert.equal(rim.length, 130_000);
  // The same loop twice: walking it must succeed before the shared-vertex check can refuse it.
  assert.throws(() => bridgeMeshEdgeLoops(big, rim, rim), (error) => error instanceof TypeError && /share a vertex/.test(error.message));
});

test('no source spreads values into Math.min or Math.max', () => {
  const dir = new URL('../src/', import.meta.url),
    found = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue;
    readFileSync(new URL(name, dir), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!line.trim().startsWith('//') && /Math\.(min|max)\(\s*\.\.\./.test(line)) found.push(`${name}:${i + 1}`);
      });
  }
  assert.deepEqual(found, [], 'use leastOf or greatestOf from least.ts: a spread of a large list overflows the stack');
});
