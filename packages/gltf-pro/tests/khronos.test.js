// HANDOFF 5w: Khronos glTF-Sample-Assets that used to fail or render incompletely (examples/assets/khronos, Git LFS),
// checked headless on the CPU side: primitive modes, KHR_meshopt_compression, KHR_lights_punctual and glTF cameras.
// The GPU side (what they look like) is the visual-regression view `khronos-<Model>-model`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyGLTFLights, loadGLTF, viewGLTFCamera } from '../dist/index.js';
import { modelFromPrepared } from '../dist/worker.js';
import { MeshoptDecoder } from '../../decoders/dist/index.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { runParseWorker, assertSameBytes } from '../../../tests/support/parse-worker.js';

const root = new URL('../../../examples/assets/khronos/', import.meta.url),
  worker = new URL('../dist/workers/gltf.js', import.meta.url);
// Files come from disk through the loader's `fetch` option, under a made-up origin.
const fetch = async (url) => new Response(await readFile(new URL(new URL(url).pathname.slice(1), root)));
const load = async (engine, file, options = {}) =>
  loadGLTF(engine, `https://khronos.test/${file}`, { fetch, ...options });

test('MeshPrimitiveModes: points and lines draw as lists beside the triangles; strips and fans become triangle lists', () =>
  headlessModels(async () => {
    const model = await load(await headless(), 'MeshPrimitiveModes/MeshPrimitiveModes.gltf'),
      doc = model.asset.doc;
    const indices = (i) => Array.from(model.asset.accessor(doc.meshes[i].primitives[0].indices));
    // Meshes 0-6 are POINTS, LINES, LINE_LOOP, LINE_STRIP, TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN (glTF 2.0 3.7.2.1).
    assert.deepEqual(
      model.pointsAndLines.map((p) => [p.nodeIndex, p.topology]),
      [
        [0, 'point-list'],
        [1, 'line-list'],
        [2, 'line-list'],
        [3, 'line-list'],
      ],
    );
    assert.deepEqual(
      model.primitives.map((p) => [p.nodeIndex, p.topology]),
      [
        [4, undefined],
        [5, undefined],
        [6, undefined],
      ],
    );
    const [points, lines, loop, strip] = model.pointsAndLines,
      v = indices(2),
      s = indices(3);
    assert.deepEqual(Array.from(points.indices), indices(0));
    assert.deepEqual(Array.from(lines.indices), indices(1));
    assert.deepEqual(
      Array.from(loop.indices),
      v.flatMap((a, i) => [a, v[(i + 1) % v.length]]),
    );
    assert.deepEqual(
      Array.from(strip.indices),
      s.slice(0, -1).flatMap((a, i) => [a, s[i + 1]]),
    );
    const t = indices(5),
      f = indices(6);
    assert.deepEqual(
      Array.from(model.primitives[1].indices),
      t.slice(0, -2).flatMap((_, i) => [t[i], t[i + 1 + (i % 2)], t[i + 2 - (i % 2)]]),
    );
    assert.deepEqual(
      Array.from(model.primitives[2].indices),
      f.slice(0, -2).flatMap((_, i) => [f[i + 1], f[i + 2], f[0]]),
    );
    // No NORMAL attribute: points and lines are unlit (the material copy's ext.x), triangles keep the shared lit material.
    assert.ok(
      model.pointsAndLines.every((p) => p.material.ext[0] === 1) &&
        model.primitives.every((p) => p.material.ext[0] === 0),
    );
    assert.ok(Number.isFinite(model.bounds[0]));
    // The parse worker packs the same lists, topology included.
    const bin = await readFile(new URL('MeshPrimitiveModes/buffer.bin', root)),
      json = await readFile(new URL('MeshPrimitiveModes/MeshPrimitiveModes.gltf', root), 'utf8');
    const prepared = await runParseWorker(worker, {
      url: 'https://khronos.test/',
      input: json,
      buffers: [bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)],
    });
    const viaWorker = modelFromPrepared(await headless(), prepared);
    assertSameBytes(
      [...viaWorker.primitives, ...viaWorker.pointsAndLines].map((p) => [p.vertices, p.indices, p.topology ?? '']),
      [...model.primitives, ...model.pointsAndLines].map((p) => [p.vertices, p.indices, p.topology ?? '']),
    );
  }));

