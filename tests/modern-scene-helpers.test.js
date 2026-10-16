import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGLTF as parseBasicGLTF } from '@margoengine/gltf';
import { parsePreparedPBR } from '@margoengine/gltf-pro';
import { getSceneBounds, fitScene, gatherSceneBuffers } from '@margoengine/gltf-pro/scene';
import { headlessEngine } from '../packages/exporters/tests/helpers.js';
import { loadedPBRFixtures, loadedPBREngine, serveLoadedPBRFixtures } from './support/loaded-pbr-fixtures.js';

const bytes = await readFile(new URL('../packages/exporters/tests/fixtures/Box.glb', import.meta.url));
const assets = await serveLoadedPBRFixtures();
try {
  for (const fixture of loadedPBRFixtures) (await assets.load(fixture)).dispose();
} catch (error) {
  await assets.close();
  throw error;
}
after(() => assets.close());

async function withLoaded(fixture, action) {
  const loaded = await assets.load(fixture);
  try {
    await action(loaded);
  } finally {
    loaded.dispose();
  }
}
function close(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < actual.length; index++)
    assert.ok(
      Math.abs(actual[index] - expected[index]) < 2e-5,
      `${label}[${index}]: ${actual[index]} vs ${expected[index]}`,
    );
}
function worldPoints(vertices, stride, matrix) {
  const points = [];
  for (let at = 0; at < vertices.length; at += stride) {
    const x = vertices[at],
      y = vertices[at + 1],
      z = vertices[at + 2];
    points.push(
      [0, 1, 2].map((axis) => matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12]),
    );
  }
  return points;
}
const pointBounds = (points) =>
  new Float32Array([
    ...[0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
    ...[0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))),
  ]);
const pbrPoints = (model) =>
  model.primitives.flatMap((primitive) => worldPoints(primitive.vertices, 20, primitive.node.matrix));
