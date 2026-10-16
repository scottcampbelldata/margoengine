import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {FrameGraph} from '@margoengine/core/extension';
import {parseGLTF} from '@margoengine/gltf';
import {parseGLTF as parsePBR} from '@margoengine/gltf-pro';
import {Inspector} from '@margoengine/inspector';
import {BoxHelper, VertexNormalsHelper} from '@margoengine/lines';
import {loadedPBRFixtures, loadedPBREngine, serveLoadedPBRFixtures} from './support/loaded-pbr-fixtures.js';

// Both real assets must load before registering any consumer regression. A load failure
// aborts this file instead of substituting a hand-built mesh or missing geometry.
const assets = await serveLoadedPBRFixtures();
try {
  for (const fixture of loadedPBRFixtures) (await assets.load(fixture)).dispose();
  (await loadCoreControl()).dispose();
} catch (error) {
  await assets.close();
  throw error;
}
after(() => assets.close());

async function withLoaded(fixture, action) {
  const loaded = await assets.load(fixture);
  try {await action(loaded);}
  finally {loaded.dispose();}
}

// A basic-loader control uses the very same checked-in asset, rather than
// fabricating geometry, to verify that each debug consumer and GPU shim works.
async function loadCoreControl() {
  const engine = await loadedPBREngine();
  try {
    const bytes = await readFile(new URL('../packages/exporters/tests/fixtures/Box.glb', import.meta.url));
    const model = parseGLTF(engine, bytes);
    assert.equal(model.meshes.length, 1);
    const mesh = model.meshes[0];
    assert.ok(mesh.geometry?.vertices.length > 0, 'the basic loader returns actual core geometry');
    engine.store.tick(false);
    return {engine, mesh, dispose() {engine.dispose();}};
  } catch (cause) {
    engine.dispose();
    throw new Error('ASSET LOAD FAILED; STOP: basic glTF control Box.glb', {cause});
  }
}

function debugLayouts(engine) {
  globalThis.GPUShaderStage = {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4};
  engine.gpu.createBindGroupLayout = descriptor => descriptor;
  engine.gpu.createPipelineLayout = descriptor => descriptor;
}

// Only the GPU device/encoder is a Node shim. Meshes, geometry data, Inspector,
// helpers, Lines and FrameGraph are the actual public implementations.
function debugFrame(engine, inspector, segments = []) {
  const graph = new FrameGraph();
  inspector.registerPasses(graph);
  engine.camera.update(engine.canvas.width / engine.canvas.height, true);
  let drawCalls = 0;
  const pass = {setPipeline() {}, setBindGroup() {}, draw(_vertices, count) {drawCalls++; segments.push(count);}, end() {}};
  graph.execute({
    backend: 'webgpu', device: engine.gpu,
    encoder: {beginRenderPass() {return pass;}},
    color: {}, depth: {}, format: 'bgra8unorm',
    descriptor: {multisample: {count: 1}, depthStencil: {format: 'depth32float'}},
    width: engine.canvas.width, height: engine.canvas.height,
    camera: engine.camera, delta: 0, draw() {},
  });
  return drawCalls;
}

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2e-5 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
function edgeCount(primitives) {
  return primitives.reduce((total, p) => {
    const edges = new Set();
    for (let i = 0; i < p.indices.length; i += 3) for (let e = 0; e < 3; e++) {
      const a = p.indices[i + e], b = p.indices[i + (e + 1) % 3];
      edges.add(a < b ? `${a}/${b}` : `${b}/${a}`);
    }
    return total + edges.size;
  }, 0);
}
function lineBounds(helper) {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < helper.count; i++) for (let a = 0; a < 3; a++) {
    const value = helper.points[i * 4 + a];
    assert.ok(Number.isFinite(value), 'helper never uploads nonfinite coordinates');
    bounds[a] = Math.min(bounds[a], value); bounds[a + 3] = Math.max(bounds[a + 3], value);
  }
  return bounds;
}

