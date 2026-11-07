// Subdivision against Blender's Subdivision Surface modifier, an outside tool. fixtures/subdiv/cases.usda and faces.usda are
// stand-ins written here for what real files seldom hold; fixtures/real holds two real ones. Truth comes from
// tests/oracle/subdiv-truth.py and subdiv-faces.py. Truth holds six decimals, so 1e-5 is its rounding plus float32 points.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loopSubdivide } from '@margoengine/geometry';
import { composeUSDFiles, parseUSDFiles } from '../dist/compose.js';
import { skeletons } from '../dist/skel.js';
import { subdivision } from '../dist/subdiv.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
  CLOSE = 1e-5;
const reader = (file) => {
  const path = join(fixtures, ...file.split('/')),
    folder = dirname(path);
  return [path.split(sep).at(-1), (id) => {
    const at = resolve(folder, id);
    return existsSync(at) ? new Uint8Array(readFileSync(at)) : undefined;
  }];
};
const open = (file, extensions, options = {}) => parseUSDFiles(...reader(file), { extensions, ...options });
const text = (usda, extensions, options = {}) =>
  parseUSDFiles('root.usda', (id) => (id === 'root.usda' ? new TextEncoder().encode(usda) : undefined), { extensions, ...options });
/** The worst distance from a point of `a` to the nearest of `b`, three numbers a point. */
const reach = (a, b) => {
  const cell = 0.25,
    floor = (v) => Math.floor(v / cell),
    grid = new Map();
  for (let i = 0; i < b.length; i += 3) {
    const k = [floor(b[i]), floor(b[i + 1]), floor(b[i + 2])].join();
    (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
  }
  let worst = 0;
  for (let i = 0; i < a.length; i += 3) {
    let best = Infinity;
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++)
          for (const j of grid.get([floor(a[i]) + x, floor(a[i + 1]) + y, floor(a[i + 2]) + z].join()) ?? [])
            best = Math.min(best, Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]));
    worst = Math.max(worst, best);
  }
  return worst;
};
const truth = JSON.parse(readFileSync(join(fixtures, 'subdiv', 'blender.json'), 'utf8'));
for (const [file, levels] of Object.entries(truth))
  for (const [level, meshes] of Object.entries(levels))
    test(`points refine as Blender's at level ${level}: ${file}`, async () => {
      const asset = await open(file, [subdivision({ level: +level })]);
      assert.deepEqual(asset.issues.filter((i) => /subdivision/.test(i.message)), []);
      for (const [path, want] of Object.entries(meshes)) {
        const mesh = asset.meshes.find((m) => m.path === path);
        assert.ok(mesh, path);
        assert.ok(reach(mesh.positions, want) < CLOSE, `${path} reaches Blender's points`);
        // Blender has no hole faces: it keeps points the Pyramid's holes leave out.
        if (!file.includes('Pyramid')) assert.ok(reach(want, mesh.positions) < CLOSE, `${path} covers Blender's points`);
      }
    });

const flat = (value) => (Array.isArray(value) ? value.flat(9) : Array.from(value ?? []));
const faces = await composeUSDFiles(...reader('subdiv/faces.usda')),
  specs = faces.specs ?? faces;
