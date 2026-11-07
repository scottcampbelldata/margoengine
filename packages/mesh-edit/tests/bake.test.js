import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimitiveMesh } from '@margoengine/mesh-edit';
import { bakeMeshMaps, bakeSurfaceMaps } from '@margoengine/mesh-edit/bake';
import { subdivideMesh } from '@margoengine/mesh-edit/modeling';

let next = 0;
const createId = () => `b${next++}`;

/** A 1 by 1 quad in the XZ plane facing +Y, as `low`, with UVs u = x + 0.5 and v = z + 0.5. */
function lowPlane() {
  const vertices = [
    [-0.5, 0, -0.5],
    [-0.5, 0, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0, -0.5],
  ];
  return {
    vertices,
    faces: [{ id: 'q', vertices: [0, 1, 2, 3], uv: vertices.map(([x, , z]) => [x + 0.5, z + 0.5]) }],
  };
}

/** A grid of triangles over the same square whose height is `f(x, z)`, in fine steps. */
function highGrid(f, steps = 64) {
  const vertices = [],
    faces = [],
    at = (i, j) => i * (steps + 1) + j,
    uv = (i, j) => [i / steps, j / steps];
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= steps; j++) {
      const x = i / steps - 0.5,
        z = j / steps - 0.5;
      vertices.push([x, f(x, z), z]);
    }
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      faces.push({
        id: `${i}.${j}a`,
        vertices: [at(i, j), at(i, j + 1), at(i + 1, j + 1)],
        uv: [uv(i, j), uv(i, j + 1), uv(i + 1, j + 1)],
      });
      faces.push({
        id: `${i}.${j}b`,
        vertices: [at(i, j), at(i + 1, j + 1), at(i + 1, j)],
        uv: [uv(i, j), uv(i + 1, j + 1), uv(i + 1, j)],
      });
    }
  return { vertices, faces };
}

const texel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test('a flat surface bakes the flat normal', () => {
  const { normal, covered, missed } = bakeMeshMaps(
    lowPlane(),
    highGrid(() => 0.01),
    { width: 32 },
  );
  assert.equal(covered, 32 * 32);
  assert.equal(missed, 0);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const [r, g, b, a] = texel(normal, x, y);
      assert.ok(Math.abs(r - 128) <= 1 && Math.abs(g - 128) <= 1 && b >= 254 && a === 255, `${x},${y}: ${r} ${g} ${b}`);
    }
});

test('a slope bakes the matching tilt, with X in red and glTF green', () => {
  // Height rises with x: the surface normal leans to -x, so red drops below 128. Height rising with z leans toward -z,
  // and z runs with V, which points down the image, so tangent-space Y (up the image) is positive: green rises.
  const slope = 0.5,
    length = Math.hypot(slope, 1),
    expected = (128 - (slope / length) * 127.5) | 0,
    tiltX = bakeMeshMaps(
      lowPlane(),
      highGrid((x) => x * slope),
      { width: 16, distance: 1 },
    ).normal,
    [r, g] = texel(tiltX, 8, 8);
  assert.ok(Math.abs(r - expected) <= 2, `red ${r} against ${expected}`);
  assert.ok(Math.abs(g - 128) <= 2);
  const tiltZ = bakeMeshMaps(
      lowPlane(),
      highGrid((_, z) => z * slope),
      { width: 16, distance: 1 },
    ).normal,
    [r2, g2] = texel(tiltZ, 8, 8);
  assert.ok(Math.abs(r2 - 128) <= 2);
  assert.ok(Math.abs(g2 - (255 - expected)) <= 2, `green ${g2}`);
});

test('detail lost by simplifying comes back: a bump shows in the map at the right place', () => {
  const bump = (x, z) => 0.08 * Math.exp(-((x - 0.2) ** 2 + (z + 0.1) ** 2) / 0.01),
    { normal } = bakeMeshMaps(lowPlane(), highGrid(bump, 96), { width: 64, distance: 0.2 }),
    at = (x, z) => texel(normal, Math.floor((x + 0.5) * 64), Math.floor((z + 0.5) * 64));
  assert.ok(at(0.2, -0.1)[2] > 250, 'flat on top of the bump');
  assert.ok(at(0.27, -0.1)[0] > 150, 'leans out on the far side');
  assert.ok(at(0.13, -0.1)[0] < 106, 'leans out on the near side');
  assert.ok(Math.abs(at(-0.3, 0.3)[0] - 128) <= 1, 'flat elsewhere');
});

test('rays search both ways: a high surface below the low one still hits', () => {
  const { normal, missed } = bakeMeshMaps(
    lowPlane(),
    highGrid(() => -0.02),
    { width: 8 },
  );
  assert.equal(missed, 0);
  assert.ok(texel(normal, 4, 4)[2] >= 254);
});

