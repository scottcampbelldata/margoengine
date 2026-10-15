import { TAA } from '../../packages/taa/dist/index.js';
import { createRobotWorkload } from './animator.js';
import { controls } from './ui-scene.js';

export async function createWorkload(count = 1, options = {}) {
  const scene = await createRobotWorkload(count, options, false),
    mount = scene.mount,
    details = scene.details,
    dispose = scene.dispose;
  let effect,
    removers = [],
    ui,
    enabled = true,
    resets = 0,
    historyWeight = 0.9,
    context,
    disposed = false;
  const detach = () => {
    removers.forEach((remove) => remove());
    removers = [];
    effect?.dispose();
    effect = undefined;
  };
  const attach = () => {
    effect = TAA.attach(context.engine, { historyWeight, depthThreshold: 0.01 });
    removers = scene.models.map((model) => effect.add(model));
  };
  const workload = Object.assign(scene, {
    description:
      'Actual TAA accumulates eight Halton jitter phases over walking, skinned/morphed PBR robots and moving parent transforms. Every model is registered with taa.add for deformed-vertex velocity/snapshots. Toggle temporal history or reset it to compare; these are real model surfaces, not cube stand-ins. Animation and velocity GPU work are included in frame time.',
    mount(value) {
      if (disposed) throw new Error('TAA workload is disposed');
      context = value;
      try {
        mount(value);
        attach();
        ui = controls(value.parent, count, () => {});
        ui.actor.parentElement.remove();
        ui.button('Toggle TAA', () => {
          enabled = !enabled;
          if (enabled) attach();
          else detach();
          value.render();
        }).dataset.uiTaa = '';
        ui.button('Reset temporal history', () => {
          if (effect) {
            effect.reset();
            resets++;
          }
          value.render();
        }).dataset.uiTaaReset = '';
        ui.select('History weight', ['0.9', '0.7', '0'], (weight) => {
          historyWeight = Number(weight);
          if (effect) {
            effect.options.historyWeight = historyWeight;
            effect.reset();
            resets++;
          }
          value.render();
        }).dataset.uiTaaWeight = '';
      } catch (error) {
        detach();
        scene.dispose();
        throw error;
      }
    },
    afterReady() {
      if (!disposed) for (let i = 0; i < 8; i++) context.render();
    },
    details: () => ({
      ...details(),
      taaEnabled: enabled,
      registeredVelocityModels: removers.length,
      historyWeight,
      manualHistoryResets: resets,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      options.signal?.removeEventListener('abort', workload.dispose);
      detach();
      ui?.dispose();
      dispose();
      context = undefined;
    },
  });
  options.signal?.addEventListener('abort', workload.dispose, { once: true });
  return workload;
}
