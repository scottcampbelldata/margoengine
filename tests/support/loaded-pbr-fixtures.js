import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { loadGLTF, PBRModel } from '@margoengine/gltf-pro';
import { loadFBX } from '@margoengine/fbx';
import { optionalGPU } from './optional-gpu.js';

export const loadedPBRFixtures = [
  { producer: 'gltf-pro', asset: 'Box.glb', file: '../../packages/exporters/tests/fixtures/Box.glb', load: loadGLTF },
  {
    producer: 'fbx',
    asset: 'blender-rig.fbx',
    file: '../../packages/fbx/test/fixtures/blender-rig.fbx',
    load: loadFBX,
  },
];

/** Uses the real Engine, Mesh API and Wasm transform store. Only the GPU device is a Node test shim. */
export async function loadedPBREngine() {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxTextureArrayLayers = 256;
  const renderer = { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(64),
    renderer,
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  return engine;
}

/** Serves the checked-in bytes over HTTP, so both public loaders perform their real fetch/parse/upload path. */
export async function serveLoadedPBRFixtures() {
  const routes = new Map();
  for (const fixture of loadedPBRFixtures)
    routes.set('/' + fixture.asset, await readFile(new URL(fixture.file, import.meta.url)));
  const server = createServer((request, response) => {
    const bytes = routes.get(new URL(request.url, 'http://localhost').pathname);
    response.writeHead(bytes ? 200 : 404, { 'content-type': 'application/octet-stream' });
    response.end(bytes);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async load(fixture) {
      const engine = await loadedPBREngine();
      try {
        const model = await fixture.load(engine, `${base}/${fixture.asset}`);
        assert.ok(model instanceof PBRModel, `${fixture.asset} loads through PBRModel`);
        assert.equal(model.primitives.length, 1, `${fixture.asset} contains one primitive`);
        const primitive = model.primitives[0],
          mesh = primitive.node;
        assert.ok(
          primitive.vertices.length >= 3 * 20 && primitive.indices.length >= 3,
          'real loader returned nonempty triangles',
        );
        assert.equal(mesh.geometry, null, 'fixture uses the PBR draw path without a second core Geometry');
        engine.store.tick(false);
        return {
          engine,
          model,
          mesh,
          primitive,
          dispose() {
            engine.dispose();
          },
        };
      } catch (cause) {
        engine.dispose();
        throw new Error(`ASSET LOAD FAILED; STOP: ${fixture.producer} ${fixture.asset}`, { cause });
      }
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** Read positions directly from the loaded stride-20 primitive, independently of consumer adapters. */
export function primitivePositions(primitive) {
  const positions = new Float32Array((primitive.vertices.length / 20) * 3);
  for (let vertex = 0; vertex < positions.length / 3; vertex++)
    positions.set(primitive.vertices.subarray(vertex * 20, vertex * 20 + 3), vertex * 3);
  return positions;
}

export function positionBounds(positions, scale = [1, 1, 1]) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length; vertex += 3)
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[vertex + axis] * scale[axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  return { min, max };
}
