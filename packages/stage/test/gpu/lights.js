import { createStage } from '../../dist/index.js';
import { addGLTF } from '../../dist/gltf.js';
import { addLights } from '../../dist/lights.js';
import { Clustered } from '../../../clustered/dist/index.js';
import { AreaLights } from '../../../clustered/dist/area.js';
import { DirectionalLights } from '../../../clustered/dist/directional.js';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

if (new URLSearchParams(location.search).has('compat')) {
  const { install } = await import('../../../webgl2-compat/dist/index.js');
  await install({ force: true });
}
const errors = [],
  stages = [],
  models = [];
for (const id of ['#a', '#b']) {
  const stage = await createStage(id, { autoStart: false, controls: false, onError: (e) => errors.push(String(e)) });
  stage.engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  stages.push(stage);
  models.push(await addGLTF(stage, '/packages/exporters/tests/fixtures/BoxTextured.glb'));
}
const definitions = [
  { type: 'point', position: [2, 2, 2], color: [1, 0.1, 0.1], intensity: 20, range: 8 },
  {
    type: 'spot',
    position: [-2, 2, 2],
    direction: [2, -2, -2],
    color: [0.1, 1, 0.1],
    intensity: 30,
    range: 8,
    outerAngle: 0.7,
  },
  {
    type: 'area',
    position: [0, 2, 1],
    direction: [0, -2, -1],
    color: [0.1, 0.1, 1],
    intensity: 4,
    width: 2,
    height: 2,
  },
  { type: 'directional', direction: [0, -1, -1], color: [1, 0.2, 0.7], intensity: 2 },
];
async function frame() {
  for (const stage of stages) {
    stage.engine.render({ delta: 0 });
    await stage.engine.gpu.queue.onSubmittedWorkDone();
  }
}
window.check = {
  errors,
  async install(kind) {
    const list = definitions.filter((light) => kind === 'all' || light.type === kind),
      wrapped = await addLights(stages[0], list),
      direct = Clustered.attach(stages[1].engine),
      cleanup = [];
    direct.setLights(
      list.filter((l) => l.type === 'point' || l.type === 'spot').map(({ type: _type, ...light }) => light),
    );
    cleanup.push(direct.add(models[1].pbr));
    for (const [type, Class] of [
      ['area', AreaLights],
      ['directional', DirectionalLights],
    ]) {
      const lights = list.filter((l) => l.type === type).map(({ type: _type, ...light }) => light);
      if (lights.length) {
        const plugin = Class.attach(stages[1].engine, { lights: direct });
        plugin.setLights(lights);
        cleanup.push(() => plugin.dispose());
      }
    }
    await waitForPipelines(frame);
    this.drop = () => {
      wrapped.dispose();
      for (const release of cleanup.reverse()) release();
      direct.dispose();
    };
    return wrapped.clustered.hasReceiver(models[0].pbr);
  },
  async clear() {
    this.drop();
    await waitForPipelines(frame);
  },
  close() {
    for (const stage of stages) stage.dispose();
    return errors;
  },
};
await waitForPipelines(frame);
window.ready = true;
