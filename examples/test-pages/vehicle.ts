// Vehicle test page: a drivable arcade car (P5 DYN-04) on a floor with a kerb, a ramp and posts, using only public APIs:
// `Vehicle.car` from @margoengine/physics, its `debugRender()` drawn with @margoengine/lines, and the stage for the
// scene. The keyboard drives it (W/S or the arrows, A/D to steer, Space to brake). Each button scripts the same input for
// a while and checks what a driver would see: it speeds up, turns, stops, rides over the ramp upright, and a reset puts
// every bit back.
import { ready } from './page-harness';
import { createStage } from '@margoengine/stage';
import { Line, LineMaterial, Lines } from '@margoengine/lines';
import { Physics, Vehicle, type VehicleInput } from '@margoengine/physics';
import { cylinderGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const readout = document.getElementById('readout') as HTMLOutputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const say = (text: string) => (status.textContent = text);
/** A check a user would notice failing: logged as an error, so the page runner reports it. */
const expect = (ok: boolean, what: string) => {
  if (!ok) console.error(`vehicle page: ${what}`);
  return ok;
};

async function start() {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    background: '#9fb6c8',
    camera: { position: [0, 4, -9], target: [0, 0.8, 3], near: 0.1, far: 400, fov: 55 },
    onError: (error) => console.error(error),
  });
  const { engine } = stage;
  addEventListener('pagehide', () => stage.dispose(), { once: true });
  await Physics.load();
  const physics = new Physics(engine);

  // The ground: a floor, a kerb, a ramp and posts every 10 m along both sides, so speed and turns can be seen.
  const fixed = (size: [number, number, number], position: [number, number, number], color: string, tilt = 0) => {
    const rotation: [number, number, number, number] = [Math.sin(tilt / 2), 0, 0, Math.cos(tilt / 2)];
    const mesh = stage.box({ size, position, rotation: [tilt, 0, 0], color, roughness: 0.9 });
    physics.addBody(mesh, {
      type: 'fixed',
      rotation,
      colliders: { shape: 'box', halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2] },
    });
  };
  fixed([400, 1, 400], [0, -0.5, 0], '#6f7468');
  fixed([7, 0.1, 0.8], [0, 0.05, 22], '#c9c2b0');
  // A hump: a 9 m ramp up at 0.06 rad and one down, meeting 0.54 m above the floor.
  const slope = 0.06,
    lift = -0.2 + 4.5 * Math.sin(slope),
    run = 9 * Math.cos(slope);
  fixed([7, 0.4, 9], [0, lift, 34], '#b49a74', -slope);
  fixed([7, 0.4, 9], [0, lift, 34 + run], '#a68c68', slope);
  for (let z = -40; z <= 120; z += 10)
    for (const x of [-14, 14]) fixed([0.3, 1.2, 0.3], [x, 0.6, z], z % 50 === 0 ? '#e0b030' : '#d8d8d8');

  // The car: a box body with a cabin, and four wheels whose axle is along x, as the vehicle poses them.
  const body = stage.box({ size: [1.8, 0.6, 4], position: [0, 1, 0], color: '#b8322a', roughness: 0.35 });
  stage.box({ size: [1.5, 0.5, 2], position: [0, 0.55, -0.3], color: '#2b3440', roughness: 0.2, parent: body });
  const chassis = physics.addBody(body, { colliders: { shape: 'box', halfExtents: [0.9, 0.3, 2], mass: 1200 } });
  const tyre = cylinderGeometry(0.315, 0.315, 0.19, 24);
  for (const array of [tyre.positions, tyre.normals])
    for (let i = 0; i < array.length; i += 3) {
      const [x, y] = [array[i]!, array[i + 1]!];
      array[i] = y;
      array[i + 1] = -x;
    }
  const wheelGeometry = toGeometry(tyre);
  const wheelMeshes = [0, 1, 2, 3].map(() =>
    stage.mesh(wheelGeometry, { parent: body, color: '#1d1f22', roughness: 0.8 }),
  );
  const car = Vehicle.car(physics, chassis, { wheelMeshes });

  // Input: the keyboard, unless a button is scripting the car.
  const keys = new Set<string>();
  canvas.addEventListener('keydown', (event) => {
    keys.add(event.code);
    if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
  });
  canvas.addEventListener('keyup', (event) => keys.delete(event.code));
  canvas.addEventListener('blur', () => keys.clear());
  const held = (...codes: string[]) => (codes.some((code) => keys.has(code)) ? 1 : 0);
  let script: VehicleInput | null = null;
  physics.on('beforestep', () => {
    if (script) car.setInput(script);
    else {
      const throttle = held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown');
      // Back at speed brakes; held at a standstill it reverses.
      const braking = held('Space') || (throttle < 0 && car.speed > 0.5) ? 1 : 0;
      car.setInput({
        throttle: braking && throttle < 0 ? 0 : throttle,
        steer: held('KeyA', 'ArrowLeft') - held('KeyD', 'ArrowRight'),
        brake: braking,
      });
    }
  });

  // The debug view: the vehicle's own lines, refreshed after every step.
  const lines = Lines.attach(engine);
  const debug = lines.add(
    new Line({
      mode: 'segments',
      positions: [0, 0, 0, 0, 0, 0],
      material: new LineMaterial({ width: 2, onTop: true }),
    }),
  );
  let debugOn = true;
  physics.on('afterstep', () => {
    if (!debugOn) return;
    const { vertices, colors } = car.debugRender();
    debug.setPositions(vertices, colors);
  });

  // A chase camera and the readout.
  engine.onFrame(() => {
    const { x: px, y: py, z: pz } = body.position,
      [x, y, z, w] = chassis.rotation,
      fx = 2 * (x * z + w * y),
      fz = 1 - 2 * (x * x + y * y),
      size = Math.hypot(fx, fz) || 1;
    engine.camera.position = [px - (fx / size) * 8, py + 2.2, pz - (fz / size) * 8];
    engine.camera.target = [px + (fx / size) * 3, py + 0.5, pz + (fz / size) * 3];
    readout.value = `Speed ${Math.abs(Math.round(car.speed * 3.6))} km/h · wheels on the ground ${
      [0, 1, 2, 3].filter((i) => car.wheel(i).inContact).length
    } of 4`;
  });

  const steps = (count: number, until?: () => boolean) =>
    new Promise<void>((resolve) => {
      let n = 0;
      const off = physics.on('afterstep', () => {
        if (++n >= count || until?.()) {
          off();
          resolve();
        }
      });
    });
  const heading = () => {
    const [x, y, z, w] = chassis.rotation;
    return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
  };
  const upright = () => {
    const [x, , z] = chassis.rotation;
    return 1 - 2 * (x * x + z * z);
  };
  const drive = async (input: VehicleInput, count: number, until?: () => boolean) => {
    script = input;
    await steps(count, until);
    script = null;
  };

  // Settle on the springs, then keep the start for Reset.
  await steps(90);
  const start = physics.takeSnapshot();
  const motion = new Float64Array(car.motionStateWords);
  car.writeMotionState(motion);
  const reset = () => {
    physics.restoreSnapshot(start);
    car.readMotionState(motion);
  };
  const restHash = physics.kernel.hash;
  const settled = car.wheel(0).suspensionLength;

  button('btnDrive').addEventListener('click', async () => {
    const before = car.speed;
    await drive({ throttle: 1 }, 120);
    // 0.4 g for two seconds adds 7.8 m/s; a turn or a bump on the way takes a little.
    if (expect(car.speed - before > 5, `full throttle for 2 s added only ${(car.speed - before).toFixed(2)} m/s`))
      say(`Drove: ${(car.speed * 3.6).toFixed(0)} km/h after 2 s of full throttle.`);
  });
  button('btnTurn').addEventListener('click', async () => {
    const before = heading();
    await drive({ throttle: 0.6, steer: 1 }, 120);
    const turned = Math.abs(((heading() - before + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    if (
      expect(turned > 0.35 && upright() > 0.9, `steering turned the car ${turned.toFixed(2)} rad, upright ${upright()}`)
    )
      say(`Turned ${((turned * 180) / Math.PI).toFixed(0)} degrees, still on four wheels.`);
  });
  button('btnBrake').addEventListener('click', async () => {
    await drive({ brake: 1 }, 360, () => Math.abs(car.speed) < 0.05);
    if (expect(Math.abs(car.speed) < 0.3, `the brake left ${car.speed.toFixed(2)} m/s`)) say('Stopped.');
  });
  button('btnRamp').addEventListener('click', async () => {
    reset();
    let deepest = Infinity,
      lowest = 1;
    const off = physics.on('afterstep', () => {
      for (let i = 0; i < 4; i++) deepest = Math.min(deepest, car.wheel(i).suspensionLength);
      lowest = Math.min(lowest, upright());
    });
    await drive({ throttle: 0.7 }, 900, () => chassis.position[2] > 52);
    off();
    const rest = settled;
    if (
      expect(
        chassis.position[2] > 52,
        `the car stopped at z ${chassis.position[2].toFixed(1)} before clearing the ramp`,
      ) &&
      expect(deepest < 0.8 * rest, `the kerb and ramp never compressed a spring (${deepest} of ${rest})`) &&
      expect(lowest > 0.85, `the car tipped to ${lowest.toFixed(2)} over the ramp`)
    )
      say(`Over the kerb and the ramp: the springs took ${(rest - deepest).toFixed(3)} m and the car stayed upright.`);
  });
  button('btnDebug').addEventListener('click', () => {
    debugOn = !debugOn;
    debug.visible = debugOn;
    button('btnDebug').textContent = `Debug view: ${debugOn ? 'on' : 'off'}`;
    say(`Debug view ${debugOn ? 'on' : 'off'}.`);
  });
  button('btnReset').addEventListener('click', async () => {
    reset();
    script = { throttle: 0 };
    expect(physics.kernel.hash === restHash, 'a reset did not restore the world bit for bit');
    await steps(1);
    script = null;
    say('Reset to the start.');
  });

  say('Ready: click the view and drive with W A S D or the arrows, Space to brake.');
  canvas.focus();
}

ready(start());
