import RAPIER from '@dimforge/rapier3d-compat';
import { Input, Physics, Shadows, createStage } from 'margoengine/game';

// A ball on a table: WASD or the arrow keys roll it, Space jumps, and the crates are knocked over.
async function start() {
  await RAPIER.init();
  const stage = await createStage('#viewport', { camera: { position: [0, 9, 14], target: [0, 0, 0] } });
  const engine = stage.engine;
  const physics = new Physics(engine, { rapier: RAPIER });
  const shadows = Shadows.attach(engine, { resolution: 2048 });

  const floor = stage.box({ size: [16, 1, 16], position: [0, -0.5, 0], color: '#3a4250', roughness: 0.9 });
  physics.addBody(floor, { type: 'fixed' });
  shadows.add(floor);
  for (let i = 0; i < 9; i++) {
    const crate = stage.box({ position: [(i % 3) - 1, 0.5 + Math.floor(i / 3), -3], color: '#c08040' });
    physics.addBody(crate, { colliders: { shape: 'box', restitution: 0.1 } });
    shadows.add(crate);
  }
  const ball = stage.sphere({ radius: 0.5, position: [0, 1, 4], color: '#84d6bd', roughness: 0.3 });
  const body = physics.addBody(ball, { colliders: { shape: 'sphere', radius: 0.5, density: 3 } });
  shadows.add(ball);

  const input = new Input({
    x: [
      { type: 'key', code: 'KeyD' },
      { type: 'key', code: 'ArrowRight' },
      { type: 'key', code: 'KeyA', scale: -1 },
      { type: 'key', code: 'ArrowLeft', scale: -1 },
    ],
    z: [
      { type: 'key', code: 'KeyS' },
      { type: 'key', code: 'ArrowDown' },
      { type: 'key', code: 'KeyW', scale: -1 },
      { type: 'key', code: 'ArrowUp', scale: -1 },
    ],
    jump: [{ type: 'key', code: 'Space' }],
  });
  stage.onTick((delta) => {
    input.update();
    const force = 12 * delta;
    body.applyImpulse([input.state('x').value * force, 0, input.state('z').value * force]);
    if (input.state('jump').pressed) body.applyImpulse([0, 4, 0]);
  });
}

start().catch((error) => {
  document.querySelector('#error')!.textContent = `Could not start: ${error instanceof Error ? error.message : error}`;
});
