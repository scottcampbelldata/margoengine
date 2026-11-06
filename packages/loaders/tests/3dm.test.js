// parse3DM against a stand-in runtime with rhino3dm's shape, which counts every object it hands out and frees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3DM } from '../dist/3dm.js';
import { LoaderError } from '../dist/common.js';

const refuses = (run, code) =>
  assert.throws(run, (error) => error instanceof LoaderError && error.format === '3DM' && error.code === code);
const BYTES = new Uint8Array([1, 2, 3]);

/** Builds a runtime around `objects`, `layers` and `unit`; `live` counts handles not yet freed. */
function runtime({ objects = [], layers = [], unit = { value: 2 } } = {}) {
  const state = { live: 0, bytes: undefined, type: undefined };
  const handle = (value) => {
    state.live++;
    value.delete = () => void state.live--;
    return value;
  };
  const table = (items, wrap = (item) => item) => handle({ count: items.length, get: (i) => wrap(items[i]) });
  const mesh = ({ vertices, faces, normals, uvs, colors }) =>
    handle({
      vertices: () => table(vertices),
      faces: () => table(faces),
      normals: () => table(normals ?? []),
      textureCoordinates: () => table(uvs ?? []),
      vertexColors: () => table(colors ?? []),
    });
  // get() gives a control point multiplied by its weight, as the real runtime does.
  const nurbs = ({ countU, countV, knotsU, knotsV, degree = 1, point, weight = () => 1 }) =>
    handle({
      degree: () => degree,
      knotsU: () => table(knotsU),
      knotsV: () => table(knotsV),
      points: () =>
        handle({
          countU,
          countV,
          getPoint: point,
          get: (u, v) => [...point(u, v).map((x) => x * weight(u, v)), weight(u, v)],
        }),
    });
  const geometry = (source) => {
    if (source.mesh) return mesh(source.mesh);
    if (source.renderMesh !== undefined)
      return handle({
        getMesh: (type) => ((state.type = type), source.renderMesh && mesh(source.renderMesh)),
      });
    if (source.surface) return nurbs(source.surface);
    if (source.faces)
      return handle({
        // Like a real solid: vertices of its own kind, which are not a mesh's triples.
        vertices: () => table([{ location: [0, 0, 0] }]),
        isSurface: source.isSurface,
        faces: () =>
          table(source.faces, (face) =>
            handle({
              getMesh: () => (face?.vertices ? mesh(face) : null),
              orientationIsReversed: face?.reversed,
              underlyingSurface: () => handle({ toNurbsSurface: () => nurbs(face.surface) }),
            }),
          ),
      });
    return handle({});
  };
  return {
    state,
    MeshType: { Any: 'any' },
    File3dm: {
      fromByteArray(bytes) {
        state.bytes = bytes;
        if (bytes.length === 0) return null;
        return handle({
          objects: () =>
            table(objects, (object) =>
              handle({
                geometry: () => geometry(object),
                attributes: () => handle({ drawColor: object.color && (() => object.color), ...object.attributes }),
              }),
            ),
          layers: () => table(layers, (layer) => handle({ ...layer })),
          settings: () => handle({ modelUnitSystem: unit }),
        });
      },
    },
  };
}

const TRIANGLE = {
  vertices: [
    [0, 0, 0],
    [1000, 0, 0],
    [0, 1000, 0],
  ],
  faces: [[0, 1, 2, 2]],
};
const QUAD = {
  vertices: [
    [0, 0, 0],
    [1000, 0, 0],
    [1000, 1000, 0],
    [0, 1000, 0],
  ],
  faces: [[0, 1, 2, 3]],
};

test('a mesh object reads, in metres by the file unit, and every handle is freed', () => {
  const rhino = runtime({ objects: [{ mesh: QUAD }] });
  const model = parse3DM(rhino, BYTES);
  assert.deepEqual([...model.positions.subarray(3, 6)], [1, 0, 0]);
  assert.deepEqual([...model.indices], [0, 1, 2, 0, 2, 3]);
  assert.equal(model.metersPerUnit, 1e-3);
  assert.equal(rhino.state.live, 0);
  assert.equal(rhino.state.bytes, BYTES);
  assert.deepEqual([...parse3DM(runtime({ objects: [{ mesh: QUAD }] }), BYTES, { units: 'file' }).positions.subarray(3, 6)], [1000, 0, 0]);
});

test('a triangle face repeats its last corner and gives one triangle', () => {
  assert.deepEqual([...parse3DM(runtime({ objects: [{ mesh: TRIANGLE }] }), BYTES).indices], [0, 1, 2]);
});

