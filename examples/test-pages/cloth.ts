// Cloth test page (P6 SOFT-01), public APIs only: a flag tied to a pole that is a rigid body, streaming in a gusty wind,
// and a cloth dropped onto a ball, both `GPUCloth` of @margoengine/physics/gpu-cloth (on the GPU on WebGPU, its CPU twin on
// the WebGL2 compatibility layer), drawn by `drawGPUCloth` of @margoengine/gltf/soft-mesh straight from the buffer the
// compute writes. The pointer pushes the draped cloth with a sphere collider. Each button checks what a viewer would see:
// the cloth comes to rest on the ball, the flag streams downwind, a push moves the cloth, and a reset is bit for bit.
import { ready } from './page-harness';
import { Engine, PbrMaterial, box, type Geometry } from '@margoengine/core';
import { sphereGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { Line, LineMaterial, Lines } from '@margoengine/lines';
import { Physics } from '@margoengine/physics';
import { GPUCloth, type GPUClothSnapshot } from '@margoengine/physics/gpu-cloth';
import { FABRICS, SoftBodyDesc } from '@margoengine/physics/soft';
import { drawGPUCloth } from '@margoengine/gltf/soft-mesh';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const readout = document.getElementById('readout') as HTMLOutputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const say = (text: string) => (status.textContent = text);
/** A check a user would notice failing: logged as an error, so the page runner reports it. */
const expect = (ok: boolean, what: string) => {
  if (!ok) console.error(`cloth page: ${what}`);
  return ok;
};

type V3 = [number, number, number];
const WIND: V3 = [6, 0, 1];
// The ball the cloth drapes over, and the cloth: 1.6 m square, 33 x 33 particles, centred 0.3 m above the ball's top.
const BALL: V3 = [1.2, 0.6, 0],
  RADIUS = 0.5,
  SIDE = 33,
  SPACING = 0.05,
  CENTRE = 16 * SIDE + 16;
// The pole: 3 m tall at x = -1.6; the flag: 1.5 m by 0.9 m of sailcloth, its first column tied along the pole.
const POLE: V3 = [-1.6, 1.5, 0],
  FLAG_U = 16,
  FLAG_V = 10;

async function start() {
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 2, 6], target: [0, 1.1, 0], near: 0.1, far: 100, fov: 50 },
  });
  engine.onError = (error) => console.error(error);
  engine.scene.background = '#9fb6c8';
  addEventListener('pagehide', () => engine.dispose(), { once: true });
  const solid = (geometry: Geometry, position: V3, color: string) =>
    engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial({ color, roughness: 0.7 })).setPosition(position);
  await Physics.load();
  await GPUCloth.load();
  const physics = new Physics(engine);

  solid(box(12, 0.2, 8), [0, -0.1, 0], '#6f7468');
  solid(toGeometry(sphereGeometry(RADIUS - 0.005, 48, 24)), BALL, '#c9c2b0');
  solid(box(0.06, 3, 0.06), POLE, '#d8d8d8');
  const pole = physics.addBody(null, {
    type: 'fixed',
    position: POLE,
    colliders: { shape: 'capsule', halfHeight: 1.5, radius: 0.03 },
  });

  // The flag, tied to the pole body (carried by it wherever it goes) and kept off it by its capsule.
  const flag = GPUCloth.attach(
    engine,
    SoftBodyDesc.cloth([POLE[0] + 0.04, 3, 0], [0.1, 0, 0], [0, -0.1, 0], FLAG_U, FLAG_V).setFabric(FABRICS.sailcloth),
    { physics, wind: WIND, turbulence: 0.3 },
  );
  for (let j = 0; j < FLAG_V; j++) flag.attach(j, pole);
  flag.addCollider({ shape: 'capsule', radius: 0.03, halfHeight: 1.5, body: pole });
  drawGPUCloth(engine, flag, { material: { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.12, 0.1, 1] } } });

  // The drape: cotton, falling onto the ball and the ground; a pusher sphere follows the pointer.
  const half = ((SIDE - 1) * SPACING) / 2;
  const drape = GPUCloth.attach(
    engine,
    SoftBodyDesc.cloth([BALL[0] - half, BALL[1] + RADIUS + 0.3, -half], [SPACING, 0, 0], [0, 0, SPACING], SIDE, SIDE),
    { physics },
  );
  drape.addCollider({ shape: 'sphere', radius: RADIUS, position: BALL });
  drape.addCollider({ shape: 'plane' });
  const away: V3 = [0, -10, 0];
  const pusher = drape.addCollider({ shape: 'sphere', radius: 0.15, position: away });
  drawGPUCloth(engine, drape, { material: { pbrMetallicRoughness: { baseColorFactor: [0.15, 0.3, 0.7, 1] } } });

  // The pointer's ray met with the upright plane just in front of the ball (z = 0.6), where the cloth hangs.
  let scripted = false;
  const pointAt = (event: PointerEvent): V3 | null => {
    const rect = canvas.getBoundingClientRect();
    const { position: o, target, fov } = engine.camera;
    const f = [target[0] - o[0], target[1] - o[1], target[2] - o[2]],
      fl = Math.hypot(f[0], f[1], f[2]);
    const fw = f.map((x) => x / fl),
      r = [-fw[2], 0, fw[0]],
      rl = Math.hypot(r[0], r[2]);
    const right = r.map((x) => x / rl),
      up = [right[1] * fw[2] - right[2] * fw[1], right[2] * fw[0] - right[0] * fw[2], right[0] * fw[1] - right[1] * fw[0]];
    const t = Math.tan((fov * Math.PI) / 360),
      aspect = rect.width / Math.max(1, rect.height);
    const sx = (((event.clientX - rect.left) / rect.width) * 2 - 1) * t * aspect,
      sy = (1 - ((event.clientY - rect.top) / rect.height) * 2) * t;
    const d = [0, 1, 2].map((k) => fw[k]! + right[k]! * sx + up[k]! * sy);
    if (Math.abs(d[2]!) < 1e-6) return null;
    const s = (0.6 - o[2]) / d[2]!;
    return s > 0 ? [o[0] + d[0]! * s, o[1] + d[1]! * s, 0.6] : null;
  };
  canvas.addEventListener('pointermove', (event) => {
    if (!scripted) pusher.position = pointAt(event) ?? away;
  });
  canvas.addEventListener('pointerleave', () => {
    if (!scripted) pusher.position = away;
  });

  // The debug view: both cloths' lines (edges by strain, pins, colliders, wind), drawn on top.
  const lines = Lines.attach(engine);
  const debug = lines.add(
    new Line({ mode: 'segments', positions: [0, 0, 0, 0, 0, 0], material: new LineMaterial({ width: 1.5, onTop: true }) }),
  );
  debug.visible = false;
  let debugOn = false;
  engine.onFrame(() => {
    readout.value = `${flag.stats.backend}: flag ${flag.count} and drape ${drape.count} particles, ${drape.stats.steps} steps`;
    if (!debugOn) return;
    const a = flag.debugRender(),
      b = drape.debugRender({ normals: false });
    const vertices = new Float32Array(a.vertices.length + b.vertices.length),
      colors = new Float32Array(a.colors.length + b.colors.length);
    vertices.set(a.vertices);
    vertices.set(b.vertices, a.vertices.length);
    colors.set(a.colors);
    colors.set(b.colors, a.colors.length);
    debug.setPositions(vertices, colors);
  });

  // Waits until `cloth` has stepped `count` more fixed steps (1/60 s each): a slow frame steps several at once, so frames
  // are not a measure of simulated time.
  const steps = (cloth: GPUCloth, count: number) =>
    new Promise<void>((resolve) => {
      const until = cloth.stats.steps + count;
      const off = engine.onFrame(() => {
        if (cloth.stats.steps >= until) {
          off();
          resolve();
        }
      });
    });
  const at = (p: Float32Array, i: number): V3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];

  const startDrape = await drape.snapshot(),
    startFlag = await flag.snapshot();
  const startHashes = [await drape.hash(), await flag.hash()];
  const restore = async (drapeState: GPUClothSnapshot, flagState: GPUClothSnapshot) => {
    drape.options.paused = flag.options.paused = true;
    drape.restore(drapeState);
    flag.restore(flagState);
    const same = (await drape.hash()) === startHashes[0] && (await flag.hash()) === startHashes[1];
    drape.options.paused = flag.options.paused = false;
    return same;
  };

  button('btnDrop').addEventListener('click', async () => {
    drape.restore(startDrape);
    await steps(drape, 240);
    const p = await drape.readPositions();
    const top = BALL[1] + RADIUS + SPACING / 2; // the ball's top plus the cloth's thickness, half its spacing
    const centre = at(p, CENTRE);
    const finite = p.every(Number.isFinite);
    if (
      expect(finite, 'a particle of the drape is not finite') &&
      expect(Math.abs(centre[1] - top) < 0.01, `the drape's centre rests at ${centre[1].toFixed(3)} m, not on the ball at ${top}`)
    )
      say(`Draped: the centre rests ${((centre[1] - BALL[1] - RADIUS) * 1000).toFixed(1)} mm above the ball.`);
  });
  button('btnWind').addEventListener('click', async () => {
    const on = !Array.isArray(flag.options.wind) || flag.options.wind.some((x) => x !== 0);
    flag.options.wind = on ? [0, 0, 0] : WIND;
    button('btnWind').textContent = `Wind: ${on ? 'off' : 'on'}`;
    if (on) return say('Wind off: the flag falls slack against its pole.');
    await steps(flag, 120);
    const p = await flag.readPositions();
    let tip = 0;
    for (let j = 0; j < FLAG_V; j++) tip += at(p, (FLAG_U - 1) * FLAG_V + j)[0] / FLAG_V;
    if (expect(tip - POLE[0] > 1.0, `the flag's free edge is only ${(tip - POLE[0]).toFixed(2)} m downwind of the pole`))
      say(`Wind on: the free edge streams ${(tip - POLE[0]).toFixed(2)} m downwind.`);
  });
  button('btnPush').addEventListener('click', async () => {
    drape.restore(startDrape);
    await steps(drape, 180);
    const before = await drape.readPositions();
    scripted = true;
    for (let k = 0; k <= 60; k++) {
      pusher.position = [BALL[0] - 0.9 + (1.8 * k) / 60, BALL[1], 0.6];
      await steps(drape, 1);
    }
    pusher.position = away;
    scripted = false;
    const after = await drape.readPositions();
    let moved = 0;
    for (let i = 0; i < drape.count; i++) {
      const a = at(before, i),
        b = at(after, i);
      moved = Math.max(moved, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    if (expect(moved > 0.05 && after.every(Number.isFinite), `the push moved the cloth only ${moved.toFixed(3)} m`))
      say(`Pushed: the cloth moved up to ${(moved * 100).toFixed(0)} cm and stayed whole.`);
  });
  button('btnDebug').addEventListener('click', () => {
    debugOn = !debugOn;
    debug.visible = debugOn;
    button('btnDebug').textContent = `Debug view: ${debugOn ? 'on' : 'off'}`;
    say(`Debug view ${debugOn ? 'on' : 'off'}.`);
  });
  button('btnReset').addEventListener('click', async () => {
    flag.options.wind = WIND;
    button('btnWind').textContent = 'Wind: on';
    if (expect(await restore(startDrape, startFlag), 'a reset did not restore the cloths bit for bit')) say('Reset to the start.');
  });

  engine.start();
  say('Ready: move the pointer over the draped cloth to push it.');
}

ready(start());
