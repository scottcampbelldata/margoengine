// Avalanche test page: a whole mountain scene for @margoengine/weather/avalanche, using only public APIs. A slab breaks
// at the head of a gully two seconds in; Snow draws the avalanche as its field (the cover, the scar, the moving core,
// the deposit), the powder cloud is soft lit puffs of vfx Clouds, and the status reports the speed, the cloud and the
// trees broken. The buttons seek film time, step it frame by frame, apply settings rows, turn the wind and hand it back
// to the weather; after each the page checks the mass budget closes, a step and a seek give the same snow, and the
// field Snow reads is the avalanche's.
import { ready } from './page-harness';
import { Engine, PbrMaterial } from '@margoengine/core';
import { heightfield } from '@margoengine/terrain';
import { Clouds } from '@margoengine/vfx/clouds';
import { WeatherMachine } from '@margoengine/weather';
import { Snow, snowFieldAt } from '@margoengine/weather/snow';
import { Avalanche } from '@margoengine/weather/avalanche';
import { AVALANCHE_LOOKS, applyAvalancheSettings } from '@margoengine/weather/settings';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

const W = 181,
  D = 181,
  cell = 4,
  origin: [number, number] = [-360, 0];
// A 38 degree face falling toward +Z into a flat valley at z = 560, a gully down its middle and ridges at its sides.
const mountain = (x: number, z: number) =>
  Math.tan((38 * Math.PI) / 180) * Math.max(0, 560 - z) +
  0.4 * Math.abs(x) * Math.min(1, Math.max(0, (560 - z) / 200)) +
  6 * Math.sin(x / 37) * Math.cos(z / 53);
const ground = new Float32Array(W * D);
for (let j = 0; j < D; j++)
  for (let i = 0; i < W; i++) ground[j * W + i] = mountain(origin[0] + i * cell, origin[1] + j * cell);

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, {
    camera: { position: [380, 260, 900], target: [0, 150, 300], near: 1, far: 5000 },
  });
  engine.lighting.direction.set([0.4, 0.8, 0.45, 3]);
  engine
    .createMesh()
    .setGeometry(heightfield(mountain, { size: [(W - 1) * cell, (D - 1) * cell], origin, resolution: W - 1 }))
    .setMaterial(new PbrMaterial({ color: [0.32, 0.29, 0.25], roughness: 0.9 }));
  const weather = new WeatherMachine('snow', { seed: 5 });
  const slide = new Avalanche({
    width: W,
    depth: D,
    cellSize: cell,
    origin,
    ground,
    cover: 1.2,
    release: { at: [0, 60], size: [40, 25] },
    releaseDepth: 1.2,
    releaseTime: 2,
    weather,
  });
  Snow.attach(engine, { field: slide });
  const clouds = Clouds.attach(engine);
  let playing = false;
  engine.onFrame((_, delta) => {
    if (playing) slide.update(delta);
    slide.drawCloud(clouds);
  });
  engine.start();

  const check = async (time: number) => {
    slide.seek(time);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const b = slide.budget(),
      off = b.flowing + b.deposited + b.suspended - b.released - b.entrained;
    if (Math.abs(off) > 1e-6 * Math.max(1, b.released + b.entrained))
      console.warn(`BUG: the avalanche budget is off by ${off} kg`);
    const f = slide.fieldData();
    for (const [x, z] of [
      [0, 100],
      [0, 400],
      [-120, 300],
    ] as const) {
      const k = Math.round(z / cell) * W + Math.round((x - origin[0]) / cell),
        at = snowFieldAt(slide, x, z)!;
      if (Math.abs(at[1] - f[2 * k + 1]!) > 1e-4)
        console.warn(`BUG: Snow reads ${at[1]} m at ${x}, ${z}; the avalanche has ${f[2 * k + 1]}`);
    }
    const speed = Math.max(...slide.flowSpeed()),
      cloud = slide.powderCloud(),
      broken = slide.plantsKept().filter((v) => v < 0.5).length;
    say(
      `Film ${slide.time.toFixed(2)} s: ${slide.isReleased ? (slide.isStopped ? 'stopped' : 'running') : 'waiting'}, core ${speed.toFixed(1)} m/s, cloud ${cloud.length} parcels up to ${Math.max(0, ...cloud.map((p) => p.height)).toFixed(0)} m, ${(b.entrained / 1000).toFixed(0)} t entrained over a ${(b.released / 1000).toFixed(0)} t slab, ${broken} samples of trees broken.`,
    );
  };
  const seek = (time: number) => () => check(time);
  button('btnPlay').onclick = () => {
    playing = !playing;
    say(playing ? 'Playing.' : 'Paused.');
  };
  button('btnStart').onclick = seek(1);
  button('btnRun').onclick = seek(10);
  button('btnEnd').onclick = seek(120);
  button('btnStep').onclick = async () => {
    slide.seek(0);
    for (let t = 0; t < 480; t++) slide.update(1 / 60);
    const stepped = Float32Array.from(slide.fieldData());
    slide.seek(0);
    slide.seek(8);
    if (!stepped.every((v, k) => v === slide.fieldData()[k]))
      console.warn('BUG: stepping to 8 s drew other snow than a seek to it');
    await check(8);
  };
  button('btnPowder').onclick = async () => {
    applyAvalancheSettings(slide, { ...AVALANCHE_LOOKS.dryPowder, releaseTime: 2, releaseDepth: 1.2 });
    await check(slide.time);
  };
  button('btnWet').onclick = async () => {
    applyAvalancheSettings(slide, { ...AVALANCHE_LOOKS.wetSlide, releaseTime: 2, releaseDepth: 1.2 });
    await check(slide.time);
  };
  button('btnWind').onclick = async () => {
    applyAvalancheSettings(slide, { releaseTime: 2, releaseDepth: 1.2, wind: 15, windDirection: 90 });
    await check(slide.time + 2);
  };
  button('btnWeather').onclick = async () => {
    applyAvalancheSettings(slide, { releaseTime: 2, releaseDepth: 1.2, wind: null, windDirection: null });
    if (slide.options.wind !== undefined)
      console.warn('BUG: a null wind row did not hand the wind back to the weather');
    await check(slide.time);
  };
  await check(10);
  return engine;
}

ready(start());