for (const mode of ['wireframe', 'normals', 'bounds']) {
  test(`control: inspector ${mode} overlay draws basic-loader Box.glb`, async () => {
    const loaded = await loadCoreControl(), {engine} = loaded;
    debugLayouts(engine);
    const dom = new JSDOM('<body></body>');
    const inspector = Inspector.attach(engine, {parent: dom.window.document.body});
    try {
      inspector.setDebug(mode, true);
      assert.equal(debugFrame(engine, inspector), 1, 'the same debug-frame harness draws a real basic-loader part');
    } finally {inspector.dispose(); dom.window.close(); loaded.dispose();}
  });
}

test('control: BoxHelper updates basic-loader Box.glb', async () => {
  const loaded = await loadCoreControl(), helper = new BoxHelper(loaded.mesh);
  try {
    assert.equal(helper.update(loaded.engine), true);
    assert.equal(helper.segmentCount, 12);
  } finally {helper.dispose(); loaded.dispose();}
});

test('control: VertexNormalsHelper updates basic-loader Box.glb', async () => {
  const loaded = await loadCoreControl(), helper = new VertexNormalsHelper(loaded.mesh);
  try {
    assert.equal(helper.update(loaded.engine), true);
    assert.equal(helper.segmentCount, loaded.mesh.geometry.vertices.length / 6);
  } finally {helper.dispose(); loaded.dispose();}
});

