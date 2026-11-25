import { PbrMaterial, box } from '../../core/dist/index.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { Selection } = await load('../dist/index.js');
  return [false, true].map((factory) => ({
    name: 'Selection' + (factory ? '.attach' : ''),
    create({ engine, scene, dependency }) {
      const mesh = dependency(() =>
        scene
          .createMesh()
          .setGeometry(box(1, 1, 1))
          .setMaterial(new PbrMaterial()),
      );
      const options = { algorithm: 'jfa', width: 3, color: [1, 0.5, 0] };
      const plugin = factory ? Selection.attach(engine, options) : new Selection(options);
      if (!factory) engine.use(plugin);
      plugin.set([mesh]);
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
    },
  }));
}