test('a ray that finds nothing keeps the flat normal and is counted', () => {
  const { normal, missed, covered } = bakeMeshMaps(
    lowPlane(),
    highGrid(() => 5),
    { width: 8, distance: 0.1 },
  );
  assert.equal(missed, covered);
  assert.deepEqual(texel(normal, 4, 4), [128, 128, 255, 255]);
});

test('occlusion is dark in a pit and open on a flat top, and repeats by seed', () => {
  const pit = (x, z) => (Math.hypot(x, z) < 0.15 ? -0.3 : 0),
    high = highGrid(pit, 96),
    options = { width: 32, maps: ['ao'], aoRays: 64, distance: 0.4, aoDistance: 2 },
    { ao } = bakeMeshMaps(lowPlane(), high, options),
    { ao: again } = bakeMeshMaps(lowPlane(), high, options);
  assert.ok(texel(ao, 16, 16)[0] < 150, `pit ${texel(ao, 16, 16)[0]}`);
  assert.ok(texel(ao, 3, 3)[0] > 240, `top ${texel(ao, 3, 3)[0]}`);
  assert.deepEqual(ao.data, again.data);
});

test('colour comes from the high mesh by texture or by function', () => {
  const image = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) },
    high = highGrid(() => 0),
    { color } = bakeMeshMaps(lowPlane(), high, { width: 8, maps: ['color'], color: image });
  assert.deepEqual(texel(color, 1, 4), [255, 0, 0, 255]);
  assert.deepEqual(texel(color, 6, 4), [0, 0, 255, 255]);
  const { color: made } = bakeMeshMaps(lowPlane(), high, {
    width: 8,
    maps: ['color'],
    color: ({ point, normal, uv, face }) => {
      assert.equal(typeof face, 'string');
      assert.ok(Math.abs(normal[1]) > 0.99);
      assert.ok(Math.abs(uv[0] - (point[0] + 0.5)) < 1e-9);
      return [point[0] > 0 ? 200 : 10, 20, 30, 255];
    },
  });
  assert.deepEqual(texel(made, 6, 4), [200, 20, 30, 255]);
});

test('padding grows islands past their edges, and zero padding leaves the background', () => {
  const low = lowPlane();
  low.faces[0].uv = low.faces[0].uv.map(([u, v]) => [u * 0.5 + 0.25, v * 0.5 + 0.25]);
  const high = highGrid(() => 0),
    padded = bakeMeshMaps(low, high, { width: 32, padding: 3 }).normal,
    bare = bakeMeshMaps(low, high, { width: 32, padding: 0 }).normal;
  assert.equal(texel(bare, 6, 16)[3], 0);
  assert.equal(texel(padded, 6, 16)[3], 255);
  assert.equal(texel(padded, 3, 16)[3], 0);
});

test('a simplified sphere keeps its roundness: flat low faces bake normals that lean with the sphere', () => {
  let high = createPrimitiveMesh('cube', 'hi');
  for (let i = 0; i < 4; i++) high = subdivideMesh(high, { createId }).mesh;
  const round = {
      vertices: high.vertices.map((p) => p.map((x) => x / Math.hypot(...p))),
      faces: high.faces.flatMap((face) =>
        face.vertices.slice(1, -1).map((_, i) => ({
          id: `${face.id}.${i}`,
          vertices: [face.vertices[0], face.vertices[i + 1], face.vertices[i + 2]],
          uv: [face.uv[0], face.uv[i + 1], face.uv[i + 2]],
        })),
      ),
    },
    cap = lowPlane();
  cap.vertices = cap.vertices.map(([x, , z]) => [x, 0.9, z]);
  const { normal, missed } = bakeMeshMaps(cap, round, { width: 32, distance: 0.5 });
  assert.equal(missed, 0);
  const left = texel(normal, 6, 16)[0],
    right = texel(normal, 26, 16)[0];
  assert.ok(left < 100 && right > 156, `red from ${left} to ${right}`);
});

test('bad options reject and abort stops the bake', () => {
  const low = lowPlane(),
    high = highGrid(() => 0, 4);
  assert.throws(() => bakeMeshMaps(low, high, { width: 0 }), RangeError);
  assert.throws(() => bakeMeshMaps(low, high, { maps: ['height'] }), TypeError);
  assert.throws(() => bakeMeshMaps(low, high, { maps: ['color'] }), TypeError);
  assert.throws(() => bakeMeshMaps(low, high, { aoRays: 0 }), RangeError);
  assert.throws(() => bakeMeshMaps(low, high, { padding: -1 }), RangeError);
  assert.throws(() => bakeMeshMaps(low, high, { distance: -1 }), RangeError);
  assert.throws(() => bakeMeshMaps(low, high, { signal: {} }), TypeError);
  assert.throws(() => bakeMeshMaps(low, high, { signal: AbortSignal.abort(new RangeError('stop')) }), {
    message: 'stop',
  });
});