/** A mesh of faces.usda through the hook alone, so one stage serves every linear interpolation mode. */
const refined = (name, mode, level) => {
  const path = '/Cases/' + name,
    attr = (_, property) => specs[path + '.' + property]?.fields?.default,
    own = (property) => attr(path, property),
    shape = subdivision({ level }).shape({
      specs: {},
      path,
      points: flat(own('points')),
      counts: flat(own('faceVertexCounts')),
      faces: flat(own('faceVertexIndices')),
      flip: false,
      maxTriangles: 1e9,
      value: (property) => (property === 'faceVaryingLinearInterpolation' ? mode : own(property)),
      attr,
      soft: () => {},
    });
  return { shape, uv: shape.corners(flat(own('primvars:st')), 2, flat(own('primvars:st:indices')), 'faceVarying') };
};
const uvTruth = JSON.parse(readFileSync(join(fixtures, 'subdiv', 'faces.json'), 'utf8'));
for (const [name, records] of Object.entries(uvTruth))
  test(`face-varying values refine as Blender's in every mode: ${name}`, () => {
    for (const [key, want] of Object.entries(records)) {
      const [mode, level] = key.split(':'),
        { shape, uv } = refined(name, mode, +level),
        near = new Map(),
        cell = (x, y, z) => [x, y, z].map((v) => Math.floor(v * 100)),
        name3 = (c) => c.join();
      for (const row of want) {
        const k = name3(cell(row[0], row[1], row[2]));
        (near.get(k) ?? near.set(k, []).get(k)).push(row);
      }
      // Corners pair by nearest point, never by rounded keys: a rounded key can pair a corner with its neighbour's value.
      shape.faces.forEach((point, corner) => {
        const p = [0, 1, 2].map((d) => shape.points[point * 3 + d]),
          c = cell(...p);
        let best = Infinity;
        for (let x = -1; x <= 1; x++)
          for (let y = -1; y <= 1; y++)
            for (let z = -1; z <= 1; z++)
              for (const row of near.get(name3([c[0] + x, c[1] + y, c[2] + z])) ?? [])
                if (Math.hypot(row[0] - p[0], row[1] - p[1], row[2] - p[2]) < 1e-4)
                  best = Math.min(best, Math.hypot(row[3] - uv[corner * 2], row[4] - uv[corner * 2 + 1]));
        assert.ok(best < CLOSE, `${name} ${key} corner ${corner} is ${best} from Blender's`);
      });
    }
  });

const CUBE = `int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
    int[] faceVertexIndices = [0, 1, 3, 2, 2, 3, 5, 4, 4, 5, 7, 6, 6, 7, 1, 0, 1, 7, 5, 3, 6, 0, 2, 4]
    point3f[] points = [(-1, -1, 1), (1, -1, 1), (-1, 1, 1), (1, 1, 1), (-1, 1, -1), (1, 1, -1), (-1, -1, -1), (1, -1, -1)]`;
const cube = (extra = '') => `#usda 1.0
(
    defaultPrim = "M"
    metersPerUnit = 1
    upAxis = "Y"
)
def Mesh "M"
{
    ${CUBE}
    ${extra}
}`;
const triangles = (mesh) => (mesh.indices?.length ?? mesh.positions.length / 3) / 3;

test('without the entry a subdivided mesh keeps its cage and says so', async () => {
  const asset = await text(cube(), []);
  assert.equal(triangles(asset.meshes[0]), 12);
  assert.ok(asset.issues.some((i) => /subdivision and hole faces are unsupported/.test(i.message)));
});

test('a mesh of scheme none keeps its faces and level 0 keeps its points', async () => {
  const none = await text(cube('uniform token subdivisionScheme = "none"'), [subdivision()]);
  assert.equal(triangles(none.meshes[0]), 12);
  const zero = await text(cube(), [subdivision({ level: 0 })]);
  assert.equal(triangles(zero.meshes[0]), 12);
});

test('a hole leaves its faces out and the rest still bends around it', async () => {
  const whole = await text(cube(), [subdivision({ level: 2 })]),
    holed = await text(cube('int[] holeIndices = [1]'), [subdivision({ level: 2 })]);
  // Each quad of the cage is four at level 1 and sixteen at level 2, two triangles each.
  assert.equal(triangles(whole.meshes[0]), 6 * 16 * 2);
  assert.equal(triangles(holed.meshes[0]), 5 * 16 * 2);
  assert.ok(reach(holed.meshes[0].positions, whole.meshes[0].positions) < 1e-6, 'the points left stay where the whole mesh has them');
});

test('a hole in a mesh that is not subdivided is left out too', async () => {
  const asset = await text(cube('uniform token subdivisionScheme = "none"\n    int[] holeIndices = [0, 5]'), [subdivision()]);
  assert.equal(triangles(asset.meshes[0]), 8);
});

