import { box } from '../../core/dist/index.js';

// addMesh's copy has a materials material, and materials makes its 1x1 default textures once per device on first use
// and keeps them for the device's life (a fixed set, not a growth): `warmUp` has the harness make them first.
export async function fixtures(load = (entry) => import(entry)) {
  const { OIT } = await load('../dist/index.js');
  const { addMesh } = await load('../dist/meshes.js');
  return [
    ...[false, true].map((factory) => ({ name: 'OIT' + (factory ? '.attach' : ''), create({ engine }) {
      const plugin = factory ? OIT.attach(engine) : new OIT();
      return { plugin, dispose: () => plugin.dispose() };
    } })),
    { name: 'OIT.addMesh', warmUp: "materials' 1x1 default textures, made once per device",
      create({ engine, scene, dependency }) {
        const mesh = dependency(() => scene.createMesh().setGeometry(box(1, 1, 1)));
        const plugin = OIT.attach(engine);
        const remove = addMesh(plugin, engine, mesh, { opacity: 0.5 });
        return { plugin, dispose: () => {
          remove();
          plugin.dispose();
        }, cleanup: () => mesh.dispose() };
      } },
  ];
}