test('a plain number unit, and a file with no known unit, both read', () => {
  assert.equal(parse3DM(runtime({ objects: [{ mesh: TRIANGLE }], unit: 9 }), BYTES).metersPerUnit, 0.3048);
  const none = parse3DM(runtime({ objects: [{ mesh: TRIANGLE }], unit: { value: 0 } }), BYTES);
  assert.equal(none.metersPerUnit, undefined);
  assert.equal(none.positions[3], 1000);
});

test('attributes, user strings, layers and draw colours reach the group', () => {
  const model = parse3DM(
    runtime({
      layers: [{ name: 'Walls', fullPath: 'House::Walls', color: { r: 255, g: 0, b: 0, a: 255 }, visible: true }],
      objects: [
        {
          mesh: TRIANGLE,
          color: { r: 0, g: 255, b: 0, a: 255 },
          attributes: { name: 'door', id: 'abc', layerIndex: 0, materialIndex: 3, getUserStrings: () => [['__proto__', 'x'], ['part', '12']] },
        },
        { mesh: TRIANGLE, attributes: { layerIndex: 0 } },
      ],
    }),
    BYTES,
  );
  assert.deepEqual(model.layers, [{ name: 'Walls', path: 'House::Walls', color: [1, 0, 0, 1], visible: true }]);
  const [first, second] = model.groups;
  assert.equal(first.name, 'door');
  assert.equal(first.id, 'abc');
  assert.equal(first.layer, 0);
  assert.equal(first.material, 3);
  assert.deepEqual(first.color, [0, 1, 0, 1]);
  assert.equal(first.userStrings.part, '12');
  assert.equal(first.userStrings.__proto__, 'x');
  assert.deepEqual(second.color, [1, 0, 0, 1], 'an object without its own colour takes its layer');
  assert.equal(second.start, 3);
  assert.deepEqual([...model.indices.subarray(3)], [3, 4, 5]);
});

test('normals, coordinates and colours stay aligned when only one mesh has them', () => {
  const model = parse3DM(
    runtime({
      objects: [
        { mesh: TRIANGLE },
        {
          mesh: {
            ...TRIANGLE,
            normals: [
              [0, 0, 1],
              [0, 0, 1],
              [0, 0, 1],
            ],
            uvs: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
            colors: [
              { r: 255, g: 0, b: 0, a: 255 },
              { r: 0, g: 0, b: 0, a: 255 },
              { r: 0, g: 0, b: 0, a: 255 },
            ],
          },
        },
      ],
    }),
    BYTES,
  );
  assert.equal(model.normals.length, 18);
  assert.deepEqual([...model.normals.subarray(9, 12)], [0, 0, 1]);
  assert.equal(model.uvs.length, 12);
  assert.deepEqual([...model.uvs.subarray(6, 8)], [0, 1], 'v turns over');
  assert.deepEqual([...model.colors.subarray(0, 3)], [1, 1, 1]);
  assert.deepEqual([...model.colors.subarray(9, 12)], [1, 0, 0]);
});

test('other surfaces use their saved render meshes; objects with none are counted', () => {
  const rhino = runtime({
    objects: [{ renderMesh: TRIANGLE }, { faces: [TRIANGLE, null, QUAD] }, { renderMesh: null }, { faces: [null] }, {}],
  });
  const model = parse3DM(rhino, BYTES);
  assert.equal(model.groups.length, 2);
  assert.equal(model.indices.length, 12);
  assert.equal(model.groups[1].count, 9);
  assert.equal(model.skipped, 3);
  assert.equal(rhino.state.type, 'any');
  assert.equal(rhino.state.live, 0);
});

test('hidden objects and hidden layers stay out unless asked for', () => {
  const scene = () => ({
    layers: [{ name: 'off', visible: false }],
    objects: [{ mesh: TRIANGLE, attributes: { layerIndex: 0 } }, { mesh: TRIANGLE, attributes: { visible: false } }, { mesh: TRIANGLE }],
  });
  assert.equal(parse3DM(runtime(scene()), BYTES).groups.length, 1);
  assert.equal(parse3DM(runtime(scene()), BYTES, { hidden: true }).groups.length, 3);
});

test('bad input is a named error, and a failure still frees every handle', () => {
  refuses(() => parse3DM({}, BYTES), 'range');
  refuses(() => parse3DM(runtime(), new Uint8Array(0)), 'header');
  refuses(() => parse3DM(runtime(), BYTES, { units: 'feet' }), 'range');
  const bad = runtime({ objects: [{ mesh: { ...TRIANGLE, faces: [[0, 1, 9, 9]] } }] });
  refuses(() => parse3DM(bad, BYTES), 'range');
  assert.equal(bad.state.live, 0);
  const big = runtime({ objects: [{ mesh: QUAD }] });
  refuses(() => parse3DM(big, BYTES, { maxVertices: 3 }), 'limit');
  assert.equal(big.state.live, 0);
  refuses(() => parse3DM(runtime({ objects: [{ mesh: QUAD }] }), BYTES, { maxTriangles: 1 }), 'limit');
});