for (const fixture of loadedPBRFixtures) {
  for (const mode of ['wireframe', 'normals', 'bounds']) {
    test(`${fixture.producer}: inspector ${mode} overlay retains the part from real ${fixture.asset}`, async () => {
      await withLoaded(fixture, ({engine, mesh}) => {
        // Extend the existing GPU-only loader shim with the two layout factories
        // used by Lines. Do not replace the consumer, loaded mesh or primitive.
        debugLayouts(engine);
        const dom = new JSDOM('<body></body>');
        const inspector = Inspector.attach(engine, {parent: dom.window.document.body});
        try {
          inspector.select(mesh);
          assert.equal(inspector.root.querySelectorAll(`[data-entity="${mesh.id}"]`).length, 1,
            'the actual loaded part is present in the inspector tree');
          inspector.setDebug(mode, true);
          assert.equal(debugFrame(engine, inspector), 1, `enabled ${mode} overlay draws the one loaded part`);
          assert.equal(mesh.geometry, null, 'debug overlays do not require a fabricated core Geometry');
        } finally {inspector.dispose(); dom.window.close();}
      });
    });
  }

  test(`${fixture.producer}: BoxHelper updates bounds for real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({engine, mesh}) => {
      const helper = new BoxHelper(mesh);
      try {
        assert.equal(helper.update(engine), true, 'the live loaded part produces a bounds helper this frame');
        assert.equal(helper.segmentCount, 12, 'a box has twelve non-omitted edges');
        assert.equal(mesh.geometry, null, 'the helper uses the loader-owned primitive');
      } finally {helper.dispose();}
    });
  });

  test(`${fixture.producer}: VertexNormalsHelper updates normals for real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({engine, mesh, primitive}) => {
      const helper = new VertexNormalsHelper(mesh);
      try {
        assert.equal(helper.update(engine), true, 'the live loaded part produces a normal helper this frame');
        assert.equal(helper.segmentCount, primitive.vertices.length / 20, 'one normal segment per loaded vertex');
        assert.equal(mesh.geometry, null, 'the helper uses the loader-owned primitive');
      } finally {helper.dispose();}
    });
  });

  test(`${fixture.producer}: helpers preserve transformed bind-pose attributes and release disposed sources`, async () => {
    await withLoaded(fixture, ({engine, model, mesh, primitive}) => {
      // Keep the real geometry while replacing its transform with an analytic one.
      // Mirrored nonuniform scale catches position-as-normal and plain model-matrix errors.
      mesh.setParent(model.root).setPosition([3, -2, 5]).setQuaternion([0, 0, 0, 1]).setScale([-2, 3, 0.5]);
      engine.store.tick(false);
      const box = new BoxHelper(mesh), normals = new VertexNormalsHelper(mesh, {size: 0.7});
      try {
        assert.equal(box.update(engine), true); assert.equal(normals.update(engine), true);
        const positions = primitive.vertices, expected = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        const scale = [-2, 3, 0.5], position = [3, -2, 5];
        for (let i = 0; i < positions.length; i += 20) for (let a = 0; a < 3; a++) {
          const value = positions[i + a] * scale[a] + position[a];
          expected[a] = Math.min(expected[a], value); expected[a + 3] = Math.max(expected[a + 3], value);
        }
        lineBounds(box).forEach((v, a) => close(v, expected[a], 'transformed box'));
        for (let i = 0; i < positions.length / 20; i++) {
          const expectedNormal = [0, 1, 2].map(a => positions[i * 20 + 4 + a] / scale[a]);
          const length = Math.hypot(...expectedNormal) || 1;
          for (let a = 0; a < 3; a++) {
            close(normals.points[i * 8 + a], positions[i * 20 + a] * scale[a] + position[a], 'normal origin');
            close(normals.points[i * 8 + 4 + a] - normals.points[i * 8 + a], expectedNormal[a] / length * 0.7, 'inverse transpose normal');
          }
        }
        const versions = [box.version, normals.version];
        for (let frame = 0; frame < 8; frame++) {assert.equal(box.update(engine), true); assert.equal(normals.update(engine), true);}
        assert.deepEqual([box.version, normals.version], versions, 'unchanged transforms reuse helper points');
        model.root.visible = false; engine.store.tick(false);
        assert.equal(box.update(engine), false); assert.equal(normals.update(engine), false);
        model.root.visible = true; engine.store.tick(false);
        assert.equal(box.update(engine), true); assert.equal(normals.update(engine), true);
        assert.equal(mesh.geometry, null);
        model.destroy();
        assert.equal(box.update(engine), false); assert.equal(normals.update(engine), false);
        const replacement = engine.createMesh();
        assert.notEqual(replacement, mesh);
        assert.equal(box.update(engine), false); assert.equal(normals.update(engine), false);
      } finally {box.dispose(); normals.dispose();}
    });
  });

  test(`${fixture.producer}: inspector overlays track inherited visibility and source disposal`, async () => {
    await withLoaded(fixture, ({engine, model, mesh}) => {
      debugLayouts(engine);
      const dom = new JSDOM('<body></body>'), inspector = Inspector.attach(engine, {parent: dom.window.document.body});
      try {
        for (const mode of ['wireframe', 'normals', 'bounds']) inspector.setDebug(mode, true);
        const counts = [];
        assert.equal(debugFrame(engine, inspector, counts), 3);
        assert.deepEqual(counts, [edgeCount(model.primitives), model.primitives.reduce((n, p) => n + p.vertices.length / 20, 0), 12]);
        model.root.visible = false; engine.store.tick(false);
        assert.equal(debugFrame(engine, inspector), 0, 'hidden hierarchy suppresses every overlay');
        model.root.visible = true; engine.store.tick(false);
        assert.equal(debugFrame(engine, inspector), 3);
        assert.equal(mesh.geometry, null);
        model.destroy();
        engine.createMesh(); engine.store.tick(false);
        assert.equal(debugFrame(engine, inspector), 0, 'deleted source and reused slots cannot leave stale lines');
        for (const mode of ['wireframe', 'normals', 'bounds']) inspector.setDebug(mode, false);
        assert.equal(debugFrame(engine, inspector), 0);
      } finally {inspector.dispose(); dom.window.close();}
    });
  });
}

