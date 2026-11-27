import { loadGLTF } from '@margoengine/gltf/pbr';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { Physics } from '@margoengine/physics';
import { equivalentEllipsoid, LoadSolver } from '@margoengine/physics/loads';
import { SpectralSea, WakeSolver } from '@margoengine/physics/sea';
import { type HullMesh, type Vec3, wettedLoads } from '@margoengine/physics/seakeeping';
import { jonswap } from '@margoengine/physics/waves';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';
import { PostStack } from '@margoengine/post/stack';
import { Sky } from '@margoengine/sky/base';
import { clouds } from '@margoengine/sky/clouds';
import { lighting } from '@margoengine/sky/lighting';
import { night } from '@margoengine/sky/night';
import { preetham } from '@margoengine/sky/preetham';
import { reflection } from '@margoengine/sky/reflection';
import { createStage } from '@margoengine/stage';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaterWake } from '@margoengine/water/wake';
import { demoStatus } from './demo-status.ts';

const rate = 60;
const density = 1000;
const depth = 68;
const gravity = gravityMagnitude(DEFAULT_GRAVITY);
const end = 12 * rate;
const position: Vec3 = [4.58, 1.68, 5.33];
const target: Vec3 = [0, 0.24, 0];
const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;
const time = document.querySelector<HTMLInputElement>('#time')!;
const elapsed = document.querySelector<HTMLOutputElement>('#elapsed')!;
const measure = document.querySelector<HTMLOutputElement>('#measurement')!;
const light = document.querySelector<HTMLSelectElement>('#lighting')!;
const status = demoStatus(canvas, document.querySelector('#status'));
const params = new URLSearchParams(location.search);
const capture = params.has('qa');
const askedLight = params.get('lighting');
const look = askedLight === 'bright' || askedLight === 'night' ? askedLight : 'overcast';
const askedView = params.get('view')?.split(',').map(Number);
const view =
  askedView?.length === 6 && askedView.every(Number.isFinite)
    ? { position: askedView.slice(0, 3) as unknown as Vec3, target: askedView.slice(3) as unknown as Vec3 }
    : { position, target };
const follow = params.get('follow') === '1' || (params.get('follow') !== '0' && view.position === position);
const fov = Number(params.get('fov') ?? 34);
const startTick = Math.max(0, Math.min(end, Math.trunc(Number(params.get('tick'))) || 0));
const life = new AbortController();
const dispose: (() => void)[] = [];
let request = 0;
const finish = () => {
  life.abort();
  cancelAnimationFrame(request);
  for (const release of dispose.splice(0).reverse()) release();
};
window.addEventListener('pagehide', finish, { once: true });

interface RaftBody {
  mesh: HullMesh;
  mass: number;
  min: [number, number, number];
  max: [number, number, number];
}

async function loadDisplacement(signal: AbortSignal): Promise<RaftBody> {
  const response = await fetch(new URL('./assets/sea12/cyprus-raft-displacement.json', import.meta.url), { signal });
  if (!response.ok) throw new Error('Cannot load the raft displacement mesh. Serve the SEA-12 example assets.');
  const { vertices, indices, massKg } = (await response.json()) as Record<string, unknown>;
  if (
    !Array.isArray(vertices) ||
    vertices.length < 12 ||
    vertices.length % 3 !== 0 ||
    !vertices.every(Number.isFinite) ||
    !Array.isArray(indices) ||
    indices.length < 12 ||
    indices.length % 3 !== 0 ||
    !indices.every((index: number) => Number.isInteger(index) && index >= 0 && index * 3 < vertices.length) ||
    typeof massKg !== 'number' ||
    !(Number.isFinite(massKg) && massKg > 0)
  )
    throw new Error(
      'Invalid raft displacement. Export the closed, outward-wound float meshes and their dry mass in SI.',
    );
  const mesh = { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
  const min: RaftBody['min'] = [Infinity, Infinity, Infinity],
    max: RaftBody['max'] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis]!, mesh.vertices[i]!);
    max[axis] = Math.max(max[axis]!, mesh.vertices[i]!);
  }
  if (massKg >= density * equivalentEllipsoid(mesh).volume)
    throw new Error('The raft is too heavy for its sealed float volume. Check the mass and displacement export.');
  return { mesh, mass: massKg, min, max };
}

