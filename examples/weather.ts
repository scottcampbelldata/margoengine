// Weather demo: a yard with a wall and posts under the weather state machine. Rain, snow and lightning come from the
// sky's Weather, hail from this package, and the ground gets darker and shinier when wet and white under snow. Pick a
// preset to blend to it. Under prefers-reduced-motion (the visual check) the page starts in a fixed storm at t = 0.
import { createStage } from 'margoengine';
import { boxGeometry } from '@margoengine/geometry';
import { Material, createMesh } from '@margoengine/materials';
import { engineRuntime } from '@margoengine/core/extension';
import { Weather } from '@margoengine/sky/weather';
import { Hail } from '@margoengine/weather/hail';
import {
  WEATHER_PRESETS,
  WeatherMachine,
  applyWetness,
  hailSettings,
  skyWeather,
  surfaceResponse,
  windAt,
  type WeatherPresetName,
} from '@margoengine/weather';
import { still } from './multi-view.js';

declare global {
  interface Window {
    weatherDemo?: { machine: WeatherMachine; weather: Weather; hail: Hail };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!,
  bar = document.querySelector<HTMLDivElement>('#presets')!;
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

// Linear to sRGB hex for a Material colour.
const hex = (linear: readonly number[]): string =>
  '#' +
  linear
    .map((v) => {
      const c = Math.min(1, Math.max(0, v));
      const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(s * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('');

try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 2.4, 9], target: [0, 1.4, 0], near: 0.1, far: 400 },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  life.signal.throwIfAborted();
  const engine = stage.engine;
  engineRuntime(engine).lighting.direction.set([-3, 7, 4, 2.4]);

  // The yard: a ground slab and a wall whose materials follow the ground state, and three posts.
  const groundColor: [number, number, number] = [0.12, 0.14, 0.12];
  const ground = new Material({ color: hex(groundColor), roughness: 0.85 });
  const wall = new Material({ color: '#8a7f73', roughness: 0.8 });
  createMesh(engine, boxGeometry(60, 0.2, 60), ground).root.setPosition([0, -0.1, 0]);
  createMesh(engine, boxGeometry(14, 3, 0.4), wall).root.setPosition([0, 1.5, -4]);
  for (const x of [-3, 0, 3])
    createMesh(engine, boxGeometry(0.3, 1.6, 0.3), wall).root.setPosition([x * 1.2, 0.8, 0.5]);

  const machine = new WeatherMachine(still ? 'thunderstorm' : 'clear', { seed: 4 });
  const sky = Weather.attach(engine, { precipitation: 'none', intensity: 0, fadeSeconds: 0, particles: 24000 });
  const hail = Hail.attach(engine, { intensity: 0, fadeSeconds: 0, particles: 6000 });

  const buttons = new Map<string, HTMLButtonElement>();
  const press = (name: string) => {
    for (const [key, button] of buttons) button.setAttribute('aria-pressed', String(key === name));
  };
  for (const name of Object.keys(WEATHER_PRESETS) as WeatherPresetName[]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => {
      machine.transitionTo(name, { seconds: 6 });
      press(name);
    });
    buttons.set(name, button);
    bar.append(button);
  }
  const walk = document.createElement('button');
  walk.type = 'button';
  walk.textContent = 'random walk';
  walk.addEventListener('click', () => {
    machine.randomWalk('clear', { seed: 11, hold: [8, 20], blend: [6, 12] });
    press('random walk');
  });
  buttons.set('random walk', walk);
  bar.append(walk);
  press(still ? 'thunderstorm' : 'clear');

  const eye = [0, 2.4, 9] as const;
  const sync = () => {
    const state = machine.state;
    const wind = windAt(machine.wind, eye[0], eye[1], eye[2], machine.time);
    Object.assign(sky.options, skyWeather(state, wind));
    Object.assign(hail.options, hailSettings(state, wind));
    hail.lift = sky.flash;
    // The ground and the wall: darker and shinier when wet, white where snow lies (the wall only a little).
    const floor = surfaceResponse({ roughness: 0.85, color: groundColor }, 1, machine.wetness, machine.snowCover);
    ground.color = hex(floor.color);
    applyWetness(ground, 0.85, machine.wetness);
    ground.roughness = floor.roughness;
    applyWetness(wall, 0.8, machine.wetness);
    status.textContent =
      `rain ${state.rain.toFixed(2)} · snow ${state.snow.toFixed(2)} · hail ${state.hail.toFixed(2)} · ` +
      `wind ${state.wind.toFixed(1)} m/s · wet ${machine.wetness.toFixed(2)} · snow cover ${machine.snowCover.toFixed(2)}`;
  };
  if (still) {
    // Deterministic frame: the storm blended in, the clock at a fixed time.
    machine.update(0);
    sync();
  }
  stage.use({
    name: 'weather-demo',
    setup() {},
    onPreUpdate(delta) {
      if (still) return;
      machine.update(delta);
      sync();
    },
  });
  window.weatherDemo = { machine, weather: sky, hail };
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  canvas.dataset.ready = 'true';
} catch (error) {
  if (!life.signal.aborted) status.textContent = String(error);
}
