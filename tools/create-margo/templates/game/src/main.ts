import {
  Animation,
  Animator,
  Bloom,
  Input,
  Material,
  Physics,
  Shadows,
  Sky,
  createMesh,
  createStage,
  sphereGeometry,
} from '@margoengine/game';
import {loadGLTF} from '@margoengine/game/gltf-pro';

// Find the six glowing orbs. WASD or the arrow keys walk, Shift runs; walk into the crates to knock them over.
const hud = document.querySelector('#hud')!;

async function start() {
  await Physics.load();
  const stage = await createStage('#viewport', { controls: false, camera: { position: [0, 4, 9], target: [0, 1, 0] } });
  const engine = stage.engine;
  const sky = Sky.attach(engine, {
    hours: 16.6,
    timeScale: 0,
    lighting: { intensity: 6, color: [1, 0.95, 0.88], ambient: { day: [0.16, 0.2, 0.26], night: [0.02, 0.03, 0.06] } },
  });
  const shadows = Shadows.attach(engine, { resolution: 2048, distance: 40, lightSize: 0.02 });
  Bloom.attach(engine, { strength: 0.35, threshold: 1 });
  const physics = new Physics(engine);

  // The ground and a stack of crates that fall over when you walk into them.
  const ground = stage.box({ size: [40, 1, 40], position: [0, -0.5, 0], color: '#6f8f4e', roughness: 0.95 });
  physics.addBody(ground, { type: 'fixed' });
  shadows.add(ground);
  for (let layer = 0; layer < 3; layer++)
    for (let i = 0; i < 3 - layer; i++) {
      const crate = stage.box({
        position: [3 + i * 1.02 + layer * 0.51, 0.5 + layer, -4],
        color: '#b07a42',
        roughness: 0.8,
      });
      physics.addBody(crate, { colliders: { shape: 'box', restitution: 0.05, density: 0.4 } });
      shadows.add(crate);
    }

  // The hero, with Idle, Walk and Run blended by speed, and a cheer when every orb is found.
  const hero = await loadGLTF(engine, '/pete.glb');
  shadows.add(hero);
  const animator = Animator.attach(Animation.attach(hero), {
    initial: 'move',
    parameters: { speed: 0, won: 0 },
    states: {
      move: {
        parameter: 'speed',
        samples: [
          { value: 0, clip: 'Idle' },
          { value: 2, clip: 'Walk' },
          { value: 5, clip: 'Run' },
        ],
      },
      cheer: 'Cheer',
    },
    transitions: [{ from: 'move', to: 'cheer', when: (p) => p.won > 0, duration: 0.3 }],
  });
  const body = physics.addBody(null, {
    type: 'kinematicPosition',
    colliders: { shape: 'capsule', halfHeight: 0.55, radius: 0.4 },
  });

  // Six orbs on a ring, bobbing; their glow is emissive light that Bloom spreads.
  const glow = new Material({ color: '#ffe9a8', emissive: '#ffcf5a', emissiveIntensity: 6, roughness: 0.3 });
  const orbs = Array.from({ length: 6 }, (_, i) => {
    const angle = (i / 6) * Math.PI * 2;
    const mesh = createMesh(engine, sphereGeometry(0.25, 24, 16), glow);
    mesh.root.setPosition([Math.cos(angle) * 7, 1, Math.sin(angle) * 7]);
    return { mesh, angle, found: false };
  });

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
    run: [
      { type: 'key', code: 'ShiftLeft' },
      { type: 'key', code: 'ShiftRight' },
    ],
  });
  const position: [number, number, number] = [0, 0, 0];
  let yaw = 0,
    speed = 0,
    found = 0,
    time = 0;
  stage.onTick((delta) => {
    time += delta;
    input.update();
    const x = input.state('x').value,
      z = input.state('z').value,
      moving = Math.hypot(x, z) > 0.1;
    const target = found === orbs.length ? 0 : moving ? (input.state('run').value > 0 ? 5 : 2) : 0;
    speed += (target - speed) * Math.min(1, delta * 8);
    if (moving) {
      const heading = Math.atan2(x, z);
      yaw += Math.atan2(Math.sin(heading - yaw), Math.cos(heading - yaw)) * Math.min(1, delta * 10);
    }
    position[0] = Math.max(-19, Math.min(19, position[0] + Math.sin(yaw) * speed * delta));
    position[2] = Math.max(-19, Math.min(19, position[2] + Math.cos(yaw) * speed * delta));
    hero.root.setPosition(position);
    hero.root.rotation.y = yaw;
    body.setNextPosition([position[0], 0.95, position[2]]);
    animator.parameters.speed = speed;

    for (const orb of orbs) {
      if (orb.found) continue;
      const { x: ox, z: oz } = orb.mesh.root.position;
      orb.mesh.root.setPosition([ox, 1 + Math.sin(time * 2 + orb.angle * 3) * 0.2, oz]);
      if (Math.hypot(ox - position[0], oz - position[2]) < 0.9) {
        orb.found = true;
        orb.mesh.root.visible = false;
        found++;
        if (found === orbs.length) animator.parameters.won = 1;
      }
    }
    hud.textContent = found === orbs.length ? 'All six orbs found!' : `Orbs ${found} / ${orbs.length}`;

    // A camera that follows from behind and above.
    const camera = engine.camera,
      follow = Math.min(1, delta * 3);
    const eye = [position[0] - Math.sin(yaw) * 6, 3.6, position[2] - Math.cos(yaw) * 6];
    camera.position = [0, 1, 2].map((i) => camera.position[i] + (eye[i] - camera.position[i]) * follow) as [
      number,
      number,
      number,
    ];
    camera.target = [position[0], 1.2, position[2]];
  });
  void sky;
}

start().catch((error) => {
  document.querySelector('#error')!.textContent = `Could not start: ${error instanceof Error ? error.message : error}`;
});
