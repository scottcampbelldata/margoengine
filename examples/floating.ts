// Floating bodies (SEA-12, parity bar P12): two crates, a capsule, an octagonal buoy (a convex hull) and a glTF boom box
// float on a Water swell with pointer ripples on top, each from its own colliders through one `floating()` call. The
// ripples are stepped on the CPU too (`cpu: true`), so `seaSurface(ripples)` is the surface the camera sees and the
// bodies ride the ripples a click makes this frame; each body leaves its own wake (`trackBody`). The debug view draws
// `LoadSolver.debugRender()`: the edges below the water, the waterline, the centre of buoyancy and the load arrows.
import { cylinderGeometry, capsuleGeometry } from '@margoengine/geometry';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { Material, createMesh } from '@margoengine/materials';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { Physics, type PhysicsBody } from '@margoengine/physics';
import type { PhysicsDebugView } from '@margoengine/physics/debug-view';
import { floating, LoadSolver } from '@margoengine/physics/loads';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';
import { Sky } from '@margoengine/sky/base';
import { bruneton } from '@margoengine/sky/bruneton';
import { lighting } from '@margoengine/sky/lighting';
import { reflection } from '@margoengine/sky/reflection';
import { createStage } from '@margoengine/stage';
import { Water } from '@margoengine/water';
import { Ripples } from '@margoengine/water/ripples';
import { seaSurface } from '@margoengine/water/sea-state';
import { demoStatus } from './demo-status.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const status = demoStatus(canvas, document.querySelector('#status'));
const play = document.querySelector<HTMLButtonElement>('#play')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;
const debug = document.querySelector<HTMLInputElement>('#debug')!;
const measurement = document.querySelector<HTMLOutputElement>('#measurement')!;
const rate = 60;
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

