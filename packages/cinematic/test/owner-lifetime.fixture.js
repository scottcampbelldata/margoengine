export async function fixtures(load = (entry) => import(entry)) {
  const { Cinematic } = await load('../dist/index.js');
  const { CameraBrain } = await load('../dist/brain.js');
  return Object.entries({ Cinematic, CameraBrain }).map(([name, Plugin]) => ({
    name,
    create() {
      const plugin = new Plugin();
      return { plugin, dispose: () => plugin.dispose() };
    },
  }));
}
