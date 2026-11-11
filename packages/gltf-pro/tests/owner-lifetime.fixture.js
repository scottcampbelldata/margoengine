import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { PBRModel, GLTFAsset } = await load('../dist/index.js');
  return [{ name: 'PBRModel', visible: true, create({ engine }) {
    const { doc, buffers } = animatedTriangle();
    const plugin = new PBRModel(engine, new GLTFAsset(doc, buffers));
    return { plugin, dispose: () => plugin.dispose() };
  } }];
}
