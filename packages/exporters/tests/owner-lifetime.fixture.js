// Owner/lifetime fixture for @margoengine/exporters. No exporter registers anything with an engine or keeps anything
// after it settles: every entry is a call that reads what the app has in its scene (a core mesh, a materials mesh with
// a texture) and returns bytes. The registration under test is the app's own mesh (ownedByEngine or the materials
// model); what the fixture checks of the exporter is that a call leaves no listener on the app's signal, no GPU
// buffer or texture (exportModel reads textures back), no mesh, and that the exported scene is the one it was
// called on. The signal entries cover the shared paths: gifWait (encodeGIF), inWorker or inProcess (compressMeshopt,
// optimizeGLB) and fetch-free Wasm loading. capture() is synchronous and restores the canvas in a finally (its own
// tests cover that), encodeWEBM needs VideoEncoder and encodeTexture a 2D canvas, so neither runs in the CPU leaf;
// the format writers, hashing, archives and the scene collectors are pure functions of their input.
import { ownedByEngine } from '../../../tests/support/owner-shell.js';
import { captureScene } from '../../shared/scene-scope.js';

const signal = () => new AbortController().signal;
const quad = {
  positions: [-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  uvs: [0, 0, 1, 0, 0, 1, 1, 1],
  indices: [0, 2, 3, 0, 3, 1],
};
const frame = (index) => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(40 * (index + 1)) });

export async function fixtures(load = (entry) => import(entry)) {
  const { exportGLB } = await load('../dist/index.js');
  const { exportModel } = await load('../dist/model.js');
  const { encodeGIF } = await load('../dist/capture.js');
  const { compressMeshopt } = await load('../dist/meshopt.js');
  const { optimizeGLB } = await load('../dist/optimize.js');
  const { box } = await load('../../core/dist/index.js');
  const { Material, Texture, createMesh } = await load('../../materials/dist/index.js');
  const entries = [];
  // A core mesh the app owns, exported from the engine: the exporter must leave the scene and the signal as it found them.
  const coreScene = (name, run) =>
    entries.push({
      name,
      async create({ engine, scene }) {
        const scope = captureScene(engine),
          mesh = scene.createMesh().setGeometry(box(1, 1, 1));
        const meshes = scene.meshes.size;
        const bytes = await run(engine, scope);
        if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
          throw new Error(`OWNER_FIXTURE: ${name} wrote nothing`);
        if (scene.meshes.size !== meshes) throw new Error(`OWNER_LIFETIME: ${name} changed the scene's meshes`);
        return ownedByEngine(scene, name, () => mesh.dispose());
      },
    });
  coreScene('exportGLB', (engine, scope) => scope.run(() => exportGLB(engine)));
  coreScene(
    'compressMeshopt',
    async (engine, scope) =>
      (
        await compressMeshopt(
          scope.run(() => exportGLB(engine)),
          { signal: signal() },
        )
      ).glb,
  );
  coreScene(
    'optimizeGLB',
    async (engine, scope) =>
      (
        await optimizeGLB(
          scope.run(() => exportGLB(engine)),
          { signal: signal() },
        )
      ).glb,
  );
  // encodeGIF draws nothing: the frames are the app's pixels; only the signal subscription is under test.
  coreScene('encodeGIF', () => encodeGIF(3, async (index) => frame(index), { signal: signal(), fps: 10 }));

  // exportModel reads the live materials mesh, its material and its texture (no encoded bytes, so it is PNG-encoded).
  entries.push({
    name: 'exportModel',
    warmUp: "materials' 1x1 default textures, made once per device",
    async create({ engine }) {
      const scope = captureScene(engine),
        texture = new Texture({ data: new Uint8Array(16).fill(200), width: 2, height: 2 }),
        material = new Material({ map: texture }),
        mesh = scope.run(() => createMesh(engine, quad, material));
      mesh.onDispose(() => {
        material.dispose();
        texture.dispose();
      });
      const glb = await exportModel(mesh, { binary: true });
      if (!(glb instanceof Uint8Array) || !glb.byteLength) throw new Error('OWNER_FIXTURE: exportModel wrote nothing');
      const nodes = [mesh.root, ...mesh.nodes].filter(Boolean);
      return {
        plugin: mesh,
        dispose: () => mesh.destroy(),
        check({ phase }) {
          if (phase === 'disposed' && nodes.some((m) => m.engine.meshes.get(m.id) === m))
            throw new Error('OWNER_LIFETIME: a disposed exported mesh leaves meshes in the scene');
        },
      };
    },
  });
  return entries;
}
