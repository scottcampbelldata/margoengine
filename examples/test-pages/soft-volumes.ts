// Soft volumes test page (P8, SOFT-04 and SOFT-06; three.js `physics_ammo_volume`): two soft balls and a soft cube made
// from geometry primitives with `SoftBodyDesc.volume`, dropped on the ground and on rigid crates, drawn with
// `drawSoftBody` (@margoengine/gltf/soft-mesh) and seen in the shared debug view (@margoengine/physics/debug-view). A
// click pushes a body where it is clicked. Each button does what a user would and checks what they would see: the bodies
// bounce and rest holding their volume, a push moves a ball at J / M, a press squashes the cube and lets it spring back,
// and pumping the gas ball swells it.
import { ready } from './page-harness';
import { createStage } from '@margoengine/stage';
import { Physics } from '@margoengine/physics';
import { PhysicsDebugView } from '@margoengine/physics/debug-view';
import { SoftBodies, SoftBodyDesc, type SoftBody } from '@margoengine/physics/soft';
import { drawSoftBody, type SoftBodyMesh } from '@margoengine/gltf/soft-mesh';
import { boxGeometry, sphereGeometry } from '@margoengine/geometry/primitives';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const readout = document.getElementById('readout') as HTMLOutputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const say = (text: string) => (status.textContent = text);
/** A check a user would notice failing: logged as an error, so the page runner reports it. */
const expect = (ok: boolean, what: string) => {
  if (!ok) console.error(`soft volumes page: ${what}`);
  return ok;
};
type Vec3 = [number, number, number];