const corePoints = (model) => model.meshes.flatMap((mesh) => worldPoints(mesh.geometry.vertices, 6, mesh.matrix));
function* overlapRoots(model, control) {
  yield model.root;
  yield control.root;
  yield model.root;
  yield model.nodes[0];
  yield model.primitives[0].node;
}
function watchCamera(engine) {
  const calls = [],
    original = engine.camera.fitToBoundingBox;
  engine.camera.fitToBoundingBox = function (min, max, options) {
    calls.push({ min: [...min], max: [...max], options });
    return original.call(this, min, max, options);
  };
  return {
    calls,
    restore() {
      engine.camera.fitToBoundingBox = original;
    },
  };
}
function rejectGPUOperations(engine, buffers, action) {
  const replacements = [];
  const replace = (owner, name) => {
    if (typeof owner[name] !== 'function') return;
    const original = owner[name];
    replacements.push(() => {
      owner[name] = original;
    });
    owner[name] = () => {
      throw new Error(`Unexpected GPU operation: ${name}`);
    };
  };
  for (const name of ['createBuffer', 'createTexture', 'createSampler', 'createCommandEncoder', 'createBindGroup'])
    replace(engine.gpu, name);
  for (const name of ['writeBuffer', 'writeTexture', 'submit', 'copyExternalImageToTexture'])
    replace(engine.gpu.queue, name);
  for (const buffer of new Set(buffers)) replace(buffer, 'destroy');
  try {
    return action();
  } finally {
    for (const restore of replacements.reverse()) restore();
  }
}
function coreBufferFixture(engine) {
  const buffers = new Map(),
    original = engine.geometryBuffers;
  engine.geometryBuffers = (geometry) => buffers.get(geometry) ?? null;
  return {
    install(geometry) {
      const result = {
        vertex: engine.gpu.createBuffer({
          size: geometry.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
        index: engine.gpu.createBuffer({
          size: geometry.indices.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        }),
        instance: engine.gpu.createBuffer({
          size: engine.store.capacity * 96,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      };
      engine.gpu.queue.writeBuffer(result.vertex, 0, geometry.vertices);
      engine.gpu.queue.writeBuffer(result.index, 0, geometry.indices);
      buffers.set(geometry, result);
      return result;
    },
    dispose() {
      engine.geometryBuffers = original;
      for (const value of buffers.values()) for (const buffer of Object.values(value)) buffer.destroy();
    },
  };
}

for (const fixture of loadedPBRFixtures) {
  test(`${fixture.producer}: optional scene bounds fit mixed real loader hierarchies through overlapping generator roots`, async () => {
    await withLoaded(fixture, ({ engine, model }) => {
      const control = parseBasicGLTF(engine, bytes),
        camera = watchCamera(engine);
      try {
        model.root.setPosition([2, 3, -4]).setRotation([0.2, -0.3, 0.4]).setScale([2, 1.5, 0.75]);
        control.root.setPosition([-7, 1, 2]);
        engine.store.tick(false);
        const expected = pointBounds([...pbrPoints(model), ...corePoints(control)]);
        const bounds = getSceneBounds(engine, overlapRoots(model, control));
        assert.ok(bounds instanceof Float32Array);
        close(bounds, expected, 'mixed actual world vertices');
        const fitted = fitScene(engine, overlapRoots(model, control), { duration: 0, padding: 1.2 });
        close(fitted, expected, 'returned fit bounds');
        assert.equal(camera.calls.length, 1);
        close(camera.calls[0].min, expected.subarray(0, 3), 'camera minimum');
        close(camera.calls[0].max, expected.subarray(3), 'camera maximum');
        assert.equal(camera.calls[0].options.aspect, 128 / 96);
        assert.equal(camera.calls[0].options.duration, 0);
        assert.equal(camera.calls[0].options.padding, 1.2);
        close(
          engine.camera.target,
          [0, 1, 2].map((axis) => (expected[axis] + expected[axis + 3]) / 2),
          'actual camera target',
        );
        for (const node of [model.root, ...model.nodes]) assert.equal(node.geometry, null);
      } finally {
        camera.restore();
        control.dispose();
      }
    });
  });

  test(`${fixture.producer}: optional scene visibility respects hidden ancestors and ignores the core frustum flags`, async () => {
    await withLoaded(fixture, ({ engine, model, mesh }) => {
      const control = parseBasicGLTF(engine, bytes);
      try {
        control.root.setPosition([12, 0, 0]);
        engine.store.tick(false);
        const pbr = pointBounds(pbrPoints(model)),
          core = pointBounds(corePoints(control));
        const all = pointBounds([...pbrPoints(model), ...corePoints(control)]);
        model.root.visible = false;
        close(getSceneBounds(engine, [model.root, control.root]), core, 'default visible-only bounds');
        close(
          getSceneBounds(engine, [model.root, control.root], { visibleOnly: false }),
          all,
          'explicit hidden inclusion',
        );
        assert.throws(() => getSceneBounds(engine, [model.root]), /No geometry/);
        assert.deepEqual(gatherSceneBuffers(engine, [model.root]), []);
        assert.equal(gatherSceneBuffers(engine, [model.root], { visibleOnly: false }).length, 1);
        model.root.visible = true;
        const original = engine.store.tick;
        engine.store.tick = function (...args) {
          const result = original.apply(this, args);
          for (const node of engine.meshes.values()) this.visible[node.id] = 0;
          return result;
        };
        try {
          close(getSceneBounds(engine, [model.root]), pbr, 'frustum-culling flags do not filter semantic scene bounds');
          const records = gatherSceneBuffers(engine, [model.root]);
          assert.equal(records.length, 1);
          assert.equal(records[0].node, mesh);
        } finally {
          engine.store.tick = original;
        }
      } finally {
        control.dispose();
      }
    });
  });

  test(`${fixture.producer}: scene PBR records borrow current deformation and alpha metadata without GPU work`, async () => {
    await withLoaded(fixture, ({ engine, model, mesh, primitive }) => {
      const before = getSceneBounds(engine, [model.root]);
      primitive.material.base[3] = 0.6;
      primitive.material.settings[0] = 1;
      primitive.material.settings[1] = 0.4;
      primitive.material.settings[2] = 1;
      primitive.material.maps[0] = {
        index: 0,
        texCoord: 1,
        extensions: { KHR_texture_transform: { offset: [0.2, 0.3], rotation: 0.4, scale: [2, 3] } },
      };
      const original = model.pickingPrimitives[0],
        current = engine.gpu.createBuffer({
          size: primitive.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
      let prepared = 0;
      model.prepareDeformation = () => {
        prepared++;
      };
      primitive.deformed = current;
      try {
        const records = rejectGPUOperations(engine, [original.vertex, original.index, current], () => {
          const result = gatherSceneBuffers(engine, [model.root, mesh, model.root]);
          close(getSceneBounds(engine, [model.root]), before, 'bounds remain explicit bind-pose CPU positions');
          return result;
        });
        assert.equal(prepared, 0, 'gathering borrows current buffers without advancing or encoding deformation');
        assert.equal(records.length, 1);
        const record = records[0],
          expected = model.pickingPrimitives[0];
        assert.equal(record.kind, 'pbr');
        assert.equal(record.node, mesh);
        assert.equal(record.primitive, primitive);
        assert.equal(record.vertex, current);
        assert.equal(record.index, original.index);
        assert.equal(record.count, primitive.indices.length);
        assert.equal(record.stride, 80);
        assert.equal(record.indexFormat, 'uint32');
        assert.equal(record.matrix, mesh.matrix);
        for (const key of ['alphaTexture', 'alphaSampler', 'alpha', 'cutoff', 'doubleSided', 'texCoord'])
          assert.equal(record[key], expected[key], key);
        close(record.alphaTransform, expected.alphaTransform, 'alpha coordinate transform');
        const matrix = [...record.matrix];
        model.root.setPosition([3, 4, 5]);
        engine.store.tick(false);
        assert.notDeepEqual([...record.matrix], matrix, 'borrowed world matrix remains live');
        assert.equal(current.destroyed, false);
        assert.equal(original.index.destroyed, false);
      } finally {
        primitive.deformed = undefined;
        current.destroy();
      }
    });
  });

  test(`${fixture.producer}: optional buffer gathering preserves core instances and per-node identity beside genuine PBR`, async () => {
    await withLoaded(fixture, ({ engine, model, mesh }) => {
      const control = parseBasicGLTF(engine, bytes),
        fixtureBuffers = coreBufferFixture(engine);
      const core = control.meshes[0],
        shared = fixtureBuffers.install(core.geometry);
      const second = engine.createMesh().setGeometry(core.geometry).setPosition([30, 0, 0]);
      try {
        const pbr = model.pickingPrimitives[0];
        const records = rejectGPUOperations(engine, [...Object.values(shared), pbr.vertex, pbr.index], () =>
          gatherSceneBuffers(engine, [model.root, control.root, second, core]),
        );
        assert.equal(records.length, 3);
        const coreRecords = records.filter((record) => record.kind === 'core');
        assert.equal(coreRecords.length, 2);
        assert.deepEqual(new Set(coreRecords.map((record) => record.node)), new Set([core, second]));
        for (const record of coreRecords) {
          assert.equal(record.geometry, core.geometry);
          assert.equal(record.vertex, shared.vertex);
          assert.equal(record.index, shared.index);
          assert.equal(record.instance, shared.instance, 'instance data is the borrowed last-render batch buffer');
          assert.equal(record.matrix, record.node.matrix);
          assert.equal(record.stride, 24);
          assert.equal(record.indexFormat, 'uint32');
          assert.equal(record.count, core.geometry.indices.length);
        }
        const pbrRecord = records.find((record) => record.kind === 'pbr');
        assert.equal(pbrRecord.node, mesh);
        assert.equal(pbrRecord.vertex, pbr.vertex);
        assert.equal(pbrRecord.index, pbr.index);
        assert.equal(gatherSceneBuffers(engine, [control.root]).length, 1, 'core-only scene is supported');
        close(getSceneBounds(engine, [control.root]), pointBounds(corePoints(control)), 'core-only bounds');
        assert.equal(gatherSceneBuffers(engine, [model.root]).length, 1, 'PBR-only scene is supported');
      } finally {
        second.dispose();
        fixtureBuffers.dispose();
        control.dispose();
      }
    });
  });

  test(`${fixture.producer}: scene snapshots refresh borrowed GPU records after restoration and exclude disposed child nodes`, async () => {
    await withLoaded(fixture, ({ engine, model, mesh }) => {
      const first = gatherSceneBuffers(engine, [model.root])[0];
      model.onDeviceRestored(engine);
      const next = gatherSceneBuffers(engine, [model.root])[0];
      assert.notEqual(next, first);
      assert.notEqual(next.vertex, first.vertex);
      assert.notEqual(next.index, first.index);
      assert.equal(first.vertex.destroyed, true);
      assert.equal(first.index.destroyed, true);
      assert.equal(next.vertex, model.pickingPrimitives[0].vertex);
      assert.equal(next.matrix, mesh.matrix);
      mesh.dispose();
      assert.deepEqual(
        gatherSceneBuffers(engine, [model.root]),
        [],
        'live grouping root does not retain a disposed primitive record',
      );
      assert.throws(() => getSceneBounds(engine, [model.root]), /No geometry/);
    });
  });
}

test('scene records preserve distinct real Box primitives even when their loader GPU buffers are shared', async () => {
  await withLoaded(loadedPBRFixtures[0], ({ engine, model }) => {
    const doc = structuredClone(model.asset.doc);
    delete doc.buffers;
    delete doc.bufferViews;
    delete doc.accessors;
    doc.meshes[0].primitives = [
      { attributes: {}, material: 0 },
      { attributes: {}, material: 0 },
    ];
    // The public prepared path reuses the real file's decoded arrays exactly;
    // both primitive records deliberately reference one shared GPU allocation.
    const { vertices, indices } = model.primitives[0],
      data = { vertices, indices };
    const doubled = parsePreparedPBR(engine, doc, [[data, data]]);
    try {
      const draws = doubled.pickingPrimitives;
      assert.equal(draws.length, 2);
      assert.equal(draws[0].vertex, draws[1].vertex);
      assert.equal(draws[0].index, draws[1].index);
      const records = gatherSceneBuffers(engine, [doubled.root, doubled.nodes[1], doubled.root]);
      assert.equal(records.length, 2);
      assert.notEqual(records[0].primitive, records[1].primitive);
      assert.deepEqual(new Set(records.map((record) => record.primitive)), new Set(doubled.primitives));
      assert.equal(records[0].node, records[1].node);
    } finally {
      doubled.dispose();
    }
  });
});

test('iterator-time disposal and slot reuse are validated before scene helpers can accept a replacement mesh', async () => {
  const engine = await loadedPBREngine(),
    camera = watchCamera(engine);
  try {
    for (const helper of [getSceneBounds, fitScene, gatherSceneBuffers]) {
      const control = parseBasicGLTF(engine, bytes),
        original = control.meshes[0],
        geometry = original.geometry;
      const second = engine.createMesh();
      let replacement;
      function* changingRoots() {
        yield original;
        const id = original.id;
        original.dispose();
        replacement = engine.createMesh().setGeometry(geometry);
        assert.equal(replacement.id, id, 'the disposed handle slot is actually reused');
        yield second;
      }
      try {
        assert.throws(() => helper(engine, changingRoots()), { message: 'Mesh disposed' });
      } finally {
        replacement?.dispose();
        second.dispose();
        control.dispose();
      }
    }
    assert.equal(camera.calls.length, 0, 'a stale root cannot trigger a partial fit');
  } finally {
    camera.restore();
    engine.dispose();
  }
});

test('optional scene helpers reject empty, disposed and foreign inputs before camera fitting or buffer gathering', async () => {
  const engine = await loadedPBREngine(),
    foreign = await loadedPBREngine(),
    camera = watchCamera(engine);
  try {
    const empty = engine.createMesh(),
      disposed = engine.createMesh(),
      foreignNode = foreign.createMesh();
    disposed.dispose();
    assert.throws(() => getSceneBounds(engine, [empty]), /No geometry/);
    assert.throws(() => fitScene(engine, [empty], { duration: 0 }), /No geometry/);
    assert.deepEqual(gatherSceneBuffers(engine, [empty]), []);
    const control = parseBasicGLTF(engine, bytes);
    try {
      for (const helper of [getSceneBounds, fitScene, gatherSceneBuffers]) {
        assert.throws(() => helper(engine, [control.root, disposed]), /Mesh disposed/);
        assert.throws(() => helper(engine, [control.root, foreignNode]), /Foreign|another engine/i);
      }
      assert.equal(camera.calls.length, 0, 'invalid trailing input never produces a partial camera fit');
    } finally {
      control.dispose();
    }
    engine.dispose();
    for (const helper of [getSceneBounds, fitScene, gatherSceneBuffers])
      assert.throws(() => helper(engine, []), /Engine disposed/);
  } finally {
    camera.restore();
    engine.dispose();
    foreign.dispose();
  }
});

test('optional fitScene accepts explicit fit options and falls back from CSS dimensions to drawing-buffer aspect', async () => {
  const engine = await loadedPBREngine(),
    model = parseBasicGLTF(engine, bytes),
    camera = watchCamera(engine);
  try {
    Object.assign(engine.canvas, { clientWidth: 0, clientHeight: 0, width: 600, height: 200 });
    fitScene(engine, [model.root], { duration: 0 });
    assert.equal(camera.calls[0].options.aspect, 3);
    fitScene(engine, [model.root], { aspect: 2, duration: 0, padding: 1.5 });
    assert.equal(camera.calls[1].options.aspect, 2);
    assert.equal(camera.calls[1].options.padding, 1.5);
  } finally {
    camera.restore();
    engine.dispose();
  }
});

test('WebGL2 keeps CPU scene bounds and camera fitting while GPU buffer gathering explicitly returns null', async () => {
  const engine = await headlessEngine();
  try {
    const model = parseBasicGLTF(engine, bytes);
    engine.store.tick(false);
    const expected = pointBounds(corePoints(model));
    close(getSceneBounds(engine, [model.root]), expected, 'WebGL2 core bounds');
    close(fitScene(engine, [model.root], { duration: 0 }), expected, 'WebGL2 fit bounds');
    assert.equal(gatherSceneBuffers(engine, [model.root]), null);
  } finally {
    engine.dispose();
  }
});
