// Real-GPU WalkControls check (driven by scripts/test-walk-browser.js): the generated two-storey house, a scripted walk
// steered toward each waypoint with the real W key held, pauses for screenshots, dollhouse toggles, touch input.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { WalkControls } from '@margoengine/controls/walk';
import { PATH, buildHouse, clearance } from './house.js';

const EYE = 1.65,
  canvas = document.querySelector('#gpu');
const engine = await Engine.create(canvas, {
  backend: 'webgpu',
  camera: { position: [PATH[0][0], EYE, PATH[0][1]], target: [PATH[0][0], EYE, PATH[0][1] + 1] },
});
const state = (window.walkState = {
  backend: engine.backend,
  errors: [],
  frames: 0,
  worst: Infinity,
  maxStep: 0,
  waypoint: 1,
  paused: false,
  steering: true,
  updateMs: [],
  reached: [],
});
const device = engineRuntime(engine).gpu;
device?.addEventListener('uncapturederror', (event) => state.errors.push(event.error.message));
const house = buildHouse(engine),
  walk = new WalkControls(engine);
walk.pointerLock = false;
const update = walk.update.bind(walk);
walk.update = (delta) => {
  const t = performance.now(),
    moved = update(delta);
  if (delta) state.updateMs.push(performance.now() - t);
  return moved;
};
let last = null;
engine.onFrame(() => {
  const c = engine.camera,
    [x, y, z] = c.position;
  if (last) {
    state.frames++;
    state.worst = Math.min(
      state.worst,
      clearance(house, x, y - EYE + walk.stepHeight + walk.radius, y + 0.1 - walk.radius, z),
    );
    state.maxStep = Math.max(state.maxStep, Math.abs(y - last[1]));
  }
  last = [x, y, z];
  if (!state.steering || state.waypoint >= PATH.length) return;
  const [tx, tz] = PATH[state.waypoint];
  if (Math.hypot(tx - x, tz - z) < 0.15) {
    state.reached.push({ waypoint: state.waypoint, eye: [x, y, z] });
    // Face the next leg (the last view looks back across the upper floor) so each screenshot shows the house.
    const [nx, nz] = PATH[state.waypoint + 1] ?? [9, 6];
    c.target = [nx, y - 0.15 * Math.hypot(nx - x, nz - z), nz];
    state.waypoint++;
    state.paused = true;
    engine.stop();
    return;
  }
  c.target = [tx, y, tz];
});

/** Renders one frame (no motion) and reports the share of the most common colour (a camera inside a wall fills the view). */
window.inspect = () => {
  engine.render({ delta: 0 });
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  const data = context.getImageData(0, 0, copy.width, copy.height).data,
    buckets = new Map();
  for (let i = 0; i < data.length; i += 16) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return {
    dominant: Math.max(...buckets.values()) / (data.length / 16),
    colours: buckets.size,
    eye: [...engine.camera.position],
    waypoint: state.waypoint,
    worst: state.worst,
    errors: state.errors,
  };
};
window.resume = () => {
  state.paused = false;
  engine.start();
};
window.mode = (mode) =>
  new Promise((resolve) => {
    state.steering = false;
    const done = (event) => {
      walk.removeEventListener('mode', done);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          engine.stop();
          resolve({
            mode: event.mode,
            eye: [...engine.camera.position],
            target: [...engine.camera.target],
            orbit: walk.orbit.enabled,
          });
        }),
      );
    };
    walk.addEventListener('mode', done);
    walk.setMode(mode);
    engine.start();
  });
window.summary = () => {
  const times = [...state.updateMs].sort((a, b) => a - b);
  return {
    frames: state.frames,
    worstClearance: state.worst,
    maxEyeStepPerFrame: state.maxStep,
    reached: state.reached,
    errors: state.errors,
    updateMs: {
      median: times[times.length >> 1],
      p95: times[Math.floor(times.length * 0.95)],
      max: times.at(-1),
      samples: times.length,
    },
    stats: { ...walk.stats },
  };
};
/** Touch check: a thumb on the left half walks, a finger on the right half turns. */
window.touch = async () => {
  state.steering = false;
  const fire = (type, id, x, y) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        pointerType: 'touch',
        isPrimary: id === 21,
        clientX: x,
        clientY: y,
        bubbles: true,
      }),
    );
  const yaw = () =>
    Math.atan2(
      engine.camera.target[0] - engine.camera.position[0],
      engine.camera.target[2] - engine.camera.position[2],
    );
  const start = [...engine.camera.position],
    yaw0 = yaw(),
    w = canvas.clientWidth,
    h = canvas.clientHeight;
  fire('pointerdown', 21, w * 0.2, h * 0.8);
  fire('pointermove', 21, w * 0.2, h * 0.8 - 60);
  const stickShown = [...document.body.children].some(
    (e) => e.tagName === 'DIV' && e.style.display !== 'none' && e.style.position === 'fixed',
  );
  engine.start();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  fire('pointerdown', 22, w * 0.75, h * 0.5);
  fire('pointermove', 22, w * 0.75 - 40, h * 0.5);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  fire('pointerup', 21, w * 0.2, h * 0.8 - 60);
  fire('pointerup', 22, w * 0.75 - 40, h * 0.5);
  engine.stop();
  return {
    stickShown,
    walked: Math.hypot(engine.camera.position[0] - start[0], engine.camera.position[2] - start[2]),
    turned: yaw() - yaw0,
    eye: engine.camera.position[1],
    errors: state.errors,
  };
};
window.walkReady = true;
engine.start();
