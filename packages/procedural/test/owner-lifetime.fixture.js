import { Geometry, PbrMaterial } from '../../core/dist/index.js';
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

// procedural installs no engine plugin. What it hands a caller that has a lifetime: the Wasm generators (buildings,
// caves, dungeons, Poisson discs, SDF modelling), each holding an instance until it is disposed; the GPU PBR texture
// baker, whose baked maps the caller owns; and geometry a caller turns into meshes (a joined building plan). Each entry
// is the smallest caller a game writes: the handle is made in the owner's scope and released with it, so the harness
// sees every instance, texture, buffer and mesh go with its owner on both engines, through device loss and repeated
// attaches.
export async function fixtures(load = (entry) => import(entry)) {
  const { createBuildingGenerator } = await load('../dist/buildings.js');
  const { createCaveGenerator } = await load('../dist/caves.js');
  const { createDungeonGenerator } = await load('../dist/dungeon.js');
  const { createPoissonSampler } = await load('../dist/poisson.js');
  const { createSdfModeler } = await load('../dist/sdf.js');
  const { createPBRTextureBaker } = await load('../dist/textures-pbr.js');
  const { generateBuildingPlan } = await load('../dist/building-plans.js');
  const wasm = [
    ['BuildingGenerator', createBuildingGenerator],
    ['CaveGenerator', createCaveGenerator],
    ['DungeonGenerator', createDungeonGenerator],
    ['PoissonSampler', createPoissonSampler],
    ['SdfModeler', createSdfModeler],
  ].map(([name, make]) => ({
    name,
    visible: false,
    async create({ scene }) {
      const handle = await make();
      return ownedByEngine(scene, name, () => handle.dispose());
    },
  }));
  // A far-detail L house with a tower: every part as a mesh of its own, made in setup, made again on a restored device
  // (the old buffers went with the lost one) and disposed with the plugin.
  const plan = generateBuildingPlan({ style: 'western-1910-house', plan: 'L', tower: 'front-right', detail: 'far' });
  const building = {
    name: 'generateBuildingPlan meshes',
    visible: true,
    create() {
      let engine,
        meshes = [],
        disposed = false;
      const material = new PbrMaterial({ color: '#b8b0a2', roughness: 0.8 });
      const build = (e) => {
        for (const m of meshes) m.dispose();
        meshes = Object.values(plan.parts).map((g) =>
          e
            .createMesh()
            .setGeometry(new Geometry(g.positions, g.normals, g.indices))
            .setMaterial(material)
            .setPosition([0, -4, -30]),
        );
      };
      const plugin = {
        name: 'owner-procedural-building-plan',
        setup(e) {
          engine = e;
          build(e);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const m of meshes) m.dispose();
          meshes = [];
          engine?.sceneOf(plugin)?.removePlugin(plugin.name);
        },
      };
      return { plugin, dispose: () => plugin.dispose() };
    },
  };
  const baker = {
    name: 'PBRTextureBaker',
    visible: false,
    async create({ engine, scene }) {
      const b = await createPBRTextureBaker(engine);
      const set = await b.bake({ pattern: 'bricks', width: 16, height: 16 });
      return ownedByEngine(scene, 'PBRTextureBaker', () => {
        set.dispose();
        b.dispose();
      });
    },
  };
  return [...wasm, building, baker];
}