test('real Box.glb primitives on one node all contribute to inspector overlays and helpers', async () => {
  await withLoaded(loadedPBRFixtures[0], ({engine, model, primitive}) => {
    // Retain the checked-in asset's actual topology/normals and add a second copy
    // translated in its POSITION accessor, so a first-primitive-only box is wrong.
    const doc = structuredClone(model.asset.doc), positions = new Float32Array(primitive.vertices.length / 20 * 3);
    for (let i = 0; i < positions.length / 3; i++) {
      positions[i * 3] = primitive.vertices[i * 20] + 4;
      positions[i * 3 + 1] = primitive.vertices[i * 20 + 1]; positions[i * 3 + 2] = primitive.vertices[i * 20 + 2];
    }
    const buffer = doc.buffers.length, view = doc.bufferViews.length, accessor = doc.accessors.length;
    doc.buffers.push({byteLength: positions.byteLength});
    doc.bufferViews.push({buffer, byteLength: positions.byteLength});
    doc.accessors.push({bufferView: view, componentType: 5126, count: positions.length / 3, type: 'VEC3'});
    const second = structuredClone(doc.meshes[0].primitives[0]); second.attributes.POSITION = accessor;
    doc.meshes[0].primitives.push(second);
    const combined = parsePBR(engine, doc, [...model.asset.buffers, positions]);
    model.destroy(); engine.store.tick(false);
    const mesh = combined.primitives[0].node, helper = new BoxHelper(mesh), normals = new VertexNormalsHelper(mesh);
    debugLayouts(engine);
    const dom = new JSDOM('<body></body>'), inspector = Inspector.attach(engine, {parent: dom.window.document.body});
    try {
      assert.equal(combined.primitives.length, 2); assert.equal(combined.primitives[1].node, mesh);
      assert.equal(helper.update(engine), true); assert.equal(normals.update(engine), true);
      assert.equal(normals.segmentCount, positions.length / 3 * 2);
      const box = lineBounds(helper);
      close(box[0], -0.5, 'both primitives min x'); close(box[3], 4.5, 'both primitives max x');
      for (const mode of ['wireframe', 'normals', 'bounds']) inspector.setDebug(mode, true);
      const counts = [];
      assert.equal(debugFrame(engine, inspector, counts), 3, 'one line draw per mode, not duplicate core draws');
      assert.deepEqual(counts, [edgeCount(combined.primitives), positions.length / 3 * 2, 12]);
      assert.equal(mesh.geometry, null);
    } finally {inspector.dispose(); dom.window.close(); helper.dispose(); normals.dispose(); combined.destroy();}
  });
});

test('inspector retains real PBR geometry crossing the frustum while its empty core sphere is culled', async () => {
  await withLoaded(loadedPBRFixtures[0], ({engine, model, mesh, primitive}) => {
    mesh.setPosition([3.279201435678004, 0, 0]);
    engine.camera.position = [0, 0, 4]; engine.camera.target = [0, 0, 0]; engine.camera.fov = 60;
    engine.camera.update(128 / 96, true); engine.store.planes.set(engine.camera.planes); engine.store.tick(true);
    let inside = 0;
    const camera = engine.camera.matrix, world = mesh.matrix;
    for (let i = 0; i < primitive.vertices.length; i += 20) {
      const p = [0, 1, 2].map(a => world[a] * primitive.vertices[i] + world[a + 4] * primitive.vertices[i + 1] + world[a + 8] * primitive.vertices[i + 2] + world[a + 12]);
      const clip = [0, 1, 2, 3].map(a => camera[a] * p[0] + camera[a + 4] * p[1] + camera[a + 8] * p[2] + camera[a + 12]);
      if (clip[3] > 0 && Math.abs(clip[0]) < clip[3] && Math.abs(clip[1]) < clip[3] && clip[2] > 0 && clip[2] < clip[3]) inside++;
    }
    assert.ok(inside > 0, 'actual loaded vertices remain inside the frustum');
    assert.equal(engine.store.visible[mesh.id], 0, 'zero core bounds cull only the PBR node origin');
    assert.equal(mesh.geometry, null);
    debugLayouts(engine);
    const dom = new JSDOM('<body></body>'), inspector = Inspector.attach(engine, {parent: dom.window.document.body});
    try {
      for (const mode of ['wireframe', 'normals', 'bounds']) inspector.setDebug(mode, true);
      assert.equal(debugFrame(engine, inspector), 3, 'every debug mode retains the visible fragment of the loaded part');
      model.root.visible = false; engine.store.tick(true);
      assert.equal(debugFrame(engine, inspector), 0, 'inherited hidden state still suppresses the edge overlays');
    } finally {inspector.dispose(); dom.window.close();}
  });
});
