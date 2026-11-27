// GPU liquid: a 1 m tank of 65,536 MLS-MPM particles by default (up to 262,144), stirred by the pointer, with a box to
// drop in that floats on the force the liquid reports, and the liquid's debug view. @margoengine/water/liquid, docs in
// packages/water/README.md ("GPU liquid").
import { createStage } from 'margoengine';
import { boxGeometry } from '@margoengine/geometry';
import { Material, createMesh } from '@margoengine/materials';
import { projectPoint, screenToWorld } from '@margoengine/math/project';
import { GPULiquid, type GPULiquidAttachOptions, type LiquidVec3 } from '@margoengine/water/liquid';
import { demoStatus } from './demo-status.ts';

declare global {
  interface Window {
    liquidDemo?: { liquid: GPULiquid };
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
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

const byId = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;
const slider = (id: string) => Number(byId<HTMLInputElement>(id).value);
const checked = (id: string) => byId<HTMLInputElement>(id).checked;

const TANK = { min: [-0.5, 0, -0.5] as LiquidVec3, max: [0.5, 0.8, 0.5] as LiquidVec3 };
const HALF = 0.08;

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    background: '#0d1a2d',
    camera: { position: [0, 0.75, 1.9], target: [0, 0.25, 0], near: 0.02, far: 50 },
    onError: (err) => {
      if (!life.signal.aborted) page.error(err);
    },
  });
  life.signal.throwIfAborted();
  const engine = stage.engine;

  // The tank's floor, under the liquid.
  const floor = createMesh(engine, boxGeometry(1.1, 0.04, 1.1), new Material({ color: '#2b3a52', roughness: 0.7 }));
  floor.root.setPosition([0, -0.02, 0]);
  const boxMesh = createMesh(engine, boxGeometry(2 * HALF, 2 * HALF, 2 * HALF), new Material({ color: '#e0a040', roughness: 0.5 }));
  boxMesh.root.setPosition([0, -10, 0]);

  // The floating box: the page integrates it from gravity and the liquid's force on it (one frame behind on WebGPU),
  // and hands its pose and velocity back to the liquid as a collider. It stays upright; the torque is not used.
  const body = { active: false, position: [0, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] };

  const debugOptions = () => ({
    enabled: byId('btn-debug').getAttribute('aria-pressed') === 'true',
    particles: checked('dbg-density') ? ('density' as const) : ('speed' as const),
    grid: checked('dbg-grid'),
    container: checked('dbg-box'),
    colliders: checked('dbg-col'),
  });
  const makeOptions = (count: number): GPULiquidAttachOptions => ({
    count,
    box: TANK,
    fill: { min: TANK.min, max: [0.5, 0.3, 0.5] },
    viscosity: slider('sl-visc'),
    paused: byId('btn-pause').getAttribute('aria-pressed') === 'true',
    debug: debugOptions(),
  });

  const countSelect = byId<HTMLSelectElement>('count');
  let liquid = GPULiquid.attach(engine, makeOptions(Number(countSelect.value)));
  // On the WebGL2 layer the liquid steps on the CPU, so the page runs a smaller one there.
  if (liquid.stats.backend === 'webgl2-compat') {
    liquid.dispose();
    countSelect.value = '2048';
    liquid = GPULiquid.attach(engine, makeOptions(2048));
  }
  window.liquidDemo = { liquid };
  dispose = () => {
    liquid.dispose();
    stage.dispose();
  };

  const syncCollider = () =>
    liquid.setColliders(
      body.active ? [{ shape: 'box', position: body.position, halfExtents: [HALF, HALF, HALF], velocity: body.velocity }] : [],
    );

  // The pointer on the plane through the tank's middle, while a button is held.
  const at = { x: 0, y: 0, z: 0 };
  let stirring = false;
  const stir = (event: PointerEvent) => {
    if (!stirring) return;
    const depth = projectPoint({ x: 0, y: 0.25, z: 0 }, engine.camera, at)?.z ?? 0.5;
    const p = screenToWorld(event.offsetX, event.offsetY, depth, engine.camera, canvas.clientWidth, canvas.clientHeight, at);
    liquid.setPointer(p ? { position: [p.x, p.y, p.z], radius: slider('sl-radius') } : null);
  };
  canvas.addEventListener('pointerdown', (event) => {
    stirring = true;
    canvas.setPointerCapture(event.pointerId);
    stir(event);
  });
  canvas.addEventListener('pointermove', stir);
  const stop = () => {
    stirring = false;
    liquid.setPointer(null);
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  byId<HTMLButtonElement>('btn-drop').addEventListener('click', () => {
    body.active = true;
    body.position = [(Math.random() - 0.5) * 0.4, 0.65, (Math.random() - 0.5) * 0.4];
    body.velocity = [0, 0, 0];
    syncCollider();
  });
  byId<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
    body.active = false;
    boxMesh.root.setPosition([0, -10, 0]);
    syncCollider();
    liquid.reset();
  });
  countSelect.addEventListener('change', () => {
    liquid.dispose();
    liquid = GPULiquid.attach(engine, makeOptions(Number(countSelect.value)));
    window.liquidDemo = { liquid };
    syncCollider();
  });

  const bind = (id: string, apply: (v: number) => void) => {
    const input = byId<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      byId<HTMLOutputElement>(id.replace('sl-', 'out-')).textContent = input.value;
      apply(Number(input.value));
    });
  };
  bind('sl-visc', (v) => (liquid.options.viscosity = v));
  bind('sl-radius', () => {});
  bind('sl-rho', () => {});

  const debugButton = byId<HTMLButtonElement>('btn-debug');
  debugButton.addEventListener('click', () => {
    const on = debugButton.getAttribute('aria-pressed') !== 'true';
    debugButton.setAttribute('aria-pressed', String(on));
    byId('debug-opts').hidden = !on;
    liquid.setDebug(debugOptions());
  });
  for (const id of ['dbg-density', 'dbg-grid', 'dbg-box', 'dbg-col'])
    byId<HTMLInputElement>(id).addEventListener('change', () => liquid.setDebug(debugOptions()));

  const pauseButton = byId<HTMLButtonElement>('btn-pause');
  pauseButton.addEventListener('click', () => {
    const paused = pauseButton.getAttribute('aria-pressed') !== 'true';
    liquid.options.paused = paused;
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
  });

  let frames = 0;
  let elapsed = 0;
  stage.onTick((dt) => {
    if (body.active && !liquid.options.paused) {
      // Semi-implicit Euler on gravity plus the liquid's push; the tank's walls and floor stop the box.
      const h = Math.min(dt, 1 / 30);
      const mass = slider('sl-rho') * (2 * HALF) ** 3;
      const force = liquid.forces[0]?.force ?? [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        body.velocity[a]! += ((a === 1 ? -9.81 : 0) + force[a]! / mass) * h;
        body.velocity[a]! *= Math.exp(-0.5 * h);
        body.position[a]! += body.velocity[a]! * h;
        const lo = TANK.min[a]! + HALF,
          hi = TANK.max[a]! - HALF;
        if (body.position[a]! < lo || body.position[a]! > hi) {
          body.position[a] = Math.min(hi, Math.max(lo, body.position[a]!));
          body.velocity[a] = 0;
        }
      }
      boxMesh.root.setPosition(body.position);
      syncCollider();
    }
    frames++;
    elapsed += dt;
    if (elapsed < 0.5) return;
    const s = liquid.stats;
    status.textContent =
      `${liquid.count.toLocaleString()} particles · ${s.dims.join('×')} grid · ${s.frameSubsteps} substeps · ` +
      `${Math.round(frames / elapsed)} fps · ${s.backend}${s.realTime ? '' : ' · slow motion'}`;
    frames = 0;
    elapsed = 0;
  });

  engine.render({ delta: 1 / 60 });
  page.ready(`${liquid.count.toLocaleString()} particles · ${liquid.stats.backend}`);
} catch (cause) {
  page.error(cause);
}
