// Owner/lifetime fixture for @margoengine/bvh. The CPU trees (MeshBVH, Raycaster, the worker builds) hold no engine
// resource. What holds one is each GPU tree, whose storage buffers, bind group and trace buffers live on the engine's
// device until dispose(), and SceneBVH, which reads an engine and refuses it once released:
// - GPUMeshBVH: uploaded tree, then a raycast (input, output and readback buffers come and go with the call).
// - GPUMeshBVH.forShader: uploaded with no compute pipeline.
// - GPUDynamicBVH (build and refit): working buffers and passes over a vertex buffer the caller owns.
// - SceneBVH: an update over a mesh of the scene.
// The trees are not engine plugins, so each is created in the owner's scope and tied to a plugin registration that
// releases it the way a scene or engine disposal does (ownedByEngine); release is safe to repeat.
import { box } from '../../core/dist/index.js';
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, -1, -1, -1, 1, -1, -1, 0, 1, -1]);
const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
const ray = [{ origin: [0, 0, 5], direction: [0, 0, -1] }];

export async function fixtures(load = (entry) => import(entry)) {
  const { MeshBVH } = await load('../dist/index.js');
  const { GPUMeshBVH } = await load('../dist/gpu.js');
  const { GPUDynamicBVH } = await load('../dist/gpu-build.js');
  const { SceneBVH } = await load('../dist/scene.js');
  const build = () => MeshBVH.build({ positions, indices });
  return [
    {
      name: 'GPUMeshBVH',
      async create({ engine, scene }) {
        const gpu = await GPUMeshBVH.create(engine, build());
        await gpu.raycast(ray);
        return ownedByEngine(scene, 'GPUMeshBVH', () => gpu.dispose());
      },
    },
    {
      name: 'GPUMeshBVH.forShader',
      create({ engine, scene }) {
        const gpu = GPUMeshBVH.forShader(engine, build());
        return ownedByEngine(scene, 'GPUMeshBVH.forShader', () => gpu.dispose());
      },
    },
    ...['build', 'refit'].map((mode) => ({
      name: `GPUDynamicBVH.${mode}`,
      async create({ engine, scene }) {
        // A vertex buffer the caller owns; the tree only follows it, and it goes with the owner.
        const buffer = engine.gpu.createBuffer({
          label: 'owner-bvh vertices',
          size: positions.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        engine.gpu.queue.writeBuffer(buffer, 0, positions);
        const dynamic = await GPUDynamicBVH.create(engine, {
          vertices: buffer,
          indices,
          mode,
          bvh: mode === 'refit' ? build() : undefined,
        });
        const encoder = engine.gpu.createCommandEncoder();
        dynamic.encode(encoder);
        engine.gpu.queue.submit([encoder.finish()]);
        return ownedByEngine(scene, `GPUDynamicBVH.${mode}`, () => {
          dynamic.dispose();
          buffer.destroy();
        });
      },
    })),
    {
      name: 'SceneBVH',
      create({ engine, scene }) {
        const mesh = engine.createMesh().setGeometry(box(1, 1, 1));
        const objects = new SceneBVH(engine);
        objects.update();
        return ownedByEngine(scene, 'SceneBVH', () => {
          objects.dispose();
          mesh.dispose?.();
        });
      },
    },
  ];
}
