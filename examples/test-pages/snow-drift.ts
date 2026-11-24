// Snow drift test page: a whole ridge scene for @margoengine/weather/snow-drift, using only public APIs. A blizzard
// from the weather drives a SnowDrift on a ridge with a steep lee face; Snow draws its depth on the ground (scoured
// windward slope, bare crest, deep lee drift), the cornices are a mesh rebuilt as they grow and break, and the slide
// state reports the slab. The buttons seek film time, step it frame by frame, turn the wind, apply settings rows, hand
// the wind back to the weather and add a trigger; after each the page checks the budget closes, a seek and a step give
// the same snow, and the field Snow reads is the drift's.
import { ready } from './page-harness';
import { Engine, Geometry, PbrMaterial } from '@margoengine/core';
import { heightfield } from '@margoengine/terrain';
import { WeatherMachine } from '@margoengine/weather';
import { Snow, snowFieldAt } from '@margoengine/weather/snow';
import { SnowDrift } from '@margoengine/weather/snow-drift';
import { SNOW_DRIFT_LOOKS, applySnowDriftSettings } from '@margoengine/weather/settings';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

const N = 161,
  cell = 1.5,
  origin: [number, number] = [-120, -120];
// A ridge across the wind (toward +X): a long windward ramp, a crest at x = 0 and a steep lee face, with a saddle.
const ridge = (x: number, z: number) => {
  const crest = 30 - 6 * Math.exp(-((z - 20) ** 2) / 400);
  return x < 0 ? crest * Math.max(0, 1 + x / 90) : crest * Math.max(0, 1 - x / 22);
};
const ground = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ground[j * N + i] = ridge(origin[0] + i * cell, origin[1] + j * cell);

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, {
    camera: { position: [90, 70, 150], target: [0, 15, 0], near: 0.5, far: 2000 },
  });
  engine.lighting.direction.set([0.4, 0.8, 0.45, 3]);
  const size = (N - 1) * cell;
  engine
    .createMesh()
    .setGeometry(heightfield(ridge, { size: [size, size], origin, resolution: N - 1 }))
    .setMaterial(new PbrMaterial({ color: [0.32, 0.29, 0.25], roughness: 0.9 }));
  const weather = new WeatherMachine('blizzard', { seed: 3 });
  const drift = new SnowDrift({
    width: N,
    depth: N,
    cellSize: cell,
    origin,
    ground,
    weather,
    initialDepth: 0.3,
    timeScale: 3600,
    step: 30,
    windDirection: 90,
  });
  Snow.attach(engine, { field: drift });
  const cornice = engine.createMesh().setMaterial(new PbrMaterial({ color: [0.92, 0.94, 0.97], roughness: 0.85 }));
  let corniceVersion = -1;
  let playing = false;
  engine.onFrame((_, delta) => {
    if (playing) drift.update(delta);
    if (drift.version !== corniceVersion) {
      const g = drift.corniceGeometry();
      cornice.setGeometry(new Geometry(g.positions, g.normals, g.indices));
      corniceVersion = drift.version;
    }
  });
  engine.start();

  const initial = 0.3 * 250 * N * N * cell * cell;
  const check = async (time: number) => {
    drift.seek(time);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const b = drift.budget,
      off = drift.mass + b.cornices - (initial + b.fallen + b.blownIn - b.blownOut - b.sublimated);
    if (Math.abs(off) > 1e-6 * (initial + b.fallen + b.blownIn)) console.warn(`BUG: the snow budget is off by ${off} kg`);
    for (const [x, z] of [
      [-60, 0],
      [3, 10],
      [20, -40],
    ] as const) {
      const field = snowFieldAt(drift, x, z)!;
      if (Math.abs(field[1] - drift.depthAt(x, z)) > 1e-4)
        console.warn(`BUG: Snow reads ${field[1]} m at ${x}, ${z}; the drift has ${drift.depthAt(x, z)}`);
    }
    const slide = drift.slide();
    say(
      `Film ${drift.time.toFixed(2)} s (${(drift.simulated / 3600).toFixed(2)} h): windward ${drift.depthAt(-40, 0).toFixed(2)} m, crest ${drift.depthAt(0, 0).toFixed(2)} m, lee ${drift.depthAt(6, 0).toFixed(2)} m; ${drift.cornices().length} cornice cells, ${drift.corniceFalls().length} falls; ${slide.release} cells would release.`,
    );
  };
  const seek = (time: number) => () => check(time);
  button('btnPlay').onclick = () => {
    playing = !playing;
    say(playing ? 'Playing: each second of film is an hour of blizzard.' : 'Paused.');
  };
  button('btnStart').onclick = seek(0);
  button('btnHour').onclick = seek(1);
  button('btnSix').onclick = seek(6);
  button('btnStep').onclick = async () => {
    // The same time reached frame by frame draws the same snow as a seek to it.
    drift.seek(0);
    for (let t = 0; t < 120; t++) drift.update(1 / 60);
    const stepped = drift.snowDepth();
    drift.seek(0);
    drift.seek(2);
    const sought = drift.snowDepth();
    if (!stepped.every((v, k) => v === sought[k])) console.warn('BUG: stepping to 2 hours drew other snow than a seek to it');
    await check(2);
  };
  button('btnTurn').onclick = async () => {
    drift.options.windDirection = -90;
    await check(drift.time + 0.5);
  };
  button('btnLook').onclick = async () => {
    applySnowDriftSettings(drift, { ...SNOW_DRIFT_LOOKS.blizzard, windDirection: 90, timeScale: 3600, step: 30, initialDepth: 0.3 });
    await check(drift.time + 0.5);
  };
  button('btnWeather').onclick = async () => {
    applySnowDriftSettings(drift, { timeScale: 3600, step: 30, initialDepth: 0.3, windDirection: null, wind: null });
    if (drift.options.wind !== undefined) console.warn('BUG: a null wind row did not hand the wind back to the weather');
    await check(drift.time + 0.5);
  };
  button('btnTrigger').onclick = async () => {
    const before = drift.stabilityAt(10, 0);
    drift.options.trigger = 300;
    const after = drift.stabilityAt(10, 0);
    if (before < 10 && !(after < before)) console.warn(`BUG: a trigger did not lower the stability (${before} to ${after})`);
    await check(drift.time);
  };
  await check(1);
  return engine;
}

ready(start());