const ARROW = (extra = '') => `#usda 1.0
(
    defaultPrim = "M"
    metersPerUnit = 1
    upAxis = "Y"
)
def Mesh "M"
{
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [6]
    int[] faceVertexIndices = [0, 1, 2, 3, 4, 5]
    point3f[] points = [(0, 0, 0), (4, 0, 0), (4, 1, 0), (1, 1, 0), (1, 4, 0), (0, 4, 0)]
    ${extra}
}`;
const area = ({ positions, indices }) => {
  const list = indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  let signed = 0;
  for (let t = 0; t < list.length; t += 3) {
    const [a, b, c] = [list[t] * 3, list[t + 1] * 3, list[t + 2] * 3];
    signed += ((positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) - (positions[b + 1] - positions[a + 1]) * (positions[c] - positions[a])) / 2;
  }
  return signed;
};
test('a concave polygon becomes triangles that cover it, turning its own way', async () => {
  const asset = await text(ARROW(), [subdivision()]);
  assert.equal(triangles(asset.meshes[0]), 4);
  // Every triangle turns as the polygon does, so signed area is the polygon's own: an L of area 7.
  assert.ok(Math.abs(area(asset.meshes[0]) - 7) < 1e-6);
  const back = await text(ARROW('uniform token orientation = "leftHanded"'), [subdivision()]);
  assert.ok(Math.abs(Math.abs(area(back.meshes[0])) - 7) < 1e-6);
});

test('a face that crosses itself keeps all its triangles, as real photogrammetry needs', async () => {
  const asset = await text(
    `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Mesh "Cross"
{
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [4, 4]
    int[] faceVertexIndices = [0, 1, 2, 3, 4, 5, 6, 7]
    point3f[] points = [(0, 0, 0), (2, 2, 0), (2, 0, 0), (0, 3, 0), (3, 0, 0), (5, 0, 0), (4, 1, 0), (5, 2, 0)]
}`,
    [subdivision()],
  );
  // The first crosses itself, the second is concave and splits: each stays two triangles.
  assert.equal(triangles(asset.meshes[0]), 4);
});

test('values on a split polygon stay with their corners', async () => {
  const asset = await text(ARROW('texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 0.25), (0.25, 0.25), (0.25, 1), (0, 1)] (interpolation = "vertex")'), [subdivision()]),
    { positions, uvs } = asset.meshes[0];
  for (let v = 0; v < positions.length / 3; v++) {
    assert.ok(Math.abs(uvs[v * 2] - positions[v * 3] / 4) < 1e-6);
    assert.ok(Math.abs(uvs[v * 2 + 1] - positions[v * 3 + 1] / 4) < 1e-6);
  }
});

test('a material subset keeps its faces through refinement', async () => {
  const usda = `#usda 1.0
(
    defaultPrim = "M"
    metersPerUnit = 1
    upAxis = "Y"
)
def Mesh "M"
{
    ${CUBE}
    def GeomSubset "Top"
    {
        uniform token elementType = "face"
        uniform token familyName = "materialBind"
        int[] indices = [1, 3]
        rel material:binding = </Red>
    }
}
def Material "Red"
{
    token outputs:surface.connect = </Red/S.outputs:surface>
    def Shader "S"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (1, 0, 0)
        token outputs:surface
    }
}`;
  const { subsets } = (await text(usda, [subdivision({ level: 1 })])).meshes[0];
  const top = subsets.find((s) => s.path.endsWith('Top'));
  // Two of six quads, four refined quads each, two triangles each, three corners each.
  assert.equal(top.indices.length, 2 * 4 * 2 * 3);
});

test('a refined mesh has smooth normals of its own, sharp across a crease', async () => {
  const soft = (await text(cube(), [subdivision({ level: 2 })])).meshes[0],
    hard = (await text(cube('int[] creaseIndices = [0, 1]\n    int[] creaseLengths = [2]\n    float[] creaseSharpnesses = [10]'), [subdivision({ level: 2 })])).meshes[0];
  const normalsAt = ({ positions, normals }) => {
    const seen = new Map();
    for (let v = 0; v < positions.length / 3; v++) {
      const key = [0, 1, 2].map((d) => positions[v * 3 + d].toFixed(4)).join(),
        n = [0, 1, 2].map((d) => normals[v * 3 + d].toFixed(3)).join();
      (seen.get(key) ?? seen.set(key, new Set()).get(key)).add(n);
    }
    return Math.max(...[...seen.values()].map((s) => s.size));
  };
  assert.equal(normalsAt(soft), 1);
  assert.ok(normalsAt(hard) > 1);
});

test('the level comes down when the stage would pass maxTriangles, and the issue says so', async () => {
  const asset = await text(cube(), [subdivision({ level: 4 })], { maxTriangles: 200 });
  assert.ok(asset.issues.some((i) => /subdivision level 4 would pass maxTriangles; the stage uses level 2/.test(i.message)));
  assert.equal(triangles(asset.meshes[0]), 6 * 16 * 2);
});