/** A unit square facing +Z, UVs as its X and Y. */
const square = (rest = {}) => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  ...rest,
});
/** The same square leaning over: its normal tips toward -X, by about 26.6 degrees. */
const leaning = () => {
  const n = [-0.5 / Math.hypot(0.5, 1), 0, 1 / Math.hypot(0.5, 1)];
  return square({
    positions: [0, 0, -0.25, 1, 0, 0.25, 1, 1, 0.25, 0, 1, -0.25],
    normals: [...n, ...n, ...n, ...n],
  });
};
const middle = ({ data, width }) => [...data.subarray(((width >> 1) * width + (width >> 1)) * 4, ((width >> 1) * width + (width >> 1)) * 4 + 3)];

test('bakeSurfaceMaps writes in the frame the low surface shades with', () => {
  const options = { width: 16, distance: 1 },
    high = leaning(),
    // X is the tangent, as UVs have it: the lean is all red. The bitangent is Y, so green stays flat.
    fromUVs = middle(bakeSurfaceMaps(square(), high, options).normal),
    // Tangent Y, sign 1: the bitangent, N x T, is -X, so the lean moves to green.
    turned = middle(
      bakeSurfaceMaps(square({ tangents: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1] }), high, options).normal,
    ),
    // The same tangent with sign -1 flips the bitangent, and green with it.
    mirrored = middle(
      bakeSurfaceMaps(square({ tangents: [0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1] }), high, options).normal,
    );
  assert.ok(Math.abs(fromUVs[0] - 70) < 3 && Math.abs(fromUVs[1] - 127.5) < 3, String(fromUVs));
  assert.ok(Math.abs(turned[0] - 127.5) < 3 && Math.abs(turned[1] - 185) < 3, String(turned));
  assert.ok(Math.abs(mirrored[0] - 127.5) < 3 && Math.abs(mirrored[1] - 70) < 3, String(mirrored));
});

test('a tangent w of 0 means no tangents: the frame comes from the UVs, as a shader with none does', () => {
  const options = { width: 16, distance: 1 },
    none = bakeSurfaceMaps(square({ tangents: new Float32Array(16) }), leaning(), options).normal,
    plain = bakeSurfaceMaps(square(), leaning(), options).normal;
  assert.deepEqual([...none.data], [...plain.data]);
});

test('bakeSurfaceMaps leaves along the low normals it is given, and reads the high normals as given', () => {
  // The same flat surfaces, so only the given normals can make the map lean.
  const tilted = [0.6, 0, 0.8],
    low = square({ normals: [...tilted, ...tilted, ...tilted, ...tilted] }),
    high = square({ positions: [0, 0, 0.1, 1, 0, 0.1, 1, 1, 0.1, 0, 1, 0.1] }),
    texel = middle(bakeSurfaceMaps(low, high, { width: 16, distance: 1 }).normal);
  assert.ok(texel[2] < 240, `a high normal of +Z is off a low normal of ${tilted}: ${texel}`);
});

test('shared counts the texels overlapping UVs fight over, and a clean layout has almost none', () => {
  const stacked = square({
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
      normals: new Array(8).fill([0, 0, 1]).flat(),
      uvs: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1],
      indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    }),
    clean = bakeSurfaceMaps(square(), square(), { width: 32 }),
    fought = bakeSurfaceMaps(stacked, square(), { width: 32 });
  assert.ok(clean.shared <= clean.covered * 0.05, `${clean.shared} of ${clean.covered}`);
  assert.ok(fought.shared >= fought.covered * 0.95, `${fought.shared} of ${fought.covered}`);
});

test('bakeSurfaceMaps names a triangle in a colour sample, and refuses surfaces that do not fit', () => {
  const seen = new Set();
  bakeSurfaceMaps(square(), square(), {
    width: 8,
    distance: 1,
    maps: ['color'],
    color: ({ face }) => (seen.add(face), [0, 0, 0, 255]),
  });
  assert.deepEqual([...seen].sort(), ['0', '1']);
  assert.throws(() => bakeSurfaceMaps(square({ uvs: [0, 0] }), square()), TypeError);
  assert.throws(() => bakeSurfaceMaps(square(), square({ indices: [0, 1, 9] })), TypeError);
  assert.throws(() => bakeSurfaceMaps(square({ tangents: [1, 0, 0] }), square()), TypeError);
  assert.throws(() => bakeSurfaceMaps(square(), square({ normals: [0, 0, 1] })), TypeError);
});
