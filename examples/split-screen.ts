// Split-screen two-player: one arena, two chase cameras, two views side by side (stacked on a tall screen). Each
// player's marker sits on a render layer only that player's view draws, so neither sees the other's.
import { Camera, createStage, type Mesh, type RenderView, type Vec3 } from 'margoengine';
import { layerMask, setRenderLayers } from '@margoengine/cameras/layers';
import { capsuleGeometry, coneGeometry, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { engineRuntime } from '@margoengine/core/extension';
import { submitPrincipalScene, type PrincipalSceneReadiness } from '@margoengine/post/scene-fade';
import { frameTime, pickOnClick, place, still, viewBox } from './multi-view.js';

declare global {
  interface Window {
    splitScreen?: {
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
    camera: { position: [0, 30, 30], target: [0, 0, 0] },
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

  // Arena: a floor, low walls and a ring of pillars, all on layer 0 (the default), which both views draw.
  stage.box({ name: 'Floor', size: [40, 0.2, 40], position: [0, -0.1, 0], color: '#4b5d4a', roughness: 0.9 });
  for (const [x, z, w, d] of [
    [0, -20, 40, 1],
    [0, 20, 40, 1],
    [-20, 0, 1, 40],
    [20, 0, 1, 40],
  ])
    stage.box({ name: 'Wall', size: [w, 1.2, d], position: [x, 0.6, z], color: '#8a7a64', roughness: 0.8 });
  const pillar = toGeometry(cylinderGeometry(0.8, 0.8, 4, 20));
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * Math.PI * 2; // off the x axis, so the players start in sight of each other
    stage.mesh(pillar, {
      name: `Pillar ${i + 1}`,
      position: [Math.cos(a) * 6, 2, Math.sin(a) * 6],
      color: i % 2 ? '#c9b48a' : '#a99470',
      roughness: 0.7,
    });
  }

  const crates = ['#b86b3a', '#3a8fb8', '#8fb83a'];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    stage.box({
      name: `Crate ${i + 1}`,
      size: [1.4, 1.4, 1.4],
      position: [Math.cos(a) * 16, 0.7, Math.sin(a) * 16],
      rotation: [0, a, 0],
      color: crates[i % 3],
      roughness: 0.8,
    });
  }

  // Players: a body, a nose that shows the heading, and a marker on the player's own layer (1 or 2).
  const body = toGeometry(capsuleGeometry(0.6, 1, 6, 16)),
    marker = toGeometry(coneGeometry(0.45, 0.8, 16));
  const players = [
    {
      name: 'Player 1',
      color: '#e0503c',
      start: [-14, 0, 0] as Vec3,
      heading: Math.PI / 2,
      layer: 1,
      ring: Math.PI,
      lap: 1,
    },
    {
      name: 'Player 2',
      color: '#3c8ce0',
      start: [14, 0, 0] as Vec3,
      heading: -Math.PI / 2,
      layer: 2,
      ring: 0,
      lap: -1,
    },
  ].map((p) => {
    const root = stage.mesh(body, { name: p.name, position: [p.start[0], 1.1, p.start[2]], color: p.color });
    stage.box({
      name: `${p.name} nose`,
      parent: root,
      size: [0.4, 0.3, 0.6],
      position: [0, 0.4, 0.6],
      color: '#f2f2f2',
    });
    const tag = stage.mesh(marker, {
      name: `${p.name} marker`,
      parent: root,
      position: [0, 1.9, 0],
      rotation: [Math.PI, 0, 0],
      color: '#ffd84a',
      roughness: 0.3,
    });
    setRenderLayers(tag, layerMask(p.layer));
    return {
      ...p,
      root,
      x: p.start[0],
      z: p.start[2],
      camera: new Camera({ position: [0, 4, 8], target: [0, 1, 0], fov: 60, near: 0.1, far: 200 }),
    };
  });

  const views: RenderView[] = players.map((p, i) => ({
    id: `player-${i + 1}`,
    camera: p.camera,
    viewport: [0, 0, 1, 1],
    clear: { color: i ? '#9cb8d8' : '#d8b89c' },
    layers: layerMask(0, p.layer),
  }));
  const boxes = players.map((p, i) => {
    const box = viewBox(host, p.name);
    pickOnClick(
      engine,
      box,
      () => views[i],
      (mesh) => (status.textContent = `${p.name} clicked ${mesh?.name ?? 'the sky'}`),
      life.signal,
    );
    return box;
  });
  // Side by side on a wide screen, stacked on a tall one.
  const layout = () => {
    const wide = canvas.clientWidth >= canvas.clientHeight;
    views[0].viewport = wide ? [0, 0, 0.5, 1] : [0, 0, 1, 0.5];
    views[1].viewport = wide ? [0.5, 0, 0.5, 1] : [0, 0.5, 1, 0.5];
    views.forEach((v, i) => place(boxes[i], v.viewport));
  };
  const resize = new ResizeObserver(layout);
  resize.observe(canvas);
  layout();
  dispose = () => {
    resize.disconnect();
    stage.dispose();
  };

  // Input: WASD steers player 1, the arrow keys player 2; an idle player drives round the pillars on its own, the two
  // in opposite directions, so they pass each other twice a lap.
  const keys = new Set<string>(),
    bindings = [
      { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
      { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' },
    ];
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.target instanceof HTMLInputElement) return;
      keys.add(e.code);
      if (e.code.startsWith('Arrow')) e.preventDefault();
    },
    { signal: life.signal },
  );
  window.addEventListener('keyup', (e) => keys.delete(e.code), { signal: life.signal });
  window.addEventListener('blur', () => keys.clear(), { signal: life.signal });

  const follow = (p: (typeof players)[number]) => {
    const fx = Math.sin(p.heading),
      fz = Math.cos(p.heading);
    p.root.setPosition([p.x, 1.1, p.z]).setRotation([0, p.heading, 0]);
    p.camera.position = [p.x - fx * 7, 4.5, p.z - fz * 7];
    p.camera.target = [p.x + fx * 2, 1.2, p.z + fz * 2];
  };
  let time = 0;
  const step = (delta: number) => {
    time += delta;
    players.forEach((p, i) => {
      const b = bindings[i],
        manual = [b.up, b.down, b.left, b.right].some((k) => keys.has(k));
      // Autopilot: head for a point a little ahead on a circle of radius 14.
      const a = p.ring + p.lap * (0.4 * time + 0.5),
        want = Math.atan2(Math.cos(a) * 14 - p.x, Math.sin(a) * 14 - p.z),
        error = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
      const turn = manual ? +keys.has(b.left) - +keys.has(b.right) : Math.max(-1, Math.min(1, error * 2)),
        drive = manual ? +keys.has(b.up) - +keys.has(b.down) : 0.75;
      p.heading += turn * 2.2 * delta;
      p.x = Math.max(-18.5, Math.min(18.5, p.x + Math.sin(p.heading) * drive * 8 * delta));
      p.z = Math.max(-18.5, Math.min(18.5, p.z + Math.cos(p.heading) * drive * 8 * delta));
      follow(p);
    });
  };
  players.forEach(follow);
  stage.onTick((delta) => {
    if (!still || keys.size) step(Math.min(delta, 0.1));
  });

  const readiness = await submitPrincipalScene(() => engine.render({ views }), engineRuntime(engine).gpu!.queue, {
    signal: life.signal,
  });
  life.signal.throwIfAborted();
  engine.views = views;
  engine.start();
  window.splitScreen = {
    stage,
    views,
    readiness,
    async pickAt(index, fx, fy) {
      const [x, y, w, h] = views[index].viewport;
      const mesh: Mesh | null = await engine.pick(
        (x + fx * w) * canvas.clientWidth,
        (y + fy * h) * canvas.clientHeight,
      );
      return mesh?.name ?? null;
    },
    frameTime: (frames) => frameTime(engine, () => views, frames),
  };
  canvas.dataset.ready = 'true';
  status.textContent = still
    ? 'Reduced motion: players hold still until you steer them.'
    : 'Players drive on their own until you steer them.';
} catch (error) {
  dispose();
  if (!life.signal.aborted) status.textContent = `Unable to start: ${String(error)}`;
}