/** The world ray under a pointer, from the camera's view-projection matrix (reverse Z: near 1, far 0). */
function pointerRay(matrix: Float32Array, event: PointerEvent) {
  const rect = canvas.getBoundingClientRect(),
    nx = ((event.clientX - rect.left) / rect.width) * 2 - 1,
    ny = 1 - ((event.clientY - rect.top) / rect.height) * 2,
    inverse = new Float32Array(16);
  if (!(rect.width > 0 && rect.height > 0) || !invertMatrixStable(matrix, inverse)) return null;
  const at = (z: number): [number, number, number] => {
    const w = inverse[3]! * nx + inverse[7]! * ny + inverse[11]! * z + inverse[15]!;
    return [0, 1, 2].map(
      (k) => (inverse[k]! * nx + inverse[4 + k]! * ny + inverse[8 + k]! * z + inverse[12 + k]!) / w,
    ) as [number, number, number];
  };
  const near = at(1),
    far = at(0.01),
    d = far.map((v, k) => v - near[k]!),
    length = Math.hypot(d[0]!, d[1]!, d[2]!);
  return length > 0 ? { origin: near, direction: d.map((v) => v / length) as [number, number, number] } : null;
}

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    background: '#9fb6c6',
    camera: { position: [5.2, 2.6, 6.4], target: [0, -0.1, 0.2], near: 0.1, far: 300, fov: 45 },
    onError: (error) => status.error(error),
  });
  release = () => stage.dispose();
  life.signal.throwIfAborted();
  const { engine } = stage;
  const sky = Sky.attach(
    engine,
    {
      model: 'bruneton',
      hours: 15.8,
      timeScale: 0,
      turbidity: 2.4,
      exposure: -0.1,
      lighting: { intensity: 3, color: [1, 0.96, 0.9], ambient: { day: [0.2, 0.25, 0.3], night: [0.02, 0.04, 0.08] } },
    },
    { bruneton, lighting, reflection },
  );

  const water = Water.attach(engine, {
    size: [28, 28],
    segments: 192,
    waves: [
      { direction: [1, 0.35], amplitude: 0.16, wavelength: 9, steepness: 0.35 },
      { direction: [-0.4, 1], amplitude: 0.07, wavelength: 4.5, steepness: 0.3 },
    ],
    color: [0.02, 0.16, 0.22],
    reflection: () => sky.reflectionTexture,
    lights: sky.lights,
  });
  const ripples = Ripples.attach(engine, {
    surface: water,
    size: 24,
    resolution: 160,
    speed: 3,
    damping: 0.35,
    followCamera: false,
    cpu: true,
  });
  const sea = seaSurface(ripples, { density: 1025 });

  const [asset] = await Promise.all([
    loadGLTF(engine, new URL('./assets/khronos/BoomBox/BoomBox.glb', import.meta.url), { signal: life.signal }),
    Physics.load({ signal: life.signal }),
  ]);
  life.signal.throwIfAborted();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 } });
  // The world steps the Physics (paused for its own clock); attached to the engine, it writes each body's mesh.
  const physics = new Physics(engine, { arena: world.arena, fixedTimestep: 1 / rate, paused: true });
  let view: PhysicsDebugView | undefined;
  let request = 0;
  release = () => {
    cancelAnimationFrame(request);
    view?.dispose();
    physics[Symbol.dispose]();
    asset.dispose();
    ripples.dispose();
    water.dispose();
    sky.dispose();
    stage.dispose();
  };

  const wood = new Material({ color: '#9a6a3c', roughness: 0.7 }),
    buoyPaint = new Material({ color: '#e7b72d', roughness: 0.4 });
  const bodies: { name: string; body: PhysicsBody }[] = [];
  const add = (name: string, body: PhysicsBody) => {
    bodies.push({ name, body });
    ripples.trackBody(body, { radius: 0.7, strength: 0.05 });
  };
  add(
    'crate',
    physics.addBody(stage.box({ size: [1.2, 0.8, 0.9], color: '#8a5a33', roughness: 0.75 }), {
      position: [-2.2, 0.35, 0.6],
      rotation: [0.15, 0.2, 0.05, 0.966],
      colliders: { shape: 'box', halfExtents: [0.6, 0.4, 0.45], density: 420 },
    }),
  );
  add(
    'long crate',
    physics.addBody(stage.box({ size: [2.2, 0.5, 0.7], color: '#6e4a2c', roughness: 0.8 }), {
      position: [0.3, 0.3, -1.8],
      rotation: [0, 0.38, 0.12, 0.917],
      colliders: { shape: 'box', halfExtents: [1.1, 0.25, 0.35], density: 520 },
    }),
  );
  add(
    'capsule',
    physics.addBody(createMesh(engine, capsuleGeometry(0.28, 1.6, 6, 16), wood).root, {
      position: [1.5, 0.3, 1.1],
      rotation: [0, 0, 0.6, 0.8],
      colliders: { shape: 'capsule', radius: 0.28, halfHeight: 0.8, density: 600 },
    }),
  );
  // An octagonal buoy: a frustum drawn with 8 sides and its collider the hull of the same corners.
  const corners: number[] = [];
  for (const [radius, y] of [
    [0.55, -0.45],
    [0.4, 0.45],
  ] as const)
    for (let k = 0; k < 8; k++)
      corners.push(radius * Math.sin((k * Math.PI) / 4), y, radius * Math.cos((k * Math.PI) / 4));
  add(
    'hull buoy',
    physics.addBody(createMesh(engine, cylinderGeometry(0.4, 0.55, 0.9, 8), buoyPaint).root, {
      position: [-0.4, 0.35, 2.4],
      colliders: { shape: 'convexHull', points: corners, density: 380 },
    }),
  );
  // The glTF boom box (2 cm across in the file) at 40 times its size, floating as the hull of its own vertices.
  asset.root.setScale([40, 40, 40]);
  add(
    'glTF boom box',
    physics.addBody(asset.root, {
      position: [1.7, 0.4, -0.3],
      rotation: [0.1, 0.3, 0, 0.949],
      colliders: { shape: 'convexHull', density: 450 },
    }),
  );

  const loads = new LoadSolver();
  world
    .add(new RigidSolver(), { physics })
    .add(loads, {
      sea,
      bodies: floating(
        physics,
        bodies.map(({ body }) => body),
      ),
    })
    .couple(['loads', 'rigid'], 'staggered');
  // `floating` gives one entry a collider (a compound, one a part): these bodies have one each, in this order.
  world.advance(0);
  const start = world.takeSnapshot(),
    rippleStart = ripples.snapshot();
  let frame = 0;
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const updateButton = () => (play.textContent = playing ? 'Pause' : 'Play');
  const report = () => {
    const wet = bodies.map((_, i) => loads.bodyLoad(i).wet);
    measurement.value = bodies.map(({ name }, i) => `${name} ${(100 * wet[i]!).toFixed(0)} % under`).join(' · ');
    measurement.dataset.wet = JSON.stringify(wet);
    measurement.dataset.frame = String(frame);
    measurement.dataset.heights = JSON.stringify(bodies.map(({ body }) => body.position[1]));
  };
  const step = () => {
    frame++;
    world.advance(frame);
    engine.render({ delta: 1 / rate });
    report();
  };

  let ripplesMade = 0;
  let pushing = false;
  const push = (event: PointerEvent, strength: number) => {
    const ray = pointerRay(engine.camera.matrix, event);
    if (ray && ripples.disturbRay(ray.origin, ray.direction, 1.2, -strength)) {
      ripplesMade++;
      canvas.dataset.ripples = String(ripplesMade);
    }
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      pushing = true;
      canvas.setPointerCapture(event.pointerId);
      push(event, 0.25);
    },
    { signal: life.signal },
  );
  canvas.addEventListener('pointermove', (event) => pushing && push(event, 0.08), { signal: life.signal });
  canvas.addEventListener('pointerup', () => (pushing = false), { signal: life.signal });
  canvas.addEventListener('pointercancel', () => (pushing = false), { signal: life.signal });

  play.addEventListener(
    'click',
    () => {
      playing = !playing;
      updateButton();
    },
    { signal: life.signal },
  );
  reset.addEventListener(
    'click',
    () => {
      world.restoreSnapshot(start.bytes);
      ripples.restore(rippleStart);
      water.setTime(0);
      frame = 0;
      world.advance(0);
      engine.render({ delta: 0 });
      report();
    },
    { signal: life.signal },
  );
  debug.addEventListener(
    'change',
    async () => {
      if (view) {
        view.enabled = debug.checked;
        return;
      }
      if (!debug.checked) return;
      debug.disabled = true;
      try {
        const { PhysicsDebugView } = await import('@margoengine/physics/debug-view');
        life.signal.throwIfAborted();
        view = await PhysicsDebugView.attach(engine, physics, { world: false, width: 2, onTop: true });
        view.add(() => loads.debugRender());
      } catch (error) {
        if (!life.signal.aborted) status.error(error);
      } finally {
        if (!life.signal.aborted) debug.disabled = false;
      }
    },
    { signal: life.signal },
  );

  const loop = () => {
    if (life.signal.aborted || status.failed) return;
    try {
      if (playing) step();
      else engine.render({ delta: 0 });
      request = requestAnimationFrame(loop);
    } catch (error) {
      status.error(error);
    }
  };
  engine.render({ delta: 0 });
  report();
  updateButton();
  play.disabled = reset.disabled = debug.disabled = false;
  // A test drives the scene a step at a time: `window.floatingDemo.step()`.
  (window as unknown as { floatingDemo: object }).floatingDemo = { step, loads, bodies };
  request = requestAnimationFrame(loop);
  status.ready(document.documentElement.dataset.webgpuCompat !== undefined ? 'WebGL2 compatibility mode' : 'WebGPU');
} catch (error) {
  if (!life.signal.aborted) status.error(error);
}
