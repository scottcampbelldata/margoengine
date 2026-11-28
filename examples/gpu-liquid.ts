// GPU liquid: a 1 m tank of 65,536 MLS-MPM particles by default (up to 262,144), stirred by the pointer, with a crate to
// drop in, a physics body linked to the liquid both ways (it floats, tips and pushes the liquid), and the liquid's debug
// view. @margoengine/water/liquid, docs in packages/water/README.md ("GPU liquid").
import { createStage } from 'margoengine';
import { Physics } from '@margoengine/physics';
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

  // The crate is a physics body; the tank's floor and walls hold it. Linked to the liquid, it pushes the liquid as it
  // moves and takes the liquid's force and torque, so it floats at its density's draft and tips over in a wave.
  await Physics.load({ signal: life.signal });
  const physics = new Physics(engine);
  const wall = (position: LiquidVec3, halfExtents: LiquidVec3) =>
    physics.addBody(null, { type: 'fixed', position, colliders: { shape: 'box', halfExtents } });
  wall([0, -0.05, 0], [0.6, 0.05, 0.6]);
  wall([-0.55, 0.4, 0], [0.05, 0.5, 0.6]);
  wall([0.55, 0.4, 0], [0.05, 0.5, 0.6]);
  wall([0, 0.4, -0.55], [0.6, 0.5, 0.05]);
  wall([0, 0.4, 0.55], [0.6, 0.5, 0.05]);
  const crateDensity = () => slider('sl-rho');
  const crate = physics.addBody(null, {
    type: 'fixed',
    position: [0, -10, 0],
    colliders: { shape: 'box', halfExtents: [HALF, HALF, HALF], density: crateDensity() },
  });
  crate.linearDamping = 0.5;
  crate.angularDamping = 0.5;
  let link: { unlink(): void } | undefined;

  const debugOptions = () => ({
    enabled: byId('btn-debug').getAttribute('aria-pressed') === 'true',
    particles: checked('dbg-density') ? ('density' as const) : ('speed' as const),
    grid: checked('dbg-grid'),
    container: checked('dbg-box'),
    colliders: checked('dbg-col'),
  });
  const profileSelect = byId<HTMLSelectElement>('profile');
  const makeOptions = (count: number): GPULiquidAttachOptions => ({
    count,
    // Fast: weakly compressible; accurate: incompressible, a pressure projection on the grid each substep.
    profile: profileSelect.value === 'accurate' ? 'accurate' : 'fast',
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
    physics.dispose();
    stage.dispose();
  };

  const linkCrate = (on: boolean) => {
    link?.unlink();
    link = on ? liquid.link(crate, { shape: 'box', halfExtents: [HALF, HALF, HALF] }) : undefined;
  };

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
    crate.setType('dynamic');
    crate.colliders[0]!.setDensity(crateDensity());
    crate.setPosition([(Math.random() - 0.5) * 0.4, 0.65, (Math.random() - 0.5) * 0.4]);
    crate.setRotation([0, 0, 0, 1]);
    crate.setLinearVelocity([0, 0, 0]);
    crate.setAngularVelocity([0, 0, 0]);
    linkCrate(true);
  });
  byId<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
    linkCrate(false);
    crate.setType('fixed');
    crate.setPosition([0, -10, 0]);
    liquid.reset();
  });
  countSelect.addEventListener('change', () => {
    const linked = link !== undefined;
    link = undefined;
    liquid.dispose();
    liquid = GPULiquid.attach(engine, makeOptions(Number(countSelect.value)));
    window.liquidDemo = { liquid };
    linkCrate(linked);
  });

  profileSelect.addEventListener('change', () => {
    liquid.options.profile = profileSelect.value === 'accurate' ? 'accurate' : 'fast';
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
  bind('sl-rho', (v) => crate.colliders[0]!.setDensity(v));

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
    physics.paused = liquid.options.paused === true;
    boxMesh.root.setPosition(crate.position);
    boxMesh.root.setQuaternion(crate.rotation);
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
