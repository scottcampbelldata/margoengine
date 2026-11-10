import { createStage } from '../../dist/index.js';
import { addGLTF } from '../../dist/gltf.js';
import { addShadows } from '../../dist/shadows.js';
import { loadGLTF } from '../../../gltf-pro/dist/index.js';
import { Animation } from '../../../animation/dist/index.js';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const errors = [];
if (new URLSearchParams(location.search).has('compat')) {
  const { install } = await import('../../../webgl2-compat/dist/index.js');
  await install({ force: true });
}
const stages = await Promise.all(
  ['#a', '#b'].map((selector) =>
    createStage(selector, {
      autoStart: false,
      controls: false,
      onError: (error) => errors.push(String(error)),
    }),
  ),
);
for (const stage of stages) stage.engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const frame = async () => {
  for (const stage of stages) {
    stage.engine.render({ delta: 0 });
    await stage.engine.gpu.queue.onSubmittedWorkDone();
  }
};
window.check = {
  errors,
  async load(url, animated) {
    const wrapped = await addGLTF(stages[0], url, { fit: false }),
      direct = await loadGLTF(stages[1].engine, url);
    const player = animated ? Animation.attach(direct).play(0) : null;
    if (animated) {
      wrapped.animation.play(0);
      wrapped.animation.seek(0.3);
      player.seek(0.3);
    }
    stages[0].fit(wrapped.meshes);
    stages[1].fit(direct.primitives.map((p) => p.node));
    const shadows = animated
      ? []
      : await Promise.all(stages.map((stage) => addShadows(stage, { resolution: 64, filter: 'hard' })));
    await waitForPipelines(frame);
    this.drop = () => {
      for (const shadow of shadows) shadow.dispose();
      wrapped.destroy();
      direct.dispose();
    };
    return { primitives: direct.primitives.length, animation: !!wrapped.animation, shadowFar: shadows[0]?.splits[3] };
  },
  close() {
    for (const stage of stages) stage.dispose();
    return errors;
  },
};
