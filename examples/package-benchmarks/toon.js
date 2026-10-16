import { Toon } from '../../packages/toon/dist/index.js';
import { fetchBytes, parsePLY } from '../../packages/loaders/dist/index.js';
import { assetWorkload, displayGeometry } from './asset-scene.js';
import { controls } from './ui-scene.js';

export async function createWorkload(count = 4, options = {}) {
  const source = await fetchBytes(new URL('../../packages/loaders/tests/fixtures/dolphins.ply', import.meta.url), {
      ...options,
      maxBytes: 100000,
    }),
    geometry = displayGeometry(parsePLY(source));
  let effect,
    ui,
    enabled = true;
  const scene = await assetWorkload(
    count,
    () => geometry,
    'Actual @margoengine/toon draws stepped diffuse/rim shading and an expanded, front-culled silhouette hull on the parsed dolphin surfaces. Run rotates the models; toggle shading to compare the actual core-mesh pipeline.',
    {
      ...options,
      repeat: false,
      cleanup: () => {
        effect?.dispose();
        ui?.dispose();
      },
    },
  );
  const mount = scene.mount;
  return Object.assign(scene, {
    mount(context) {
      mount(context);
      effect = Toon.attach(context.engine, { bands: 4, rim: 0.15, outline: 0.035 });
      ui = controls(context.parent, count, () => {});
      ui.actor.parentElement.remove();
      ui.button('Toggle toon + outlines', () => {
        enabled = !enabled;
        if (enabled) effect = Toon.attach(context.engine, { bands: 4, rim: 0.15, outline: 0.035 });
        else effect.dispose();
        context.render();
      }).dataset.uiToon = '';
    },
    details: () => ({
      models: count,
      sourceBytes: source.length,
      trianglesPerModel: geometry.indices.length / 3,
      enabled,
      bands: 4,
      outlineWorldUnits: 0.035,
    }),
  });
}
