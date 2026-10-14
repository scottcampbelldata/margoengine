import {parseGLTF} from '../../packages/gltf-pro/dist/index.js';
import {Animation} from '../../packages/animation/dist/index.js';
import {fetchBytes} from '../../packages/loaders/dist/index.js';
import {controls} from './ui-scene.js';

/** The actual checked-in skinned robot, shared by Animator and TAA workloads. */
export async function createRobotWorkload(count = 1, options = {}, blend = true) {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new RangeError('Robot model count must be 1..4');
  const started = performance.now(), source = await fetchBytes(new URL('../assets/robot-expressive.glb', import.meta.url), {...options, maxBytes: 1000000});
  options.signal?.throwIfAborted();
  const Animator = blend ? (await import('../../packages/animator/dist/index.js')).Animator : undefined;
  options.signal?.throwIfAborted();
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength), jsonLength = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || jsonLength > source.length - 20) throw new TypeError('Invalid robot GLB metadata');
  const metadata = JSON.parse(new TextDecoder().decode(source.subarray(20, 20 + jsonLength))), primitiveCount = metadata.meshes.reduce((sum, mesh) => sum + mesh.primitives.length, 0);
  const points = new Float32Array(count * 4), yaw = new Float32Array(count), side = Math.ceil(Math.sqrt(count)), extent = side * 1.6;
  const models = [], animations = [], animators = [], layers = [], layerRemovers = [];
  let ui, context, time = 0, frames = 0, transitions = 0, previousStates = [], disposed = false, automatic = true, baseSpeed = 0.55, resting = false, waving = false, mountCpuMilliseconds = 0;
  const setupElapsedMilliseconds = performance.now() - started;
  const dispose = () => {
    if (disposed) return; disposed = true; options.signal?.removeEventListener('abort', dispose);
    ui?.dispose(); layerRemovers.forEach(remove => remove()); animators.forEach(animator => animator.dispose()); animations.forEach(animation => animation.dispose()); models.forEach(model => model.dispose()); context = undefined;
  };
  options.signal?.addEventListener('abort', dispose, {once: true});
  const step = delta => {
    if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid robot frame delta');
    time += delta; frames++;
    for (let i = 0; i < count; i++) {
      points[i * 4] = (i % side - (side - 1) / 2) * 3.2; points[i * 4 + 1] = 0; points[i * 4 + 2] = (Math.floor(i / side) - (side - 1) / 2) * 3.2; points[i * 4 + 3] = i % 3; yaw[i] = Math.sin(time * 0.3 + i) * 0.2;
      const animator = animators[i]; if (!animator) continue;
      if (previousStates[i] !== animator.state) {if (previousStates[i] !== undefined) transitions++; previousStates[i] = animator.state;}
      animator.parameters.speed = baseSpeed * (automatic ? 0.8 + Math.sin(time * 0.7 + i) * 0.2 : 1);
      animator.parameters.rest = (automatic ? (time + i * 2) % 10 < 2 : resting) ? 1 : 0; layers[i].weight = waving ? 0.3 : 0;
    }
  };
  step(0);
  const workload = {points, yaw, capacity: count * (metadata.nodes.length + 2), renderedObjects: count * primitiveCount,
    bounds: {min: [-extent, 0, -extent], max: [extent, 2.7, extent]},
    get models() {return models;}, get animations() {return animations;}, get animators() {return animators;},
    description: blend ? 'Real RobotExpressive PBR models use Animation skinning/morphs plus Animator Idle↔locomotion transitions, an Idle/Walking/Running blend tree and optional right-arm Wave additive layers. Actor cubes are cleared; bones and surfaces are the visible workload. Animator CPU pose work is included in engine render CPU, followed by actual GPU deformation.' : 'Real RobotExpressive PBR models retain walking skinning/morphs and moving actor transforms; temporal velocity must follow both the registered animated vertices and their parent motion. Actor cubes are cleared.',
    step,
    mount(value) {
      if (disposed) throw new Error('Robot workload is disposed'); options.signal?.throwIfAborted();
      if (value.engine.backend !== 'webgpu') throw new Error('Robot benchmark requires WebGPU for real PBR and deformation draws');
      if (context) throw new Error('Robot workload is already mounted'); context = value; const start = performance.now();
      try {
        value.meshes.forEach((anchor, index) => {
          anchor.setGeometry(null); anchor.name = `Robot ${index + 1} anchor`;
          const model = parseGLTF(value.engine, source); models.push(model); const bounds = model.bounds, scale = 2 / (bounds[4] - bounds[1]);
          model.root.setScale([scale, scale, scale]).setPosition([-(bounds[0] + bounds[3]) * scale / 2, -bounds[1] * scale, -(bounds[2] + bounds[5]) * scale / 2]).setParent(anchor);
          const animation = Animation.attach(model); animations.push(animation); animation.play('Walking'); animation.seek(index * 0.2);
          if (blend) {
            const animator = Animator.attach(animation, {states: {rest: 'Idle', move: {parameter: 'speed', samples: [{value: 0, clip: 'Idle'}, {value: 0.5, clip: 'Walking'}, {value: 1, clip: 'Running'}]}}, initial: 'move', parameters: {speed: baseSpeed, rest: 0}, transitions: [{from: 'move', to: 'rest', when: p => p.rest > 0.5, duration: 0.3}, {from: 'rest', to: 'move', when: p => p.rest < 0.5, duration: 0.3}]});
            animators.push(animator); const root = model.asset.doc.nodes.findIndex(node => node.name === 'UpperArm.R'), mask = [], visit = index => {mask.push(index); for (const child of model.asset.doc.nodes[index].children ?? []) visit(child);};
            if (root < 0) throw new Error('Robot right-arm additive mask is unavailable'); visit(root);
            const layer = {clip: 'Wave', weight: 0, mask}; layers.push(layer); layerRemovers.push(animator.addLayer(layer));
          }
        });
        if (blend) {
          ui = controls(value.parent, count, () => {}); ui.actor.parentElement.remove();
          ui.button('Toggle automatic idle transitions', () => {automatic = !automatic; step(0); value.render();}).dataset.uiAnimatorAutomatic = '';
          ui.button('Toggle manual rest', () => {automatic = false; resting = !resting; step(0); value.render();}).dataset.uiAnimatorRest = '';
          const speed = ui.select('Locomotion blend', ['0', '0.55', '1'], speed => {automatic = false; baseSpeed = Number(speed); step(0); value.render();}); speed.dataset.uiAnimatorSpeed = ''; speed.value = '0.55';
          ui.button('Toggle right-arm Wave layer', () => {waving = !waving; step(0); value.render();}).dataset.uiAnimatorWave = '';
        }
        step(0); mountCpuMilliseconds = performance.now() - start;
      } catch (error) {dispose(); throw error;}
    },
    details: () => ({robotModels: count, nodesPerRobot: metadata.nodes.length, pbrPrimitives: models.reduce((sum, model) => sum + model.primitives.length, 0), triangles: models.reduce((sum, model) => sum + model.primitives.reduce((n, primitive) => n + primitive.indices.length / 3, 0), 0), clipsPerRobot: metadata.animations.length, animatorControllers: animators.length, activeMoveControllers: animators.filter(animator => animator.state === 'move').length, registeredWaveLayers: layers.length, waveWeight: waving ? 0.3 : 0, frames, transitions, automaticTransitions: automatic, sourceBytes: source.length, setupElapsedMilliseconds, mountCpuMilliseconds}), dispose
  };
  return workload;
}

export const createWorkload = (count, options) => createRobotWorkload(count, options, true);