test('MeshoptCubeTest: KHR_meshopt_compression (vertex codec v1, COLOR filter) decodes to its uncompressed fallback buffer', () =>
  headlessModels(async () => {
    const compressed = await load(await headless(), 'MeshoptCubeTest/MeshoptCubeTest.gltf', {
      decoders: { meshopt: MeshoptDecoder },
    });
    const fallback = await load(await headless(), 'MeshoptCubeTest/MeshoptCubeTest.gltf');
    assert.equal(compressed.primitives.length, 35);
    const views = compressed.asset.doc.bufferViews,
      ext = (v) => v.extensions?.KHR_meshopt_compression;
    assert.ok(
      views.some((v) => ext(v)?.filter === 'COLOR') && views.some((v) => ext(v)?.mode === 'ATTRIBUTES'),
      'the sample uses COLOR',
    );
    // The TRIANGLES codec may rotate a triangle's corners (same triangle, same winding): compare with the lowest index first.
    const rotated = (indices) =>
      Uint32Array.from(indices, (_, i) => {
        const t = i - (i % 3),
          k = [0, 1, 2].reduce((a, b) => (indices[t + b] < indices[t + a] ? b : a));
        return indices[t + (((i % 3) + k) % 3)];
      });
    for (let i = 0; i < views.length; i++)
      if (ext(views[i])) {
        const stride = ext(views[i]).byteStride,
          wide = (view) =>
            stride === 2
              ? new Uint16Array(view.buffer, view.byteOffset, view.length / 2)
              : new Uint32Array(view.buffer, view.byteOffset, view.length / 4);
        if (ext(views[i]).mode === 'TRIANGLES')
          assertSameBytes(
            rotated(wide(compressed.asset.view(i))),
            rotated(wide(fallback.asset.view(i))),
            `bufferView ${i}`,
          );
        else assertSameBytes(compressed.asset.view(i), fallback.asset.view(i), `bufferView ${i}`);
      }
    assertSameBytes(
      compressed.primitives.map((p) => [p.vertices, rotated(p.indices)]),
      fallback.primitives.map((p) => [p.vertices, rotated(p.indices)]),
    );
  }));

test('applyGLTFLights: the directional light drives engine.lighting, point and spot lights go to clustered', () =>
  headlessModels(async () => {
    const engine = await headless(),
      model = await load(engine, 'DirectionalLight/DirectionalLight.glb'),
      sun = model.lights.find((l) => l.type === 'directional');
    assert.equal(typeof applyGLTFLights(model, { exposure: 2 }), 'function');
    const m = sun.node.matrix,
      length = Math.hypot(m[8], m[9], m[10]);
    assert.deepEqual(
      Array.from(engine.lighting.direction),
      [m[8] / length, m[9] / length, m[10] / length, 2].map(Math.fround),
    );
    assert.deepEqual(
      Array.from(engine.lighting.radiance),
      [0.9, 0.8, 0.1, 0.15].map(Math.fround),
      'colour set, ambient kept',
    );
    const lamp = await load(engine, 'PointLightIntensityTest/PointLightIntensityTest.glb'),
      calls = [];
    const clustered = {
      setLights: (lights) => calls.push(['setLights', lights]),
      add: (m) => {
        calls.push(['add', m]);
        return () => calls.push(['remove']);
      },
    };
    const direction = Array.from(engine.lighting.direction),
      remove = applyGLTFLights(lamp, { clustered, exposure: 3 });
    assert.deepEqual(
      Array.from(engine.lighting.direction),
      direction,
      'no directional light: the engine light is left alone',
    );
    assert.deepEqual(
      calls[0][1].map((l) => l.intensity),
      lamp.clusteredLights().map((l) => l.intensity * 3),
    );
    assert.equal(calls[1][1], lamp);
    remove();
    assert.deepEqual(calls[2], ['remove']);
    assert.throws(() => applyGLTFLights(model, { exposure: -1 }), /exposure must be a finite number >= 0/);
  }));

test('viewGLTFCamera: perspective and orthographic glTF cameras drive the engine camera', () =>
  headlessModels(async () => {
    const engine = await headless(),
      model = await load(engine, 'Cameras/Cameras.gltf'),
      camera = engine.camera;
    viewGLTFCamera(model);
    assert.deepEqual(
      [camera.position, camera.target, camera.up],
      [
        [0.5, 0.5, 3],
        [0.5, 0.5, 2],
        [0, 1, 0],
      ],
    );
    assert.deepEqual(
      [camera.fov, camera.near, camera.far, camera.project],
      [(0.7 * 180) / Math.PI, 0.01, 100, undefined],
    );
    viewGLTFCamera(model, 1);
    assert.equal(typeof camera.project, 'function');
    camera.update(2, true);
    // ymag 1 at aspect 2: x in [-2, 2], y in [-1, 1]; reversed depth, near -> 1 and far -> 0.
    const clip = (x, y, z) =>
      [0, 1, 2].map(
        (r) => camera.matrix[r] * x + camera.matrix[4 + r] * y + camera.matrix[8 + r] * z + camera.matrix[12 + r],
      );
    for (const [point, expected] of [
      [
        [2.5, 1.5, 3 - 0.01],
        [1, 1, 1],
      ],
      [
        [-1.5, -0.5, 3 - 100],
        [-1, -1, 0],
      ],
    ])
      clip(...point).forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-5, `${point} -> ${clip(...point)}`));
    viewGLTFCamera(model, model.cameras[0]);
    assert.equal(camera.project, undefined, 'a perspective camera removes the orthographic projection');
    assert.throws(() => viewGLTFCamera(model, 2), /no glTF camera 2/);
  }));

test('NodePerformanceTest: 10,002 nodes load at the default engine capacity (the store grows on demand)', () =>
  headlessModels(async () => {
    const { Engine, TransformStore } = await import('../../core/dist/extension.js');
    const engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(),
      { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    );
    const model = await load(engine, 'NodePerformanceTest/NodePerformanceTest.glb');
    assert.equal(model.nodes.length, 10_002);
    assert.ok(engine.store.capacity >= 10_003, `store grew to ${engine.store.capacity}`);
  }));