/** Initial static draft from the closed displacement mesh and Archimedes' principle. */
function floatingHeight({ mesh, mass, min, max }: RaftBody): number {
  const still = { elevation: () => 0, pressure: (_x: number, y: number) => -y };
  let low = -max[1],
    high = -min[1];
  for (let i = 0; i < 24; i++) {
    const midpoint = (low + high) / 2;
    const origin: Vec3 = [0, midpoint, 0];
    const load = wettedLoads(mesh, { position: origin, rotation: [0, 0, 0, 1] }, still, 0, origin);
    if (density * load.force[1] > mass) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function lake(wake: WakeSolver) {
  const frequencies = Float64Array.from({ length: 6 }, (_, i) => 0.21 * 5.5 ** (i / 5));
  const directions = Float64Array.from({ length: 10 }, (_, i) => (2 * Math.PI * i) / 10);
  const waves = {
    frequencies,
    directions,
    energy: new Float64Array(frequencies.length * directions.length),
    depth,
    density,
  };
  jonswap({ height: 0.5, period: 2.65, direction: Math.PI * 0.41 }, waves);
  return new SpectralSea({ waves, seed: 1907, patches: [wake] });
}

// A passing gravity-wave packet. Linear surface potential in phase quadrature sends the packet toward +Z.
function incomingWake(x: number, z: number): readonly [number, number] {
  const k = (2 * Math.PI) / 3.8;
  const omega = Math.sqrt(gravity * k * Math.tanh(k * depth));
  const along = z + 4.4,
    envelope = 0.085 * Math.exp(-0.5 * ((x / 3.2) ** 2 + (along / 2.1) ** 2));
  return [envelope * Math.cos(k * along), (gravity / omega) * envelope * Math.sin(k * along)];
}

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    signal: life.signal,
    camera: { ...view, near: 0.22, far: 1400, fov: Number.isFinite(fov) && fov >= 18 && fov <= 75 ? fov : 34 },
    onError: (error) => status.error(error),
  });
  if (life.signal.aborted) stage.dispose();
  life.signal.throwIfAborted();
  dispose.push(() => stage.dispose());
  const { engine } = stage;
  const model = loadGLTF(engine, new URL('./assets/sea12/cyprus-raft.glb', import.meta.url), {
    signal: life.signal,
  }).then((asset) => {
    if (life.signal.aborted) asset.dispose();
    life.signal.throwIfAborted();
    dispose.push(() => asset.dispose());
    return asset;
  });
  const [asset, bodyAsset, loadSolver] = await Promise.all([
    model,
    loadDisplacement(life.signal),
    LoadSolver.load({ signal: life.signal }),
    Physics.load({ signal: life.signal }),
  ]);
  life.signal.throwIfAborted();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: DEFAULT_GRAVITY });
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / rate, gravity: DEFAULT_GRAVITY });
  dispose.push(() => physics[Symbol.dispose]());
  const wake = new WakeSolver();
  const sea = lake(wake);
  world.add(wake, {
    cells: [64, 64],
    cellSize: 0.34,
    depth,
    density,
    sponge: 6,
    initial: incomingWake,
    waterBelow: true,
  });
  const half = bodyAsset.max.map((n, i) => (n - bodyAsset.min[i]!) / 2) as [number, number, number];
  const raft = physics.addBody(null, {
    position: [0, floatingHeight(bodyAsset) + sea.elevation(0, 0, 0), 0],
    colliders: { shape: 'box', halfExtents: half, mass: bodyAsset.mass },
    canSleep: false,
  });
  world.add(new RigidSolver(), { physics }).add(loadSolver, {
    sea,
    bodies: [{ row: raft.row, shape: { mesh: bodyAsset.mesh }, pressureModel: 'surface', addedInertia: 'ellipsoid' }],
  });
  world.couple(['wake', 'loads', 'rigid'], 'staggered');
  const initial = world.takeSnapshot();
  const sky = Sky.attach(
    engine,
    {
      model: 'preetham',
      hours: look === 'night' ? 23 : look === 'bright' ? 12.8 : 16.3,
      timeScale: 0,
      turbidity: look === 'bright' ? 2.8 : 4.2,
      clouds: { coverage: look === 'bright' ? 0.23 : look === 'night' ? 0.65 : 0.97, depth: 24, height: 780 },
      lighting: {
        intensity: look === 'overcast' ? 2.65 : 1.4,
        ambient: { day: [0.42, 0.48, 0.55], night: [0.034, 0.041, 0.056] },
        moon: look === 'night' ? { intensity: 0.4, color: [0.69, 0.79, 1] } : undefined,
      },
      night: look === 'night' ? { moonDirection: [-0.4, 0.52, 0.2], moonPhase: 0.68, starIntensity: 0.35 } : undefined,
    },
    { preetham, clouds, night, lighting, reflection },
  );
  const stack = PostStack.attach(engine, [new Tonemap({ curve: 'agx', exposure: 0.75 })]);
  const water = Water.attach(engine, {
    sea,
    size: [54, 54],
    segments: 192,
    horizon: true,
    color: [0.011, 0.032, 0.043],
    whitecaps: 0.35,
    foamDistance: 0.07,
    depth: () => stack.depthTexture,
    sceneColor: () => stack.sceneTexture,
    reflection: () => sky.reflectionTexture,
    lights: sky.lights,
  });
  const drawnWake = WaterWake.attach(engine, { surface: water, wake });
  dispose.push(() => {
    drawnWake.dispose();
    water.dispose();
    sky.dispose();
  });

  let frame = 0,
    playhead = startTick,
    previous = 0,
    playing = !capture && !params.has('tick') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const updateButton = () => {
    play.textContent = playing ? 'Pause' : 'Play';
  };
  const drawAt = (next: number, report = false) => {
    if (next < frame) world.restoreSnapshot(initial.bytes);
    world.advance(next);
    frame = next;
    const [x, y, z] = raft.position;
    const quaternion = raft.rotation;
    asset.root.setPosition([x, y, z]).setQuaternion(quaternion);
    if (follow) {
      engine.camera.position = [view.position[0] + x, view.position[1], view.position[2] + z];
      engine.camera.target = [view.target[0] + x, view.target[1], view.target[2] + z];
    }
    const t = frame / rate;
    water.setTime(t);
    time.value = String(frame);
    elapsed.value = t.toFixed(2) + ' s';
    const height = sea.elevation(x, z, t);
    const [qx, qy, qz, qw] = quaternion;
    const heel = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy)) * (180 / Math.PI);
    measure.value = 'Raft origin: ' + (y - height).toFixed(3) + ' m from the surface · Heel: ' + heel.toFixed(1) + '°';
    if (report || capture) {
      Object.assign(canvas.dataset, {
        tick: String(frame),
        hash: world.hash(),
        body: JSON.stringify({ position: [x, y, z], rotation: quaternion }),
        surface: String(height),
        wake: String(wake.sample(x, z).height),
        modelParts: String(asset.primitives.length),
      });
    }
  };
  const seek = (next: number) => {
    playing = false;
    playhead = next;
    drawAt(next, true);
    updateButton();
  };
  play.addEventListener(
    'click',
    () => {
      if (!playing && frame === end) {
        drawAt(0, true);
        playhead = 0;
      }
      playing = !playing;
      updateButton();
    },
    { signal: life.signal },
  );
  reset.addEventListener('click', () => seek(0), { signal: life.signal });
  time.addEventListener('input', () => seek(Number(time.value)), { signal: life.signal });
  light.addEventListener(
    'change',
    () => {
      const url = new URL(location.href);
      url.searchParams.set('lighting', light.value);
      url.searchParams.set('tick', String(frame));
      location.assign(url);
    },
    { signal: life.signal },
  );
  light.value = look;
  const animate = (now: number) => {
    if (life.signal.aborted || status.failed) return;
    try {
      if (playing && previous !== 0) {
        playhead = Math.min(end, playhead + Math.min(0.083, (now - previous) / 1000) * rate);
        const next = Math.floor(playhead);
        if (next !== frame) drawAt(next);
        if (next === end) {
          playing = false;
          updateButton();
        }
      }
      previous = now;
      engine.render({ delta: 0 });
      request = requestAnimationFrame(animate);
    } catch (error) {
      status.error(error);
    }
  };
  drawAt(startTick, true);
  updateButton();
  engine.render({ delta: 0 });
  request = requestAnimationFrame(animate);
  play.disabled = reset.disabled = time.disabled = light.disabled = false;
  status.ready('');
} catch (error) {
  if (!life.signal.aborted) status.error(error);
  finish();
}