test('a level out of range is refused', () => {
  for (const level of [-1, 1.5, 7]) assert.throws(() => subdivision({ level }), RangeError);
});

const icosahedron = () => {
  const t = (1 + Math.sqrt(5)) / 2;
  return {
    points: [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1],
    faces: [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1],
  };
};
const hookOn = ({ points, faces: list }, level, values) =>
  subdivision({ level }).shape({
    specs: {},
    path: '/M',
    points,
    counts: new Array(list.length / 3).fill(3),
    faces: list,
    flip: false,
    maxTriangles: 1e9,
    value: (name) => values[name],
    attr: () => undefined,
    soft: () => {},
  });

test('Loop: a point of valence five moves by Loop\'s beta, an edge point by 3/8 and 1/8', () => {
  const cage = icosahedron(),
    { points } = hookOn(cage, 1, { subdivisionScheme: 'loop' }),
    at = (list, i) => list.slice(i * 3, i * 3 + 3),
    // Neighbours of point 0, from the face list above.
    ring = [11, 5, 1, 7, 10],
    middle = 3 / 8 + Math.cos((2 * Math.PI) / 5) / 4,
    beta = (5 / 8 - middle * middle) / 5;
  for (let d = 0; d < 3; d++) {
    const want = (1 - 5 * beta) * cage.points[d] + beta * ring.reduce((sum, v) => sum + cage.points[v * 3 + d], 0);
    assert.ok(Math.abs(at(points, 0)[d] - want) < 1e-5);
  }
  // Edge 0 to 5 has opposite corners 11 and 1.
  const want = [0, 1, 2].map((d) => (3 / 8) * (cage.points[d] + cage.points[15 + d]) + (cage.points[33 + d] + cage.points[3 + d]) / 8);
  assert.ok(reach(want, points) < 1e-5);
});

test('Loop: two levels match the geometry package, a separate build of the same paper', () => {
  const cage = icosahedron(),
    shape = hookOn(cage, 2, { subdivisionScheme: 'loop' }),
    other = loopSubdivide({ positions: new Float32Array(cage.points), indices: new Uint32Array(cage.faces), normals: new Float32Array(cage.points.length), uvs: new Float32Array((cage.points.length / 3) * 2) }, 2);
  assert.equal(shape.faces.length / 3, 20 * 16);
  assert.ok(reach(shape.points, other.positions) < 1e-5);
  assert.ok(reach(other.positions, shape.points) < 1e-5);
});

test('Loop: a sharp edge stays on its line, a boundary keeps its corners', () => {
  const sharp = hookOn(icosahedron(), 1, { subdivisionScheme: 'loop', creaseIndices: [0, 5], creaseLengths: [2], creaseSharpnesses: [10] }),
    cage = icosahedron(),
    mid = [0, 1, 2].map((d) => (cage.points[d] + cage.points[15 + d]) / 2);
  assert.ok(reach(mid, sharp.points) < 1e-5);
  const open = hookOn({ points: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0], faces: [0, 1, 2, 0, 2, 3] }, 2, { subdivisionScheme: 'loop' });
  for (const corner of [[2, 0, 0], [0, 2, 0]]) assert.ok(reach(corner, open.points) < 1e-6);
});

test('Loop on faces that are not triangles refines as Catmull-Clark and says so', async () => {
  const asset = await text(cube('uniform token subdivisionScheme = "loop"'), [subdivision({ level: 1 })]);
  assert.ok(asset.issues.some((i) => /Loop subdivision, which takes triangles only/.test(i.message)));
  assert.equal(triangles(asset.meshes[0]), 6 * 4 * 2);
});

test('bilinear keeps the cage\'s shape', async () => {
  const { positions } = (await text(cube('uniform token subdivisionScheme = "bilinear"'), [subdivision({ level: 2 })])).meshes[0];
  for (let i = 0; i < positions.length; i++) assert.ok(Math.abs(positions[i]) <= 1 + 1e-6);
  assert.ok(reach([1, 1, 1, 0, 1, 1], positions) < 1e-6);
});