async function start() {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    background: '#9fb6c8',
    camera: { position: [0, 2.6, 6.5], target: [0, 0.6, 0], near: 0.1, far: 200, fov: 50 },
    onError: (error) => console.error(error),
  });
  const { engine } = stage;
  addEventListener('pagehide', () => stage.dispose(), { once: true });
  await Physics.load();
  const physics = new Physics(engine, { fixedTimestep: 1 / 60 });
  const soft = await SoftBodies.attach(physics);
  const debug = await PhysicsDebugView.attach(engine, physics, { enabled: false });

  // The ground and two rigid crates: one fixed block to land on, one loose crate a ball can shove.
  stage.box({ size: [12, 1, 12], position: [0, -0.5, 0], color: '#6f7468', roughness: 0.9 });
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [6, 0.5, 6] } });
  const block = stage.box({ size: [1, 0.6, 1], position: [-1.4, 0.3, 0], color: '#b49a74', roughness: 0.8 });
  physics.addBody(block, { type: 'fixed', colliders: { shape: 'box', halfExtents: [0.5, 0.3, 0.5] } });
  const crateMesh = stage.box({ size: [0.6, 0.6, 0.6], position: [1.6, 0.3, 0], color: '#8a6d4b', roughness: 0.7 });
  const crate = physics.addBody(crateMesh, { colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], density: 300 } });

  // The soft bodies, each straight from a geometry primitive, its seams welded.
  const ball = sphereGeometry(0.35, 20, 14);
  const make = (): { body: SoftBody; color: [number, number, number, number] }[] => [
    { body: soft.create(SoftBodyDesc.volume(ball, { density: 400 }).setTranslation([-1.4, 1.8, 0])), color: [0.85, 0.2, 0.15, 1] },
    {
      body: soft.create(SoftBodyDesc.volume(ball, { density: 60, pressure: 115_000 }).setTranslation([0, 2.2, 0.2])),
      color: [0.2, 0.4, 0.9, 1],
    },
    {
      body: soft.create(SoftBodyDesc.volume(boxGeometry(0.6, 0.6, 0.6, 4, 4, 4), { density: 300, stiffness: 12 }).setTranslation([0.9, 2.8, 0])),
      color: [0.25, 0.7, 0.35, 1],
    },
  ];
  let bodies: SoftBody[] = [];
  let meshes: SoftBodyMesh[] = [];
  let stopDebug: (() => void)[] = [];
  let rest: number[] = [];
  const build = () => {
    for (const mesh of meshes) mesh.dispose();
    for (const stop of stopDebug) stop();
    for (const body of bodies) if (body.valid) soft.remove(body);
    const made = make();
    bodies = made.map((m) => m.body);
    meshes = made.map((m) =>
      drawSoftBody(engine, m.body, {
        material: { pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: 0, roughnessFactor: 0.45 } },
      }),
    );
    stopDebug = bodies.map((body) => debug.add(body));
    rest = bodies.map((body) => body.surfaceVolume());
  };
  build();
  const [red, gas, cube] = [0, 1, 2].map((i) => () => bodies[i]!);

  const steps = (count: number) =>
    new Promise<void>((resolve) => {
      let n = 0;
      const off = physics.on('afterstep', () => {
        if (++n >= count) {
          off();
          resolve();
        }
      });
    });
  const height = (body: SoftBody) => {
    const p = body.particlePositions();
    let low = Infinity,
      high = -Infinity;
    for (let i = 1; i < p.length; i += 3) {
      low = Math.min(low, p[i]!);
      high = Math.max(high, p[i]!);
    }
    return high - low;
  };

  engine.onFrame(() => {
    readout.value = bodies
      .map((body, i) => `${['red ball', 'gas ball', 'cube'][i]} ${((body.surfaceVolume() / rest[i]!) * 100).toFixed(1)}% volume`)
      .join(' · ')
      .concat(gas().gasState() ? ` · gas ${(gas().gasState()!.pressure / 1000).toFixed(1)} kPa` : '');
  });

  // A click pushes the soft body nearest the pointer's ray, where the ray passes it.
  const ray = (x: number, y: number): { origin: Vec3; dir: Vec3 } => {
    const rect = canvas.getBoundingClientRect(),
      nx = ((x - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      ny = 1 - ((y - rect.top) / Math.max(1, rect.height)) * 2,
      { position: o, target: t, up: u, fov } = engine.camera,
      f = [t[0] - o[0], t[1] - o[1], t[2] - o[2]],
      fl = Math.hypot(...f),
      fw = f.map((v) => v / fl) as Vec3,
      r = [fw[1] * u[2] - fw[2] * u[1], fw[2] * u[0] - fw[0] * u[2], fw[0] * u[1] - fw[1] * u[0]],
      rl = Math.hypot(...r),
      rt = r.map((v) => v / rl) as Vec3,
      up: Vec3 = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]],
      tan = Math.tan((fov * Math.PI) / 360),
      aspect = rect.width / Math.max(1, rect.height),
      d = [0, 1, 2].map((a) => fw[a]! + rt[a]! * nx * aspect * tan + up[a]! * ny * tan),
      dl = Math.hypot(...d);
    return { origin: [o[0], o[1], o[2]], dir: d.map((v) => v / dl) as Vec3 };
  };
  canvas.addEventListener('pointerdown', (event) => {
    const { origin, dir } = ray(event.clientX, event.clientY);
    let best: { body: SoftBody; point: Vec3; miss: number } | null = null;
    for (const body of bodies) {
      const p = body.particlePositions();
      for (let i = 0; i < p.length; i += 3) {
        const v = [p[i]! - origin[0], p[i + 1]! - origin[1], p[i + 2]! - origin[2]],
          along = v[0]! * dir[0] + v[1]! * dir[1] + v[2]! * dir[2],
          miss = Math.hypot(v[0]! - along * dir[0], v[1]! - along * dir[1], v[2]! - along * dir[2]);
        if (along > 0 && miss < 0.1 && (!best || miss < best.miss))
          best = { body, point: [p[i]!, p[i + 1]!, p[i + 2]!], miss };
      }
    }
    if (!best) return;
    // 3 m/s for the whole body, given where it was clicked: the particles near the point take it, the rest follow.
    const j = 3 * best.body.mass();
    best.body.applyImpulseAtPoint([dir[0] * j, dir[1] * j, dir[2] * j], best.point, 0);
    say('Pushed.');
  });

  // Drop: they fall, bounce on the ground and the block, and settle holding their volume.
  const drop = async () => {
    build();
    let low = bodies.map(() => Infinity),
      bounce = bodies.map(() => 0);
    const off = physics.on('afterstep', () =>
      bodies.forEach((body, i) => {
        const y = body.centerOfMass()[1];
        if (y < low[i]!) low[i] = y;
        else bounce[i] = Math.max(bounce[i]!, y - low[i]!);
      }),
    );
    await steps(240);
    off();
    const held = bodies.map((body, i) => body.surfaceVolume() / rest[i]!);
    const names = ['red ball', 'gas ball', 'cube'];
    let ok = true;
    bodies.forEach((body, i) => {
      ok &&= expect(bounce[i]! > 0.02, `the ${names[i]} landed dead (rebound ${bounce[i]!.toFixed(3)} m)`);
      // A held volume keeps within 2 percent. The gas, filled at 115 kPa against 101.3 kPa outside, swells until its thin
      // shell's tension holds the difference, its pressure falling as 1 / V (Boyle): at rest it is at or above the air's.
      if (i === 1) {
        const state = body.gasState()!;
        ok &&= expect(held[i]! > 1, `the gas ball shrank to ${(held[i]! * 100).toFixed(1)}% of its fill volume`);
        ok &&= expect(
          Math.abs((state.pressure * state.volume) / (115_000 * rest[i]!) - 1) < 1e-3,
          `the gas ball lost gas: pV ${(state.pressure * state.volume).toFixed(1)} against ${(115_000 * rest[i]!).toFixed(1)}`,
        );
        ok &&= expect(state.pressure >= state.ambientPressure, `the gas ball is under the air's pressure (${state.pressure} Pa)`);
      } else ok &&= expect(Math.abs(held[i]! - 1) < 0.02, `the ${names[i]} is at ${(held[i]! * 100).toFixed(1)}% of its volume`);
      ok &&= expect(!body.particlePositions().some(Number.isNaN), `the ${names[i]} went NaN`);
      ok &&= expect(Math.min(...[...body.particlePositions()].filter((_, k) => k % 3 === 1)) > -0.01, `the ${names[i]} sank into the ground`);
    });
    if (ok) say(`Dropped: they bounced (${bounce.map((b) => b.toFixed(2)).join(', ')} m) and rest at ${held.map((h) => (h * 100).toFixed(1)).join(', ')}% of their volume.`);
  };
  button('btnDrop').addEventListener('click', drop);

  button('btnPush').addEventListener('click', async () => {
    const body = red(),
      z = () => body.centerOfMass()[2],
      j = 2 * body.mass();
    // The centre's speed over one step before the push and one after: the push adds J / M = 2 m/s, less at most one
    // step of the ground's friction (mu g dt, 0.08 m/s at mu = 0.5).
    // Read inside the step events: a frame may run several steps before a promise's continuation does.
    const at: number[] = [z()];
    await new Promise<void>((resolve) => {
      const off = physics.on('afterstep', () => {
        at.push(z());
        if (at.length === 2) body.applyImpulse([0, 0, -j]);
        if (at.length === 3) {
          off();
          resolve();
        }
      });
    });
    const gained = (at[1]! - at[2]!) * 60 - (at[0]! - at[1]!) * 60;
    if (expect(gained > 1.9 && gained < 2.01, `a push of J / M = 2 m/s changed the ball's speed by ${gained.toFixed(3)} m/s`))
      say(`Pushed the red ball: its speed changed by ${gained.toFixed(2)} m/s for J / M = 2 m/s.`);
  });

  button('btnPress').addEventListener('click', async () => {
    const body = cube(),
      standing = height(body);
    body.addForce([0, -40 * body.mass() * 9.81, 0]);
    await steps(60);
    const pressed = height(body);
    body.resetForces();
    await steps(90);
    const back = height(body);
    if (
      expect(pressed < standing - 0.02, `forty times its weight squashed the cube only from ${standing.toFixed(3)} to ${pressed.toFixed(3)} m`) &&
      expect(back > pressed + 0.01, `the cube did not spring back (${pressed.toFixed(3)} to ${back.toFixed(3)} m)`)
    )
      say(`Pressed the cube from ${standing.toFixed(2)} to ${pressed.toFixed(2)} m tall; it sprang back to ${back.toFixed(2)} m.`);
  });

  button('btnPump').addEventListener('click', async () => {
    const body = gas(),
      before = body.surfaceVolume();
    body.setGasPressure({ pressure: 141_855, volume: before });
    await steps(90);
    const after = body.surfaceVolume();
    if (expect(after > before * 1.01, `pumping did not swell the ball (${before.toFixed(4)} to ${after.toFixed(4)} m^3)`))
      say(`Pumped: the gas ball swelled ${(((after - before) / before) * 100).toFixed(1)}% at ${(body.gasState()!.pressure / 1000).toFixed(1)} kPa.`);
  });

  button('btnDebug').addEventListener('click', () => {
    debug.enabled = !debug.enabled;
    button('btnDebug').textContent = `Debug view: ${debug.enabled ? 'on' : 'off'}`;
    const lines = debug.collect().vertices.length / 6;
    if (debug.enabled) expect(lines > 0, 'the debug view drew no lines');
    say(`Debug view ${debug.enabled ? `on: ${lines} lines` : 'off'}.`);
  });

  await steps(120);
  expect(crate.valid, 'the crate is gone');
  say('Ready: click a soft body to push it, or use the buttons.');
  canvas.focus();
}

ready(start());
