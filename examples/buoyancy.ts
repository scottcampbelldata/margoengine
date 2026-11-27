import { Physics } from '@margoengine/physics';
import type { PhysicsDebugView } from '@margoengine/physics/debug-view';
import { LoadSolver } from '@margoengine/physics/loads';
import { SpectralSea } from '@margoengine/physics/sea';
import { BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '@margoengine/physics/world';
import { createStage } from '@margoengine/stage';
import { Water } from '@margoengine/water';
import { demoStatus } from './demo-status.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const status = demoStatus(canvas, document.querySelector('#status'));
const play = document.querySelector<HTMLButtonElement>('#play')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;
const time = document.querySelector<HTMLInputElement>('#time')!;
const elapsed = document.querySelector<HTMLOutputElement>('#elapsed')!;
const measurement = document.querySelector<HTMLOutputElement>('#measurement')!;
const showLoads = document.querySelector<HTMLInputElement>('#show-loads')!;
const loadReadout = document.querySelector<HTMLOutputElement>('#debug-loads')!;
const rate = 60;
const lastTick = Number(time.max);
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

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    background: '#a7bbc9',
    camera: { position: [3.4, 2.45, 4.4], target: [0, -0.03, 0], near: 0.12, far: 36, fov: 43 },
    onError: (error) => status.error(error),
  });
  release = () => stage.dispose();
  life.signal.throwIfAborted();
  const { engine } = stage;
  engine.lighting.direction.set([-0.3, 0.73, 0.52, 2.1]);
  engine.lighting.radiance.set([1, 0.92, 0.81, 0.24]);
  engine.lighting.ambient.set([0.43, 0.52, 0.62]);
  const radius = 0.36;
  const half: [number, number, number] = [0.56, 0.22, 0.34];
  const sphere = stage.sphere({ radius, color: '#de8e28', roughness: 0.36 });
  const crate = stage.box({ size: [2 * half[0], 2 * half[1], 2 * half[2]], color: '#8a402c', roughness: 0.59 });
  for (const x of [-0.33, 0.33]) {
    stage
      .box({ size: [0.055, 0.027, 0.64], position: [x, 0.233, 0], color: '#d6a570', roughness: 0.64 })
      .setParent(crate);
  }
  stage.box({ size: [9, 0.2, 6.3], position: [0, -1.23, 0], color: '#827f6d', roughness: 0.93 });
  stage.box({ size: [9, 1.23, 0.44], position: [0, -0.47, -3.2], color: '#a09c89', roughness: 0.91 });
  stage.box({ size: [0.44, 1.23, 6.3], position: [-4.55, -0.47, 0], color: '#a09c89', roughness: 0.91 });
  const sea = new SpectralSea({
    waves: {
      frequencies: Float64Array.of(0.8, 1),
      directions: Float64Array.of(0, Math.PI),
      energy: new Float64Array(4),
      depth: 1.13,
      density: 1000,
    },
  });
  const water = Water.attach(engine, { sea, size: [9, 6.3], segments: 48, color: [0.024, 0.135, 0.19] });

  await Physics.load({ signal: life.signal });
  life.signal.throwIfAborted();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 } });
  // RigidSolver owns the clock. The engine attachment lets the shared debug view find this Physics.
  const physics = new Physics(engine, { arena: world.arena, fixedTimestep: 1 / rate, paused: true });
  let debugView: PhysicsDebugView | undefined;
  let request = 0;
  release = () => {
    cancelAnimationFrame(request);
    debugView?.dispose();
    physics[Symbol.dispose]();
    water.dispose();
    stage.dispose();
  };
  const buoy = physics.addBody(null, {
    position: [-0.95, -0.23, 0.18],
    linearDamping: 0.65,
    colliders: { shape: 'sphere', radius, mass: 82 },
  });
  const tilt = (26 * Math.PI) / 180;
  const box = physics.addBody(null, {
    position: [0.85, 0.07, 0],
    rotation: [Math.sin(tilt / 2), 0, 0, Math.cos(tilt / 2)],
    linearDamping: 0.75,
    angularDamping: 0.85,
    colliders: { shape: 'box', halfExtents: half, mass: 156 },
  });
  const loads = new LoadSolver();
  world
    .add(new RigidSolver(), { physics })
    .add(loads, {
      sea,
      bodies: [
        { row: buoy.row, shape: { sphere: radius } },
        { row: box.row, shape: { box: half } },
      ],
    })
    .couple(['loads', 'rigid'], 'staggered');
  // Initialise the solver-to-rigid force field before taking the replay start.
  world.advance(1);
  const start = world.takeSnapshot();
  let tick = 0;
  let playhead = 0;
  let previous = 0;
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const debugLoads = () => {
    const { region } = loads.exportPorts(tick).find((port) => port.field === BODY_FORCES_FIELD.name)!;
    const forces = regionWords(region.memory ?? world.memory, region) as Float64Array;
    const liftSphere = forces[buoy.row * FORCE_WORDS + 1]!;
    const liftBox = forces[box.row * FORCE_WORDS + 1]!;
    const rollBox = forces[box.row * FORCE_WORDS + 3]!;
    loadReadout.value =
      `Held upward load (cyan) · Sphere ${liftSphere.toFixed(1)} N · Box ${liftBox.toFixed(1)} N` +
      ` · Box roll torque (amber) ${rollBox.toFixed(1)} N·m`;
    loadReadout.dataset.loads = JSON.stringify([liftSphere, liftBox, rollBox]);
    const vertices: number[] = [];
    const colors: number[] = [];
    const lift = [0.23, 0.94, 1, 1] as const;
    const torque = [1, 0.66, 0.13, 1] as const;
    const liftScale = 1 / 2300; // Drawing scales in metres per N or per N·m.
    const torqueScale = 1 / 125;
    const arrow = (
      [x, y, z]: readonly [number, number, number],
      dx: number,
      dy: number,
      color: readonly [number, number, number, number],
    ) => {
      const length = Math.hypot(dx, dy);
      if (length < 1e-5) return;
      const head = Math.min(0.085, 0.32 * length) / length;
      const sx = dx * head;
      const sy = dy * head;
      const tipX = x + dx;
      const tipY = y + dy;
      vertices.push(x, y, z, tipX, tipY, z);
      vertices.push(tipX, tipY, z, tipX - sx + 0.5 * sy, tipY - sy - 0.5 * sx, z);
      vertices.push(tipX, tipY, z, tipX - sx - 0.5 * sy, tipY - sy + 0.5 * sx, z);
      for (let i = 0; i < 6; i++) colors.push(...color);
    };
    arrow(buoy.worldCenterOfMass, 0, liftSphere * liftScale, lift);
    arrow(box.worldCenterOfMass, 0, liftBox * liftScale, lift);
    arrow(box.worldCenterOfMass, rollBox * torqueScale, 0, torque);
    return { vertices: new Float32Array(vertices), colors: new Float32Array(colors) };
  };
  showLoads.addEventListener(
    'change',
    async () => {
      if (debugView) {
        debugView.enabled = showLoads.checked;
        loadReadout.hidden = !showLoads.checked;
        return;
      }
      if (!showLoads.checked) return;
      showLoads.disabled = true;
      try {
        const { PhysicsDebugView } = await import('@margoengine/physics/debug-view');
        life.signal.throwIfAborted();
        const view = await PhysicsDebugView.attach(engine, physics, { world: false, width: 2.4, onTop: true });
        if (life.signal.aborted) {
          view.dispose();
          return;
        }
        view.add(debugLoads);
        debugView = view;
        loadReadout.hidden = false;
      } catch (error) {
        if (!life.signal.aborted) status.error(error);
      } finally {
        if (!life.signal.aborted) showLoads.disabled = false;
      }
    },
    { signal: life.signal },
  );
  const updateButton = () => {
    play.textContent = playing ? 'Pause' : 'Play';
  };
  const measure = () => {
    const localWater = sea.elevation(buoy.position[0], buoy.position[2], tick / rate);
    const rise = buoy.position[1] - localWater;
    const [x, y, z, w] = box.rotation;
    const heel = (Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * 180) / Math.PI;
    measurement.value = 'Sphere centre: ' + rise.toFixed(3) + ' m · Box heel: ' + heel.toFixed(1) + '°';
    measurement.dataset.rise = String(rise);
    measurement.dataset.heel = String(heel);
  };
  const seek = (target: number) => {
    if (target < tick) world.restoreSnapshot(start.bytes);
    world.advance(target + 1);
    tick = target;
    sphere.setPosition(buoy.position).setQuaternion(buoy.rotation);
    crate.setPosition(box.position).setQuaternion(box.rotation);
    time.value = String(tick);
    elapsed.value = (tick / rate).toFixed(2) + ' s';
    water.setTime(tick / rate);
    measure();
  };
  const playMotion = () => {
    if (!playing && tick === lastTick) {
      seek(0);
      playhead = 0;
    }
    playing = !playing;
    updateButton();
  };
  play.addEventListener('click', playMotion, { signal: life.signal });
  reset.addEventListener(
    'click',
    () => {
      playing = false;
      playhead = 0;
      seek(0);
      updateButton();
    },
    { signal: life.signal },
  );
  time.addEventListener(
    'input',
    () => {
      playing = false;
      playhead = Number(time.value);
      seek(playhead);
      updateButton();
    },
    { signal: life.signal },
  );
  const frame = (now: number) => {
    if (life.signal.aborted || status.failed) return;
    try {
      if (playing && previous > 0) {
        playhead = Math.min(lastTick, playhead + Math.min(0.1, (now - previous) / 1000) * rate);
        const target = Math.floor(playhead);
        if (target !== tick) seek(target);
        if (target === lastTick) {
          playing = false;
          updateButton();
        }
      }
      previous = now;
      engine.render({ delta: 0 });
      request = requestAnimationFrame(frame);
    } catch (error) {
      status.error(error);
    }
  };
  seek(0);
  updateButton();
  engine.render({ delta: 0 });
  request = requestAnimationFrame(frame);
  play.disabled = reset.disabled = time.disabled = showLoads.disabled = false;
  status.ready('');
} catch (error) {
  if (!life.signal.aborted) status.error(error);
}
