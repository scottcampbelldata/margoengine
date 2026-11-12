import { PbrMaterial, box } from '../../core/dist/index.js';

const radiance = new Float32Array(27);
radiance.set([1, 1, 1], 0);
radiance.set([0.5, 0.5, 0.5], 3);

export async function fixtures(load = (entry) => import(entry)) {
  const { ContactShadows } = await load('../dist/index.js');
  const { GroundShadows } = await load('../dist/ground.js');
  const make = {
    ContactShadows: () => new ContactShadows({ size: 6, height: 1.5, blur: 0.15, opacity: 0.8, resolution: 128 }),
    'ContactShadows.attach': (engine) => ContactShadows.attach(engine, { size: 6, resolution: 128 }),
    GroundShadows: () => new GroundShadows({ size: 6, resolution: 128,
      environment: { sh: { radiance }, rotation: 0, intensity: 1 } }),
  };
  return Object.entries(make).map(([name, build]) => ({ name, create({ engine, scene, dependency }) {
    const mesh = dependency(() => scene.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial()));
    const plugin = build(engine);
    if (!engine.sceneOf(plugin)) engine.use(plugin);
    plugin.add(mesh);
    return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
  } }));
}
