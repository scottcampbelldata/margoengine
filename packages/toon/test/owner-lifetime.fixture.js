import { PbrMaterial, box } from '../../core/dist/index.js';
import { GLTFAsset, PBRModel } from '../../gltf/dist/pbr.js';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';

const model = (engine) => {
  const { doc, buffers } = animatedTriangle();
  return new PBRModel(engine, new GLTFAsset(doc, buffers));
};

export async function fixtures(load = (entry) => import(entry)) {
  const { Toon } = await load('../dist/index.js');
  const { ModelOutlines } = await load('../dist/models.js');
  const screen = await load('../dist/screen-outline.js');
  const { Hatching } = await load('../dist/hatch.js');
  const { ModelHatching } = await load('../dist/hatch-models.js');
  const { MeshOutline } = await load('../dist/outline.js');
  const entries = [];
  // Scene-wide effects shade and outline a box mesh the caller owns.
  const effect = (name, make) => entries.push({ name, create({ engine, scene, dependency }) {
    const mesh = dependency(() => scene.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial()));
    const plugin = make(engine);
    return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
  } });
  // Model outlines draw around a glTF model the caller attached.
  const outlines = (name, make) => entries.push({ name, create({ engine, scene, dependency }) {
    const source = model(engine);
    dependency(() => scene.use(source));
    const plugin = make(engine, [source]);
    return { plugin, dependencies: [source], dispose: () => plugin.dispose(), cleanup: () => source.dispose() };
  } });
  for (const [suffix, Kind, Outlines] of [['', Toon, ModelOutlines], [' (screen)', screen.Toon, screen.ModelOutlines]]) {
    effect('Toon' + suffix, () => new Kind());
    effect('Toon.attach' + suffix, (engine) => Kind.attach(engine, { bands: 3 }));
    outlines('ModelOutlines' + suffix, (engine, models) => new Outlines({ models }));
    outlines('ModelOutlines.attach' + suffix, (engine, models) => Outlines.attach(engine, { models, smooth: false }));
  }
  effect('Hatching', () => new Hatching());
  effect('Hatching.attach', (engine) => Hatching.attach(engine));
  // ModelHatching registers no plugin of its own: it rides on its model, so the model is part of this entry.
  for (const factory of [false, true]) entries.push({ name: 'ModelHatching' + (factory ? '.attach' : ''),
    create({ engine }) {
      const plugin = model(engine);
      const hatching = factory ? ModelHatching.attach(plugin) : new ModelHatching(plugin);
      return { plugin, dispose: () => { hatching.dispose(); plugin.dispose(); } };
    } });
  // One mesh's hull outline: the caller owns the box it outlines.
  for (const factory of [false, true]) entries.push({ name: 'MeshOutline' + (factory ? '.attach' : ''),
    create({ engine, scene, dependency }) {
      const mesh = dependency(() => scene.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial()));
      const plugin = factory ? MeshOutline.attach(engine, { mesh }) : new MeshOutline({ mesh, screenspace: true, thickness: 3 });
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
    } });
  return entries;
}