test('regression: a table whose own delete removes an entry is freed through the handle base, as in real rhino3dm', () => {
  // rhino3dm's File3dmLayerTable.delete(id) hides the handle's delete(): called with no id it throws.
  let live = 0;
  class Handle {
    constructor() {
      live++;
    }
    isDeleted() {
      return false;
    }
    delete() {
      live--;
    }
  }
  class LayerTable extends Handle {
    count = 1;
    get() {
      return Object.assign(new Handle(), { name: 'Default', visible: true });
    }
    delete(id) {
      assert.equal(arguments.length, 1, 'File3dmLayerTable.delete called with an invalid number of arguments');
      throw new Error(`layer ${id} removed`);
    }
  }
  class Document extends Handle {
    objects() {
      return Object.assign(new Handle(), { count: 0 });
    }
    layers() {
      return new LayerTable();
    }
  }
  const model = parse3DM({ File3dm: { fromByteArray: () => new Document() } }, BYTES);
  assert.equal(model.layers[0].name, 'Default');
  assert.equal(live, 0);
});

const PLANE = {
  countU: 2,
  countV: 3,
  knotsU: [0, 1],
  knotsV: [0, 1, 2],
  point: (u, v) => [u * 1000, v * 1000, 0],
};

test('a surface object saved with no render mesh is drawn through the NURBS evaluator, every handle freed', () => {
  const rhino = runtime({ objects: [{ surface: PLANE }] }),
    g = parse3DM(rhino, BYTES, { segmentsU: 2, segmentsV: 1 });
  assert.equal(g.surfaces, 1);
  assert.equal(g.skipped, 0);
  assert.equal(g.positions.length / 3, 3 * 3);
  assert.equal(g.indices.length / 3, 2 * 2 * 2);
  assert.deepEqual([...g.positions.slice(-3)], [1, 2, 0]);
  assert.deepEqual([...g.normals.slice(0, 3)], [0, 0, 1]);
  assert.equal(g.groups[0].count, g.indices.length);
  assert.equal(rhino.state.live, 0);
});

test('a weighted control point is read without its weight', () => {
  const rhino = runtime({ objects: [{ surface: { ...PLANE, weight: (u) => (u ? 2 : 1) } }] }),
    g = parse3DM(rhino, BYTES, { segmentsU: 1, segmentsV: 1, units: 'file' });
  assert.deepEqual([...g.positions.slice(-3)], [1000, 2000, 0]);
});

test('a solid that is one plain surface draws, with a reversed face turned over', () => {
  const rhino = runtime({ objects: [{ isSurface: true, faces: [{ surface: PLANE, reversed: true }] }] }),
    g = parse3DM(rhino, BYTES, { segmentsU: 1, segmentsV: 1 }),
    plain = parse3DM(runtime({ objects: [{ surface: PLANE }] }), BYTES, { segmentsU: 1, segmentsV: 1 });
  assert.equal(g.surfaces, 1);
  assert.equal(g.normals[2], -1);
  assert.deepEqual([...g.indices.slice(0, 3)], [plain.indices[0], plain.indices[2], plain.indices[1]]);
  assert.equal(rhino.state.live, 0);
});

test('a solid that may be trimmed stays skipped: nothing draws past a trim', () => {
  const rhino = runtime({ objects: [{ isSurface: false, faces: [{ surface: PLANE }, { surface: PLANE }] }] }),
    g = parse3DM(rhino, BYTES);
  assert.equal(g.skipped, 1);
  assert.equal(g.surfaces, 0);
  assert.equal(g.groups.length, 0);
  assert.equal(rhino.state.live, 0);
});

test('a surface and a mesh in one file keep their arrays aligned', () => {
  const g = parse3DM(runtime({ objects: [{ mesh: TRIANGLE }, { surface: PLANE }] }), BYTES);
  assert.equal(g.normals.length, g.positions.length);
  assert.equal(g.uvs.length, (g.positions.length / 3) * 2);
});

test('a surface past the vertex limit refuses', () => {
  assert.throws(
    () => parse3DM(runtime({ objects: [{ surface: PLANE }] }), BYTES, { maxVertices: 4 }),
    (error) => error instanceof LoaderError && error.code === 'limit',
  );
});
