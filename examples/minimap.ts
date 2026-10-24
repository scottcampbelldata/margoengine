// Minimap: a chase view of a car driving round a small town, and over its top-right corner a small square
// orthographic view looking straight down (@margoengine/cameras). A bright arrow over the car and the route are on
// layer 1, which only the minimap draws. Clicking either view picks through it.
import { Camera, createStage, type RenderView, type Vec3 } from 'margoengine';
import { CameraProjection } from '@margoengine/cameras';
import { layerMask, setRenderLayers } from '@margoengine/cameras/layers';
import { coneGeometry, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { engineRuntime } from '@margoengine/core/extension';
import { submitPrincipalScene, type PrincipalSceneReadiness } from '@margoengine/post/scene-fade';
import { frameTime, pickOnClick, place, still, viewBox } from './multi-view.js';

declare global {
  interface Window {
    minimap?: {
      stage: Awaited<ReturnType<typeof createStage>>;
      views: RenderView[];
      readiness: PrincipalSceneReadiness;
      /** Name of the mesh under (fx, fy), fractions of view `index`'s rectangle, or null. */
      pickAt(index: number, fx: number, fy: number): Promise<string | null>;
      frameTime(frames?: number): Promise<number>;
    };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  host = document.querySelector<HTMLDivElement>('#views')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!,
  headingUp = document.querySelector<HTMLInputElement>('#heading-up')!;
const life = new AbortController();
let dispose = () => {};
window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    dispose();
  },
  { once: true },
);

// The route: a rounded rectangle, sampled into points with their distance along it.
const HALF = [26, 18],
  CORNER = 7,
  route: Array<{ x: number; z: number; s: number }> = [];
{
  const [a, b] = HALF,
    centres = [
      [a - CORNER, b - CORNER],
      [-(a - CORNER), b - CORNER],
      [-(a - CORNER), -(b - CORNER)],
      [a - CORNER, -(b - CORNER)],
    ];
  centres.forEach(([cx, cz], k) => {
    for (let i = 0; i <= 12; i++) {
      const t = ((k + i / 12) * Math.PI) / 2;
      route.push({ x: cx + Math.cos(t) * CORNER, z: cz + Math.sin(t) * CORNER, s: 0 });
    }
  });
  route.push({ ...route[0] });
  for (let i = 1; i < route.length; i++)
    route[i].s = route[i - 1].s + Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
}
const length = route[route.length - 1].s;
/** Position and heading (radians, forward = [sin, cos]) at distance `s` along the route. */
function along(s: number): { x: number; z: number; heading: number } {
  s = ((s % length) + length) % length;
  let i = 1;
  while (route[i].s < s) i++;
  const p = route[i - 1],
    q = route[i],
    t = (s - p.s) / (q.s - p.s);
  return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, heading: Math.atan2(q.x - p.x, q.z - p.z) };
}

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    camera: { position: [0, 4, 10], target: [0, 1, 0], fov: 55, near: 0.1, far: 300 },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  if (life.signal.aborted) {
    dispose();
    life.signal.throwIfAborted();
  }
  const engine = stage.engine;

  // Town: ground, the road, and blocks of buildings inside and around the loop (a fixed pseudo-random layout).
  stage.box({ name: 'Ground', size: [120, 0.2, 100], position: [0, -0.1, 0], color: '#56704f', roughness: 0.95 });
  const [a, b] = HALF;
  for (const [x, z, w, d] of [
    [0, b, 2 * (a - CORNER), 5],
    [0, -b, 2 * (a - CORNER), 5],
    [a, 0, 5, 2 * (b - CORNER)],
    [-a, 0, 5, 2 * (b - CORNER)],
  ])
    stage.box({ name: 'Road', size: [w, 0.04, d], position: [x, 0.02, z], color: '#33363b', roughness: 0.9 });
  // Square patches under the rounded corners.
  const patch = CORNER + 2.5;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      stage.box({
        name: 'Road',
        size: [patch, 0.04, patch],
        position: [sx * (a + 2.5 - patch / 2), 0.02, sz * (b + 2.5 - patch / 2)],
        color: '#33363b',
        roughness: 0.9,
      });
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const palette = ['#c9b79c', '#a7b6c6', '#d6c9b0', '#b39a86', '#9fa9a0'];
  let count = 0;
  for (let gx = -6; gx <= 6; gx++)
    for (let gz = -5; gz <= 5; gz++) {
      const x = gx * 8,
        z = gz * 8,
        // Distance to the route's rectangle outline: keep the road and its verges clear.
        edge = Math.min(Math.abs(Math.abs(x) - a), Math.abs(Math.abs(z) - b)),
        onLoop = Math.abs(x) <= a + 1 && Math.abs(z) <= b + 1;
      if ((onLoop && edge < 7) || (!onLoop && Math.max(Math.abs(x) - a, Math.abs(z) - b) < 7)) continue;
      const height = 2 + random() * (onLoop ? 6 : 12);
      stage.box({
        name: `Building ${++count}`,
        size: [5 + random() * 1.5, height, 5 + random() * 1.5],
        position: [x, height / 2, z],
        color: palette[Math.floor(random() * palette.length)],
        roughness: 0.85,
      });
    }
  const trunk = toGeometry(cylinderGeometry(0.2, 0.25, 1.2, 8)),
    crown = toGeometry(coneGeometry(1.1, 2.6, 12));
  for (let i = 0; i < 14; i++) {
    const p = along((i / 14) * length + 4),
      side = i % 2 ? 4 : -4,
      x = p.x + Math.cos(p.heading) * side,
      z = p.z - Math.sin(p.heading) * side,
      tree = stage.mesh(trunk, { name: 'Tree', position: [x, 0.6, z], color: '#6b4a2f' });
    stage.mesh(crown, { name: 'Tree', parent: tree, position: [0, 1.9, 0], color: '#2f6b3a', roughness: 0.9 });
  }

  // The car, and on layer 1 (minimap only) an arrow over it and dots along the route.
  const car = stage.box({
    name: 'Car',
    size: [1.8, 0.7, 3.6],
    position: [0, 0.75, 0],
    color: '#e04a3c',
    metalness: 0.3,
  });
  stage.box({ name: 'Car', parent: car, size: [1.5, 0.6, 1.8], position: [0, 0.6, -0.2], color: '#2b3440' });
  const wheel = toGeometry(cylinderGeometry(0.42, 0.42, 0.3, 16));
  for (const [x, z] of [
    [-0.95, 1.2],
    [0.95, 1.2],
    [-0.95, -1.2],
    [0.95, -1.2],
  ])
    stage.mesh(wheel, {
      name: 'Car',
      parent: car,
      position: [x, -0.3, z],
      rotation: [0, 0, Math.PI / 2],
      color: '#16181c',
    });
  const minimapOnly = layerMask(1),
    arrow = stage.mesh(toGeometry(coneGeometry(2.4, 5, 3)), {
      name: 'Car marker',
      parent: car,
      position: [0, 6, 0.5],
      rotation: [Math.PI / 2, 0, 0],
      color: '#ffe04a',
      roughness: 0.4,
    });
  setRenderLayers(arrow, minimapOnly);
  const dot = toGeometry(cylinderGeometry(0.7, 0.7, 0.1, 12));
  for (let s = 0; s < length; s += 6) {
    const p = along(s);
    setRenderLayers(
      stage.mesh(dot, { name: 'Route', position: [p.x, 0.1, p.z], color: '#4fd1ff', roughness: 0.5 }),
      minimapOnly,
    );
  }

  // Cameras: the engine camera chases the car; the minimap camera looks straight down at a fixed 44-unit height.
  const mapCamera = new Camera({ position: [0, 60, 0], target: [0, 0, 0], near: 0.1, far: 200 }),
    projection = new CameraProjection({ height: 44 });
  projection.attach(mapCamera);
  const views: RenderView[] = [
    { id: 'main', camera: engine.camera, viewport: [0, 0, 1, 1], clear: { color: '#a9c6e0' }, layers: layerMask(0) },
    { id: 'minimap', camera: mapCamera, viewport: [0.7, 0.02, 0.28, 0.4], clear: { color: '#1d2b22' } },
  ];
  const mainBox = viewBox(host, 'Chase camera'),
    mapBox = viewBox(host, 'Map');
  mainBox.style.border = '0';
  mapBox.classList.add('minimap');
  pickOnClick(
    engine,
    mainBox,
    () => views[0],
    (m) => (status.textContent = `Chase view: ${m?.name ?? 'sky'}`),
    life.signal,
  );
  pickOnClick(
    engine,
    mapBox,
    () => views[1],
    (m) => (status.textContent = `Map: ${m?.name ?? 'nothing'}`),
    life.signal,
  );
  // A square minimap in the top-right corner, 30% of the canvas's shorter side, 12 CSS pixels from the edges.
  const layout = () => {
    const w = canvas.clientWidth || 1,
      h = canvas.clientHeight || 1,
      size = Math.round(Math.min(w, h) * 0.34),
      margin = 12;
    views[1].viewport = [(w - size - margin) / w, margin / h, size / w, size / h];
    place(mainBox, views[0].viewport);
    place(mapBox, views[1].viewport);
  };
  const resize = new ResizeObserver(layout);
  resize.observe(canvas);
  layout();
  dispose = () => {
    resize.disconnect();
    stage.dispose();
  };

  let distance = 0;
  const update = () => {
    const p = along(distance),
      fx = Math.sin(p.heading),
      fz = Math.cos(p.heading);
    car.setPosition([p.x, 0.75, p.z]).setRotation([0, p.heading, 0]);
    engine.camera.position = [p.x - fx * 9, 4.2, p.z - fz * 9];
    engine.camera.target = [p.x + fx * 4, 1.2, p.z + fz * 4];
    const centre: Vec3 = [p.x, 0, p.z];
    mapCamera.target = centre;
    mapCamera.position = [p.x, 60, p.z];
    // North up, or the car's heading up: the screen-up of an exactly vertical view.
    projection.up = headingUp.checked ? [fx, 0, fz] : [0, 0, -1];
  };
  update();
  headingUp.addEventListener('change', update, { signal: life.signal });
  stage.onTick((delta) => {
    if (!still) distance += Math.min(delta, 0.1) * 9;
    update();
  });

  const readiness = await submitPrincipalScene(() => engine.render({ views }), engineRuntime(engine).gpu!.queue, {
    signal: life.signal,
  });
  life.signal.throwIfAborted();
  engine.views = views;
  engine.start();
  window.minimap = {
    stage,
    views,
    readiness,
    async pickAt(index, fx, fy) {
      const [x, y, w, h] = views[index].viewport;
      return (await engine.pick((x + fx * w) * canvas.clientWidth, (y + fy * h) * canvas.clientHeight))?.name ?? null;
    },
    frameTime: (frames) => frameTime(engine, () => views, frames),
  };
  canvas.dataset.ready = 'true';
  status.textContent = 'Click a building in either view to name it.';
} catch (error) {
  dispose();
  if (!life.signal.aborted) status.textContent = `Unable to start: ${String(error)}`;
}
