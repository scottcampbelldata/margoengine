import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { skinnedStrip } from '../../animation/test/fixture.js';

// The model and its Animation are the caller's: the Animator is the registration under test.
export async function fixtures(load = (entry) => import(entry)) {
  const { Animator } = await load('../dist/index.js');
  return [{ name: 'Animator.attach', create({ engine, dependency }) {
    const data = skinnedStrip({ columns: 9 });
    const model = dependency(() => new PBRModel(engine, new GLTFAsset(data.doc, data.buffers)));
    const animation = dependency(() => Animation.attach(model));
    const plugin = Animator.attach(animation, { initial: 'bending', states: { bending: 'bend' }, parameters: {} });
    return { plugin, dependencies: [animation], dispose: () => plugin.dispose(),
      cleanup() { animation.dispose(); model.dispose(); } };
  } }];
}
