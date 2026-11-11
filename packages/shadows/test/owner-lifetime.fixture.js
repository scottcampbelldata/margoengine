export async function fixtures(load = (entry) => import(entry)) {
  const { Shadows } = await load('../dist/index.js');
  const { VirtualShadows } = await load('../dist/virtual.js');
  return [
    { name: 'Shadows', create: () => {
      const plugin = new Shadows({ resolution: 64 });
      return { plugin, dispose: () => plugin.dispose() };
    } },
    { name: 'VirtualShadows', create: () => {
      const plugin = new VirtualShadows();
      return { plugin, dispose: () => plugin.dispose() };
    } },
  ];
}
