import { Physics } from '@margoengine/physics';
import { PhysicsDebugView } from '@margoengine/physics/debug-view';
import { createStage } from '@margoengine/stage';
import { demoStatus } from './demo-status.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const status = demoStatus(canvas, document.querySelector('#status'));
const debug = document.querySelector<HTMLInputElement>('#debug')!;
const readout = document.querySelector<HTMLOutputElement>('#readout')!;
const life = new AbortController();
let release = () => {};
window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    release();
  },
  { once: true },
);

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    background: '#b9c7d2',
    camera: {
      position: [0, 7, 12],
      target: [0, 0.5, 0],
      near: 0.1,
      far: 80,
      fov: 50,
    },
    onError: (error) => status.error(error),
  });
  release = () => stage.dispose();
  await Physics.load({ signal: life.signal });
  life.signal.throwIfAborted();
  const { engine } = stage;
  const physics = new Physics(engine);
  release = () => {
    physics.dispose();
    stage.dispose();
  };
  const fixed = (size: [number, number, number], position: [number, number, number], tilt = 0, color = '#8f8a7a') => {
    const mesh = stage.box({
      size,
      position,
      rotation: [0, 0, tilt],
      color,
      roughness: 0.9,
    });
    physics.addBody(mesh, {
      type: 'fixed',
      colliders: {
        shape: 'box',
        halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2],
      },
    });
  };
  fixed([30, 0.2, 30], [0, -0.1, 0]);
  fixed([4, 0.2, 3], [-6, 0.9, -3], (25 * Math.PI) / 180, '#a59c80'); // 25 degrees: walks up
  fixed([4, 0.2, 3], [-6, 1.6, 3], (60 * Math.PI) / 180, '#9a6d5a'); // 60 degrees: slides off
  for (let i = 0; i < 6; i++) fixed([1, 0.18 * (i + 1), 3], [4 + i * 0.4, 0.09 * (i + 1), -4], 0, '#a8a395');
  const deck = stage.box({
    size: [3, 0.3, 3],
    position: [0, 0.15, 5],
    color: '#5d7b8c',
    roughness: 0.6,
  });
  const platform = physics.addBody(deck, {
    type: 'kinematicPosition',
    colliders: { shape: 'box', halfExtents: [1.5, 0.15, 1.5] },
  });
  for (const [x, z] of [
    [2, 1],
    [3, 2],
  ])
    physics.addBody(
      stage.box({
        size: [0.8, 0.8, 0.8],
        position: [x, 0.4, z],
        color: '#c08a3e',
      }),
      {
        colliders: { shape: 'box', halfExtents: [0.4, 0.4, 0.4], density: 80 },
      },
    );

  const player = physics.addBody(stage.box({ size: [0.6, 1.6, 0.6], position: [0, 1, 0], color: '#3f6fb0' }), {
    type: 'kinematicPosition',
    colliders: { shape: 'capsule', halfHeight: 0.5, radius: 0.3 },
  });
  const controller = physics.createCharacterController(player, {
    applyImpulsesToDynamicBodies: true,
    characterMass: 70,
  });
  const view = await PhysicsDebugView.attach(engine, physics);
  view.add(controller);
  debug.addEventListener('change', () => (view.enabled = debug.checked), {
    signal: life.signal,
  });

  const keys = new Set<string>();
  addEventListener('keydown', (event) => keys.add(event.code), {
    signal: life.signal,
  });
  addEventListener('keyup', (event) => keys.delete(event.code), {
    signal: life.signal,
  });
  const speed = 4;
  let clock = 0;
  physics.on('beforestep', (dt) => {
    clock += dt;
    platform.setNextPosition([4 * Math.sin(clock * 0.5), 0.15, 5]);
    const x = +(keys.has('KeyD') || keys.has('ArrowRight')) - +(keys.has('KeyA') || keys.has('ArrowLeft')),
      z = +(keys.has('KeyS') || keys.has('ArrowDown')) - +(keys.has('KeyW') || keys.has('ArrowUp')),
      l = Math.hypot(x, z) || 1;
    if (keys.has('Space')) controller.jump(5);
    const step = controller.walk([(x / l) * speed, 0, (z / l) * speed]);
    readout.value =
      (step.grounded ? 'grounded' : 'in the air') +
      (step.slidingDownSlope ? ', sliding' : '') +
      ` · slope ${((controller.slopeAngle * 180) / Math.PI).toFixed(1)}°` +
      (controller.platform === platform ? ' · on the platform' : '');
  });
  debug.disabled = false;
  canvas.focus();
  status.ready('');
} catch (error) {
  if (!life.signal.aborted) status.error(error);
}
