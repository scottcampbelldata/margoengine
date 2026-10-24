// CAD four-view layout: top, front and right-side orthographic views and a perspective view of one shared scene, each
// with its own camera and controls, picking through the view under the pointer. Third-angle layout: top above front,
// side to the right of front, perspective top right.
import { Camera, createStage, type Mesh, type RenderView, type Vec3 } from 'margoengine';
import { CameraProjection } from '@margoengine/cameras';
import { MOUSE, OrbitControls, TOUCH } from '@margoengine/controls';
import { cylinderGeometry, toGeometry, torusGeometry } from '@margoengine/geometry';
import { engineRuntime } from '@margoengine/core/extension';
import { submitPrincipalScene, type PrincipalSceneReadiness } from '@margoengine/post/scene-fade';
import { frameTime, pickOnClick, place, viewBox } from './multi-view.js';

declare global {
  interface Window {
    cadViews?: {
      stage: Awaited<ReturnType<typeof createStage>>;
      views: RenderView[];
      readiness: PrincipalSceneReadiness;
      /** Name of the part under (fx, fy), fractions of view `index`'s rectangle, or null. */
      pickAt(index: number, fx: number, fy: number): Promise<string | null>;
      frameTime(frames?: number): Promise<number>;
    };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  host = document.querySelector<HTMLDivElement>('#views')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
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
try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    camera: { position: [7, 5.5, 8.5], target: [0, 1.2, 0], fov: 40, near: 0.1, far: 200 },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  const engine = stage.engine,
    controls: OrbitControls[] = [];
  dispose = () => {
    for (const c of controls) c.dispose();
    stage.dispose();
  };
  if (life.signal.aborted) {
    dispose();
    life.signal.throwIfAborted();
  }

  // The part: a base plate, two bearing blocks, a shaft with a pulley and a hub, four bolts.
  const steel = { color: '#9aa3ad', metalness: 0.6, roughness: 0.35 },
    parts: Mesh[] = [
      stage.box({ name: 'Base plate', size: [7, 0.5, 4], position: [0, 0.25, 0], color: '#56677d', roughness: 0.6 }),
      stage.box({ name: 'Left bearing block', size: [1, 2, 1.6], position: [-2.4, 1.5, 0], ...steel }),
      stage.box({ name: 'Right bearing block', size: [1, 2, 1.6], position: [2.4, 1.5, 0], ...steel }),
      stage.mesh(toGeometry(cylinderGeometry(0.3, 0.3, 7, 32)), {
        name: 'Shaft',
        position: [0, 2.1, 0],
        rotation: [0, 0, Math.PI / 2],
        color: '#d0d5db',
        metalness: 0.3,
        roughness: 0.3,
      }),
      stage.mesh(toGeometry(torusGeometry(1.1, 0.25, 16, 48)), {
        name: 'Pulley',
        position: [0, 2.1, 0],
        rotation: [0, Math.PI / 2, 0],
        color: '#c4572e',
        roughness: 0.45,
      }),
      stage.mesh(toGeometry(cylinderGeometry(0.55, 0.55, 0.8, 32)), {
        name: 'Hub',
        position: [0, 2.1, 0],
        rotation: [0, 0, Math.PI / 2],
        color: '#e0a03a',
        metalness: 0.4,
        roughness: 0.4,
      }),
    ];
  for (const [x, z] of [
    [-3, -1.5],
    [3, -1.5],
    [-3, 1.5],
    [3, 1.5],
  ])
    parts.push(
      stage.mesh(toGeometry(cylinderGeometry(0.22, 0.22, 0.3, 6)), {
        name: `Bolt ${parts.length - 5}`,
        position: [x, 0.65, z],
        color: '#2f3640',
        metalness: 0.7,
        roughness: 0.3,
      }),
    );

  // Orthographic cameras straight down, from the front (+Z) and from the right (+X); CameraProjection makes them
  // parallel, frames them like the perspective view at the target (so dolly zooms) and keeps the top view exact.
  const ortho = (position: Vec3) => {
    const camera = new Camera({ position, target: [0, 1, 0], fov: 30, near: 0.1, far: 200 });
    new CameraProjection().attach(camera);
    return camera;
  };
  const layout: Array<{ label: string; camera: Camera; viewport: [number, number, number, number]; color: string }> = [
    { label: 'Top', camera: ortho([0, 14, 0]), viewport: [0, 0, 0.5, 0.5], color: '#1b2129' },
    { label: 'Perspective', camera: engine.camera, viewport: [0.5, 0, 0.5, 0.5], color: '#222a35' },
    { label: 'Front', camera: ortho([0, 1, 13]), viewport: [0, 0.5, 0.5, 0.5], color: '#1b2129' },
    { label: 'Right', camera: ortho([13, 1, 0]), viewport: [0.5, 0.5, 0.5, 0.5], color: '#1b2129' },
  ];
  const views: RenderView[] = layout.map(({ label, camera, viewport, color }) => ({
    id: label.toLowerCase(),
    camera,
    viewport,
    clear: { color },
  }));

  let selected: { mesh: Mesh; color: Float32Array } | null = null;
  const select = (mesh: Mesh | null, where: string) => {
    if (selected) selected.mesh.material.set({ color: Array.from(selected.color) });
    selected = mesh ? { mesh, color: mesh.material.data.slice(0, 3) } : null;
    mesh?.material.set({ color: '#4fd1ff' });
    status.textContent = mesh ? `${mesh.name}, picked in the ${where} view` : `Nothing under the pointer in ${where}`;
  };
  layout.forEach(({ label, camera, viewport }, i) => {
    const box = viewBox(host, label),
      orbit = new OrbitControls(camera, box);
    place(box, viewport);
    orbit.zoomToCursor = true;
    // Ortho views pan (left drag, one finger) and zoom only, so they stay square to their axis.
    if (camera !== engine.camera) {
      orbit.enableRotate = false;
      orbit.mouseButtons.LEFT = MOUSE.PAN;
      orbit.touches.ONE = TOUCH.PAN;
    }
    controls.push(orbit);
    pickOnClick(
      engine,
      box,
      () => views[i],
      (mesh) => select(mesh, label.toLowerCase()),
      life.signal,
    );
  });
  stage.onTick((delta) => {
    for (const c of controls) c.update(delta);
  });

  const readiness = await submitPrincipalScene(() => engine.render({ views }), engineRuntime(engine).gpu!.queue, {
    signal: life.signal,
  });
  life.signal.throwIfAborted();
  engine.views = views;
  engine.start();
  window.cadViews = {
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
  status.textContent =
    'Click a part in any view to select it in all four. Drag to orbit (perspective) or pan; scroll to zoom.';
} catch (error) {
  dispose();
  if (!life.signal.aborted) status.textContent = `Unable to start: ${String(error)}`;
}
