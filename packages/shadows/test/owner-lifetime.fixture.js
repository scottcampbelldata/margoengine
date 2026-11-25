export async function fixtures(load = (entry) => import(entry)) {
  const { Shadows } = await load('../dist/index.js');
  const { VirtualShadows } = await load('../dist/virtual.js');
  const { IBLShadows } = await load('../dist/ibl.js');
  const { PostStack } = await load('../../post/dist/stack.js');
  const { MeshBVH } = await load('../../bvh/dist/index.js');
  return [
    {
      name: 'Shadows',
      create: () => {
        const plugin = new Shadows({ resolution: 64 });
        return { plugin, dispose: () => plugin.dispose() };
      },
    },
    {
      name: 'VirtualShadows',
      create: () => {
        const plugin = new VirtualShadows();
        return { plugin, dispose: () => plugin.dispose() };
      },
    },
    {
      // shadows/ibl joins a PostStack; the stack is the plugin the engine holds.
      name: 'IBLShadows',
      create({ engine }) {
        const bvh = MeshBVH.build({ positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]), indices: [0, 1, 2] }),
          effect = new IBLShadows(bvh, { width: 2, height: 1, data: new Float32Array([1, 1, 1, 4, 4, 4]) }),
          plugin = PostStack.attach(engine, [effect]);
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => effect.dispose() };
      },
    },
  ];
}
