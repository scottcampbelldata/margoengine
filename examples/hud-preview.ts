// HUD and item preview: the default scene is a ruin at dusk (cascaded shadows, a low warm sun); a second scene, `hud`,
// holds a health bar, a stamina bar, a crosshair and a hotbar, drawn over it by a full-canvas orthographic view; a
// third, `item`, holds the inventory items and is drawn by a small view in the top-right corner with its own camera
// and lights. Each scene has its own lighting and background. Clicking a view picks through it.
import { Camera, createStage, type Mesh, type RenderView, type Scene } from 'margoengine';
import { addShadows } from 'margoengine/stage/shadows';
import { CameraProjection } from '@margoengine/cameras';
import { layerMask, setRenderLayers } from '@margoengine/cameras/layers';
import {
  coneGeometry,
  cylinderGeometry,
  icosahedronGeometry,
  octahedronGeometry,
  torusGeometry,
  torusKnotGeometry,
  toGeometry,
} from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { engineRuntime } from '@margoengine/core/extension';
import { submitPrincipalScene, type PrincipalSceneReadiness } from '@margoengine/post/scene-fade';
import { frameTime, pickOnClick, place, still, viewBox } from './multi-view.js';
import { demoStatus } from './demo-status.ts';

declare global {
  interface Window {
    hudPreview?: {
      stage: Awaited<ReturnType<typeof createStage>>;
      views: RenderView[];
      readiness: PrincipalSceneReadiness;
      /** Name of the mesh under (fx, fy), fractions of view `index`'s rectangle, or null. */
      pickAt(index: number, fx: number, fy: number): Promise<string | null>;
      select(slot: number): void;
      frameTime(frames?: number): Promise<number>;
    };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  host = document.querySelector<HTMLDivElement>('#views')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const page = demoStatus(canvas, status);
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

const ITEMS = ['Sapphire ring', 'Potion of vigour', 'Iron key'];

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    background: '#e3c19c',
    camera: { position: [0, 5.6, 15.5], target: [0, 1.7, 0], fov: 50, near: 0.1, far: 200 },
    onError: (error) => {
      if (!life.signal.aborted) page.error(error);
    },
  });
  dispose = () => stage.dispose();
  if (life.signal.aborted) {
    dispose();
    life.signal.throwIfAborted();
  }
  const engine = stage.engine,
    hud: Scene = engine.createScene('hud'),
    item: Scene = engine.createScene('item');

  // Scene 1, the ruin: a low warm sun, a stone floor, a plinth with a knot of gold, a ring of columns and boulders.
  engineRuntime(engine).lighting.direction.set([-5, 4, 3, 3.4]);
  engineRuntime(engine).lighting.radiance.set([1, 0.82, 0.62, 0.34]);
  engineRuntime(engine).lighting.ambient.set([0.75, 0.82, 1]);
  stage.box({ name: 'Ground', size: [60, 0.4, 60], position: [0, -0.2, 0], color: '#8c7a62', roughness: 0.95 });
  stage.mesh(toGeometry(cylinderGeometry(3.4, 3.6, 0.3, 48)), {
    name: 'Floor',
    position: [0, 0.15, 0],
    color: '#b3a58f',
    roughness: 0.85,
  });
  stage.mesh(toGeometry(cylinderGeometry(1.1, 1.3, 1.1, 32)), {
    name: 'Plinth',
    position: [0, 0.85, 0],
    color: '#c9bca6',
    roughness: 0.7,
  });
  const relic = stage.mesh(toGeometry(torusKnotGeometry(0.8, 0.22, 160, 24, 2, 3)), {
    name: 'Relic',
    position: [0, 2.6, 0],
    color: '#e0b04a',
    metalness: 1,
    roughness: 0.22,
  });
  const column = toGeometry(cylinderGeometry(0.42, 0.5, 4.2, 24)),
    capital = toGeometry(roundedBoxGeometry(1.4, 0.3, 1.4, 2, 0.08)),
    stone = ['#cfc3ad', '#bdb099', '#d6cab5'];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.2,
      x = Math.cos(a) * 6.2,
      z = Math.sin(a) * 6.2,
      broken = i === 2 || i === 5,
      h = broken ? 0.5 : 1;
    stage.mesh(column, {
      name: `Column ${i + 1}`,
      position: [x, 2.1 * h, z],
      scale: [1, h, 1],
      color: stone[i % 3],
      roughness: 0.8,
    });
    if (!broken)
      stage.mesh(capital, {
        name: `Capital ${i + 1}`,
        position: [x, 4.35, z],
        color: stone[(i + 1) % 3],
        roughness: 0.75,
      });
  }
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const rock = toGeometry(icosahedronGeometry(1, 1));
  for (let i = 0; i < 14; i++) {
    const a = random() * Math.PI * 2,
      r = 8 + random() * 9,
      s = 0.4 + random() * 1.2;
    stage.mesh(rock, {
      name: `Boulder ${i + 1}`,
      position: [Math.cos(a) * r, s * 0.5, Math.sin(a) * r],
      rotation: [random() * 3, random() * 3, 0],
      scale: [s, s * 0.7, s],
      color: '#7d7466',
      roughness: 0.95,
    });
  }
  await addShadows(stage, { resolution: 2048 });
  life.signal.throwIfAborted();

  // Scene 3, the items. Each sits on its own render layer; the preview view draws only the selected slot's layer.
  item.background = '#1c2331';
  item.lighting.direction.set([-3, 4, 4, 3.2]);
  item.lighting.radiance.set([1, 0.95, 0.88, 0.45]);
  item.lighting.ambient.set([0.8, 0.88, 1]);
  const gold = { color: '#e0b04a', metalness: 1, roughness: 0.2 },
    steel = { color: '#a9b0ba', metalness: 1, roughness: 0.3 };
  const ring = stage.mesh(toGeometry(torusGeometry(0.62, 0.13, 24, 64)), { name: 'Gold band', scene: item, ...gold });
  const gem = stage.mesh(toGeometry(octahedronGeometry(0.3, 0)), {
    name: 'Sapphire',
    scene: item,
    parent: ring,
    position: [0, 0.78, 0],
    scale: [1, 1.3, 1],
    color: '#2f5fe0',
    metalness: 0.1,
    roughness: 0.08,
  });
  const potion = stage.mesh(toGeometry(icosahedronGeometry(0.62, 3)), {
    name: 'Potion flask',
    scene: item,
    position: [0, -0.15, 0],
    color: '#c8303c',
    roughness: 0.12,
  });
  const neck = stage.mesh(toGeometry(cylinderGeometry(0.2, 0.2, 0.55, 24)), {
    name: 'Potion neck',
    scene: item,
    parent: potion,
    position: [0, 0.75, 0],
    color: '#d8e4ea',
    roughness: 0.1,
  });
  const cork = stage.mesh(toGeometry(cylinderGeometry(0.15, 0.2, 0.22, 20)), {
    name: 'Cork',
    scene: item,
    parent: neck,
    position: [0, 0.38, 0],
    color: '#8a5a34',
    roughness: 0.9,
  });
  const key = stage.mesh(toGeometry(torusGeometry(0.34, 0.09, 16, 40)), {
    name: 'Key bow',
    scene: item,
    position: [0, 0.62, 0],
    ...steel,
  });
  const shaft = stage.mesh(toGeometry(cylinderGeometry(0.07, 0.07, 1.3, 16)), {
    name: 'Key shaft',
    scene: item,
    parent: key,
    position: [0, -0.95, 0],
    ...steel,
  });
  const teeth = [-0.22, -0.4].map((y, i) =>
    stage.box({
      name: 'Key tooth',
      scene: item,
      parent: shaft,
      size: [0.24 - i * 0.04, 0.1, 0.09],
      position: [0.13, y, 0],
      ...steel,
    }),
  );
  [ring, potion, key].forEach((root, slot) => setRenderLayers(root, layerMask(slot + 1)));
  void gem;
  void cork;
  void teeth;
  const roots = [ring, potion, key];

  // Scene 2, the HUD, in units where the canvas is 2 high: an orthographic camera looking straight down. Everything
  // lies in the XZ plane (x right, z down the screen), stacked in y.
  hud.background = null;
  hud.lighting.direction.set([0, 1, 0, 0]);
  hud.lighting.radiance.set([1, 1, 1, 1.15]);
  const hudCamera = new Camera({ position: [0, 10, 0], target: [0, 0, 0], near: 0.1, far: 20 });
  new CameraProjection({ height: 2 }).attach(hudCamera);
  const slab = toGeometry(roundedBoxGeometry(1, 0.01, 1, 1, 0.004)),
    panel = (name: string, color: string) => stage.mesh(slab, { name, scene: hud, color, roughness: 1 });
  const healthBack = panel('Health back', '#10141c'),
    health = panel('Health bar', '#d9413b'),
    staminaBack = panel('Stamina back', '#10141c'),
    stamina = panel('Stamina bar', '#4cc38a'),
    cross = [panel('Crosshair', '#f4f1e8'), panel('Crosshair', '#f4f1e8')],
    slotBack = ITEMS.map(() => panel('Slot', '#10141c')),
    slotFrame = ITEMS.map(() => panel('Slot frame', '#5d6a80')),
    slotFill = ITEMS.map(() => panel('Slot inside', '#1d2533'));
  const icons = [
    stage.mesh(toGeometry(torusGeometry(0.1, 0.025, 12, 32)), {
      name: 'Slot 1 icon',
      scene: hud,
      rotation: [Math.PI / 2, 0, 0],
      color: '#e0b04a',
      roughness: 0.5,
    }),
    stage.mesh(toGeometry(cylinderGeometry(0.07, 0.07, 0.03, 28)), {
      name: 'Slot 2 icon',
      scene: hud,
      color: '#d9413b',
      roughness: 0.5,
    }),
    stage.mesh(toGeometry(coneGeometry(0.05, 0.2, 3)), {
      name: 'Slot 3 icon',
      scene: hud,
      rotation: [-Math.PI / 2, 0, 0],
      color: '#c4cad4',
      roughness: 0.5,
    }),
  ];
  let selected = 0,
    aspect = 1,
    hp = 0.82,
    sp = 0.64;
  const SLOT = 0.26,
    PITCH = SLOT * 1.2,
    BOTTOM = 0.84;
  const bar = (back: Mesh, fill: Mesh, x: number, z: number, w: number, value: number, h: number) => {
    back.setPosition([x + w / 2, 0.1, z]).setScale([w + 0.03, 1, h + 0.03]);
    fill.setPosition([x + (w * value) / 2, 0.2, z]).setScale([Math.max(w * value, 0.0001), 1, h]);
  };
  // Bars and hotbar: on a wide canvas the bars sit bottom left, on a narrow one above the hotbar.
  const refresh = () => {
    const compact = aspect < 1.5,
      w = compact ? Math.min(0.7, 2 * aspect - 0.2) : 0.7,
      x = compact ? -w / 2 : -aspect + 0.1,
      z = compact ? 0.56 : 0.78;
    bar(healthBack, health, x, z, w, hp, 0.07);
    bar(staminaBack, stamina, x, z + 0.1, w, sp, 0.05);
    ITEMS.forEach((_, i) => {
      const px = (i - 1) * PITCH,
        on = i === selected,
        size = SLOT + (on ? 0.035 : 0.015);
      slotBack[i].setPosition([px, 0.1, BOTTOM]).setScale([size + 0.02, 1, size + 0.02]);
      slotFrame[i].setPosition([px, 0.15, BOTTOM]).setScale([size, 1, size]);
      slotFrame[i].material.set({ color: on ? '#ffd885' : '#5d6a80', roughness: 1 });
      slotFill[i].setPosition([px, 0.2, BOTTOM]).setScale([SLOT - 0.01, 1, SLOT - 0.01]);
      icons[i].setPosition([px, 0.3, BOTTOM]);
    });
    cross[0].setPosition([0, 0.3, 0]).setScale([0.05, 1, 0.006]);
    cross[1].setPosition([0, 0.3, 0]).setScale([0.006, 1, 0.05]);
  };

  // Views, back to front: the ruin, the HUD over it, the preview over both.
  const views: RenderView[] = [
    { id: 'main', camera: engine.camera, viewport: [0, 0, 1, 1] },
    { id: 'hud', camera: hudCamera, viewport: [0, 0, 1, 1], scene: hud, clear: { color: false } },
    {
      id: 'preview',
      camera: new Camera({ position: [0, 0.3, 4.6], target: [0, 0.1, 0], fov: 34, near: 0.1, far: 20 }),
      viewport: [0.7, 0.02, 0.28, 0.28],
      scene: item,
      layers: layerMask(1),
    },
  ];
  const mainBox = viewBox(host, ''),
    previewBox = viewBox(host, ITEMS[0]);
  mainBox.style.border = '0';
  mainBox.querySelector('.view-label')?.remove();
  previewBox.classList.add('minimap');
  const label = previewBox.querySelector('.view-label')!;
  const select = (slot: number) => {
    selected = Math.max(0, Math.min(ITEMS.length - 1, slot));
    views[2].layers = layerMask(selected + 1);
    label.textContent = ITEMS[selected];
    refresh();
  };
  pickOnClick(
    engine,
    mainBox,
    () => views[0],
    (m) => (status.textContent = `Ruin: ${m?.name ?? 'sky'}`),
    life.signal,
  );
  pickOnClick(
    engine,
    previewBox,
    () => views[2],
    (m) => (status.textContent = `Preview: ${m?.name ?? 'nothing'}`),
    life.signal,
  );
  // A click in a hotbar slot's rectangle selects it (the HUD scene has no DOM of its own).
  canvas.addEventListener(
    'click',
    (e) => {
      const rect = canvas.getBoundingClientRect(),
        px = ((e.clientX - rect.left) / rect.height) * 2 - aspect,
        pz = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      ITEMS.forEach((_, i) => {
        if (Math.abs(px - (i - 1) * PITCH) < SLOT / 2 && Math.abs(pz - BOTTOM) < SLOT / 2) select(i);
      });
    },
    { signal: life.signal },
  );
  addEventListener('keydown', (e) => (e.key >= '1' && e.key <= '3' ? select(+e.key - 1) : 0), {
    signal: life.signal,
  });
  // The preview: a square in the top-right corner, a third of the shorter side, 12 CSS pixels from the edges.
  const layout = () => {
    const w = canvas.clientWidth || 1,
      h = canvas.clientHeight || 1,
      size = Math.round(Math.min(w, h) * 0.36),
      margin = 12;
    aspect = w / h;
    views[2].viewport = [(w - size - margin) / w, margin / h, size / w, size / h];
    place(previewBox, views[2].viewport);
    place(mainBox, views[0].viewport);
    refresh();
  };
  const resize = new ResizeObserver(layout);
  resize.observe(canvas);
  layout();
  select(0);
  dispose = () => {
    resize.disconnect();
    stage.dispose();
  };

  let time = 0;
  const update = () => {
    const angle = 0.02 + time * 0.12;
    engine.camera.position = [Math.sin(angle) * 15.5, 5.6, Math.cos(angle) * 15.5];
    engine.camera.target = [0, 1.7, 0];
    relic.setRotation([time * 0.5, time * 0.8, 0]);
    roots[0].setRotation([0.5, time * 0.9, 0]);
    roots[1].setRotation([0.3, time * 0.9, 0]);
    roots[2].setRotation([0, time * 0.9, 0.5]);
    hp = 0.82 - 0.1 * Math.max(0, Math.sin(time * 0.4));
    sp = 0.64 + 0.2 * Math.sin(time * 0.7);
    refresh();
  };
  update();
  stage.onTick((delta) => {
    if (!still) time += Math.min(delta, 0.1);
    update();
  });

  const readiness = await submitPrincipalScene(() => engine.render({ views }), engineRuntime(engine).gpu!.queue, {
    signal: life.signal,
  });
  life.signal.throwIfAborted();
  engine.views = views;
  engine.start();
  window.hudPreview = {
    stage,
    views,
    readiness,
    async pickAt(index, fx, fy) {
      const [x, y, w, h] = views[index].viewport;
      return (
        (await engine.pick((x + fx * w) * canvas.clientWidth, (y + fy * h) * canvas.clientHeight, views[index]))
          ?.name ?? null
      );
    },
    select,
    frameTime: (frames) => frameTime(engine, () => views, frames),
  };
  page.ready(
    'Press 1, 2 or 3, or click a hotbar slot, to inspect an item. Click the ruin or the preview to name a part.',
  );
} catch (error) {
  dispose();
  if (!life.signal.aborted) page.error(`Unable to start: ${String(error)}`);
}
