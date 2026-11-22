// BiomeWorld (with no workers), BiomePlacement, BiomeSeasons and BiomeEditor hold no engine or GPU resource, only
// subscriptions on their world; BiomeView, and the BiomeObjects and FarForest it attaches, are the engine's. Every
// entry uses its own small world, made by the caller and ended at cleanup.
// One check:owners leaf per entry: the four entries in one leaf took past the leaf's 180 s limit on the WebGL2 layer of a
// busy RTX A6000 (2026-11-15; native passed in one leaf).
export const leafPerEntry = true;
const small = (BiomeWorld) => BiomeWorld.create({ size: [512, 512], workers: 0 });

export async function fixtures(load = (entry) => import(entry)) {
  const { BiomeWorld } = await load('../dist/index.js');
  const { BiomeView } = await load('../dist/view.js');
  const { BiomeSeasons } = await load('../dist/seasons.js');
  const { BiomeEditor } = await load('../dist/editor.js');
  const { BiomePlacement } = await load('../dist/placement.js');
  // Attach in the owner's scene: the fixture's own await for the world already returned the engine to its active scene.
  // BiomeView keeps the scene it is attached from across its own awaits.
  const view = (name, options) => ({
    name,
    async create({ engine, scene }) {
      const world = await small(BiomeWorld);
      let pending;
      const scope = {
        name: 'owner-lifetime:biome-view',
        setup() {
          pending = BiomeView.attach(engine, world, options);
        },
      };
      scene.use(scope);
      scene.removePlugin(scope.name);
      const made = await pending;
      return { plugin: made.terrain, dispose: () => made.dispose(), cleanup: () => world.dispose() };
    },
  });
  return [
    view('BiomeView', { objects: false, water: false, canopy: 0 }),
    view('BiomeView objects', { water: false, far: false }),
    view('BiomeView objects far', { water: false, far: { radius: 600 }, radius: 300 }),
    // The world tools subscribe to their world; a plugin of the caller's ends them with the entry.
    {
      name: 'BiomePlacement, BiomeSeasons and BiomeEditor',
      async create({ engine, scene }) {
        const world = await small(BiomeWorld);
        const placement = BiomePlacement.attach(world),
          seasons = BiomeSeasons.attach(world, { dayOfYear: 180 }),
          editor = BiomeEditor.attach(world);
        const plugin = {
          name: 'biome-tools',
          setup() {},
          dispose() {
            editor.dispose();
            seasons.dispose();
            placement.dispose();
            engine.sceneOf(this)?.removePlugin(this.name);
          },
        };
        scene.use(plugin);
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => world.dispose() };
      },
    },
  ];
}
