// Owner/lifetime fixture for @margoengine/voxel-edit. The editing entries (edit, pick, sparse, mesh, vox, animation,
// history, export, formats, assist, library, smooth, voxelize, rig, collab, generate, select, formats-extra) work on
// typed arrays and plain objects: a VoxelReplica's change listeners and a voxelize pause timer live in the caller's call
// and end with it, and neither holds an engine. The two objects that hold GPU resources on the engine's device are in
// `@margoengine/voxel-edit/gpu` and `/shaders`:
// - GpuGrid: the cell, uniform, tool and staging buffers and the pass pipelines of a grid kept on the GPU, with queued
//   edits of every kind (fill, combine, dilate, erode, smooth, remap, brush, write) and a read-back.
// - ShaderBrush: a compiled brush pipeline, which stays registered for GpuGrid.brush until dispose().
// Neither is an engine plugin, so each is created in the owner's scope and tied to a plugin registration that releases
// it the way a scene or engine disposal does (ownedByEngine); release is safe to repeat.
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const grid = () => ({ size: [8, 8, 8], voxels: new Uint8Array(512).fill(1) });
const tool = { size: [2, 2, 2], voxels: new Uint8Array(8).fill(2) };
const code = 'fn brush(p: vec3<i32>, value: u32) -> u32 { return select(value, 3u, p.x == 0); }';

export async function fixtures(load = (entry) => import(entry)) {
  const { GpuGrid } = await load('../dist/gpu.js');
  const { ShaderBrush } = await load('../dist/shaders.js');
  return [
    {
      name: 'GpuGrid',
      async create({ engine, scene }) {
        const brush = await ShaderBrush.create(engine.gpu, code);
        const gpu = await GpuGrid.create(engine.gpu, grid());
        const map = new Uint8Array(256).map((_, i) => i);
        gpu
          .fill({ shape: 'box', min: [0, 0, 0], max: [4, 4, 4] }, 0)
          .fill({ shape: 'sphere', center: [4, 4, 4], radius: 2 }, 4);
        gpu.combine(tool, { operation: 'union', offset: [1, 1, 1], paletteMap: map }); // returns the clipped count
        gpu.dilate().erode().smooth().remap(map).brush(brush);
        gpu.write(grid());
        await gpu.read();
        return ownedByEngine(scene, 'GpuGrid', () => {
          gpu.dispose();
          brush.dispose();
        });
      },
    },
    {
      name: 'ShaderBrush',
      async create({ engine, scene }) {
        const brush = await ShaderBrush.create(engine.gpu, code);
        await brush.run(grid());
        return ownedByEngine(scene, 'ShaderBrush', () => brush.dispose());
      },
    },
  ];
}