const RIG = `#usda 1.0
(
    defaultPrim = "Rig"
    metersPerUnit = 1
    upAxis = "Y"
)
def SkelRoot "Rig" (
    prepend apiSchemas = ["SkelBindingAPI"]
)
{
    rel skel:skeleton = </Rig/Bones>
    def Skeleton "Bones"
    {
        uniform token[] joints = ["A", "A/B"]
        uniform matrix4d[] bindTransforms = [((1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1)), ((1,0,0,0),(0,1,0,0),(0,0,1,0),(0,1,0,1))]
        uniform matrix4d[] restTransforms = [((1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1)), ((1,0,0,0),(0,1,0,0),(0,0,1,0),(0,1,0,1))]
    }
    def Mesh "M" (
        prepend apiSchemas = ["SkelBindingAPI"]
    )
    {
        ${CUBE}
        rel skel:skeleton = </Rig/Bones>
        uniform token[] skel:blendShapes = ["Up"]
        rel skel:blendShapeTargets = </Rig/M/Up>
        int[] primvars:skel:jointIndices = [0, 0, 0, 0, 1, 1, 1, 1] (elementSize = 1; interpolation = "vertex")
        float[] primvars:skel:jointWeights = [1, 1, 1, 1, 1, 1, 1, 1] (elementSize = 1; interpolation = "vertex")
        def BlendShape "Up"
        {
            uniform vector3f[] offsets = [(0, 2, 0)]
            uniform int[] pointIndices = [2]
        }
    }
}`;
test('a refined skin takes its influences from the points it comes from, and blend shape offsets refine too', async () => {
  const asset = await text(RIG, [skeletons(), subdivision({ level: 1 })]),
    primitive = asset.document.meshes[0].primitives[0],
    read = (accessor) => {
      const { bufferView, count, type } = asset.document.accessors[accessor],
        view = asset.document.bufferViews[bufferView],
        data = asset.buffers[view.buffer];
      return { data, count, type };
    },
    { data: weights, count } = read(primitive.attributes.WEIGHTS_0),
    { data: joints } = read(primitive.attributes.JOINTS_0);
  assert.equal(count, 6 * 4 * 2 * 3);
  let mixed = 0;
  for (let v = 0; v < count; v++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += weights[v * 4 + k];
    assert.ok(Math.abs(sum - 1) < 1e-5, 'influences keep their total');
    if (weights[v * 4 + 1] > 0) {
      mixed++;
      assert.notEqual(joints[v * 4], joints[v * 4 + 1]);
    }
  }
  assert.ok(mixed > 0, 'points between the two halves take both joints');
  // Authored point 2 has valence three, so by Catmull and Clark its refined point holds (n - 2) / n of itself, 1 / n^2 of each
  // neighbour and face mean: 1/3 + 3/9 * 0 + 3 * (1/4) / 9 = 5/12. The largest refined move is that share of the offset, 2.
  const { data: morph } = read(primitive.targets[0].POSITION);
  let most = 0,
    moved = 0;
  for (let v = 0; v < count; v++) {
    most = Math.max(most, morph[v * 3 + 1]);
    if (morph[v * 3 + 1] > 0) moved++;
  }
  assert.ok(Math.abs(most - (5 / 12) * 2) < 1e-5, `largest move ${most}`);
  assert.ok(moved > 3 && moved < count, 'the offset spreads to the neighbours, not everywhere');
});

test('uniform and vertex primvars reach the refined faces', async () => {
  const uniform = await text(cube('texCoord2f[] primvars:st = [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (5, 0)] (interpolation = "uniform")'), [subdivision({ level: 1 })]);
  const { uvs } = uniform.meshes[0];
  assert.equal(uvs.length / 2, 6 * 4 * 2 * 3);
  for (let t = 0; t < uvs.length; t += 2) assert.equal(uvs[t], Math.floor(t / 2 / (4 * 2 * 3)));
  const vertex = await text(cube('texCoord2f[] primvars:st = [(-1, -1), (1, -1), (-1, 1), (1, 1), (-1, 1), (1, 1), (-1, -1), (1, -1)] (interpolation = "vertex")'), [subdivision({ level: 1 })]);
  // Linear in the points' x and y, so the values refine with them.
  const { positions, uvs: smooth } = vertex.meshes[0];
  for (let v = 0; v < positions.length / 3; v++) {
    assert.ok(Math.abs(positions[v * 3] - smooth[v * 2]) < 1e-5);
    assert.ok(Math.abs(positions[v * 3 + 1] - smooth[v * 2 + 1]) < 1e-5);
  }
});
