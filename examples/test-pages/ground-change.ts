// Ground change test page: a whole hillside scene for @margoengine/terrain/ground-change, using only public APIs.
// Every event kind runs on one heightfield at once (a gully cutting back, a cut bank, a scour with its mound, a slide
// and its lobe, flood mud drying, ash fall, a lava flow cooling and a burn scar whitening) under TerrainColors, with a
// WeatherDrive wetting the ground in a storm. The buttons seek film time, step it frame by frame, change the look rows
// and remove an event; the page checks after each one that the ground it draws is the closed form at that time.
import { ready } from './page-harness';
import { Engine, PbrMaterial } from '@margoengine/core';
import { heightfieldGeometry, TerrainColors } from '@margoengine/terrain';
import { toGeometry } from '@margoengine/geometry/utils';
import { GroundChange, type GroundEvent } from '@margoengine/terrain/ground-change';
import { applyGroundChangeSettings } from '@margoengine/terrain/ground-change-settings';
import { WeatherMachine } from '@margoengine/weather';
import { WeatherDrive } from '@margoengine/weather/drive';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

const grid = { size: [300, 300] as [number, number], origin: [-150, -150] as [number, number], resolution: 384 };
const hills = (x: number, z: number) =>
  0.06 * z + 5 * Math.sin(x * 0.021) * Math.cos(z * 0.017) + 1.5 * Math.sin(x * 0.07 + z * 0.05);
const events: GroundEvent[] = [
  {
    kind: 'gully',
    path: [
      [-90, -110],
      [-70, -40],
      [-80, 20],
    ],
    width: 6,
    depth: 2.5,
    duration: 60,
  },
  {
    kind: 'bank',
    path: [
      [-150, 110],
      [150, 125],
    ],
    river: 'left',
    retreat: 10,
    bed: 2,
    duration: 90,
  },
  { kind: 'scour', center: [40, -30], radius: 7, depth: 3, flow: [0, 1], start: 10 },
  { kind: 'slide', from: [100, 100], to: [110, 20], width: 26, depth: 4, start: 30 },
  {
    kind: 'mud',
    shore: [
      [-150, -140],
      [150, -140],
    ],
    land: 'right',
    reach: 120,
    thickness: 0.3,
    duration: 60,
    drying: 600,
  },
  { kind: 'ash', vent: [120, -110], thickness: 0.06, half: 60, wind: [5, 2], start: 20, duration: 60 },
  {
    kind: 'lava',
    path: [
      [120, -110],
      [80, -60],
      [20, -50],
    ],
    width: 12,
    thickness: 2,
    start: 20,
    duration: 100,
    cooling: 20,
  },
  { kind: 'burn', ignition: [-60, 60], wind: [5, -1], rate: 0.5, start: 5, duration: 200, ashing: 300 },
];

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, {
    camera: { position: [0, 170, 230], target: [0, 0, -10], near: 0.5, far: 2000 },
  });
  engine.lighting.direction.set([0.5, 0.7, 0.3, 3]);
  engine.lighting.radiance.set([1, 0.97, 0.92, 0.35]);
  const ground = engine
    .createMesh()
    .setGeometry(toGeometry(heightfieldGeometry(hills, grid)))
    .setMaterial(new PbrMaterial({ color: [0.3, 0.27, 0.2], roughness: 0.9 }));
  TerrainColors.attach(engine, ground);
  const change = GroundChange.attach(engine, ground, { grid, events });
  const weather = new WeatherMachine('clear');
  WeatherDrive.attach(engine, { weather });
  let lava: number | undefined;
  engine.start();

  // The drawn grid against the exact closed form at a few points, after the frame that brings it to `time`.
  const check = async (time: number) => {
    change.setTime(time);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const n = change.side;
    let worst = 0;
    for (const [i, j] of [
      [64, 64],
      [192, 100],
      [300, 200],
      [120, 320],
      [260, 40],
    ]) {
      const x = grid.origin[0] + (i / (n - 1)) * grid.size[0],
        z = grid.origin[1] + (j / (n - 1)) * grid.size[1];
      worst = Math.max(worst, Math.abs(change.change[j * n + i] - change.sample(x, z, change.time).change));
    }
    if (worst > 1e-4) console.warn(`BUG: the ground grid is ${worst} m from the closed form at ${change.time} s`);
    say(`Film time ${change.time.toFixed(1)} s; the grid matches the closed form to ${worst.toExponential(1)} m.`);
  };
  const seek = (time: number) => () => check(time);
  button('btnStart').onclick = seek(0);
  button('btnMiddle').onclick = seek(60);
  button('btnLate').onclick = seek(300);
  button('btnLong').onclick = seek(3600);
  button('btnPlay').onclick = () => say('Playing: frames add their time to the ground.');
  button('btnStep').onclick = async () => {
    // The same time reached in frames draws the same ground as a seek to it.
    for (let t = 0; t <= 120; t += 1) change.setTime(t), change.update();
    const stepped = change.change.slice();
    change.setTime(0);
    change.update();
    change.setTime(120);
    change.update();
    const same = stepped.every((v, k) => v === change.change[k]);
    if (!same) console.warn('BUG: stepping to 120 s drew other ground than a seek to it');
    await check(120);
  };
  button('btnRain').onclick = async () => {
    weather.set('storm');
    await check(change.time);
    if (!(change.look.rain! > 0.5)) console.warn(`BUG: the storm did not wet the ground (rain ${change.look.rain})`);
  };
  button('btnLook').onclick = () => {
    applyGroundChangeSettings(change, { 'lava.glow': 20, 'ash.color': [0.45, 0.44, 0.42], 'wet.rain': null });
    say('Look rows applied: brighter lava, paler ash, rain back to the weather.');
  };
  button('btnRemove').onclick = async () => {
    // Ids follow the order the events were given in.
    lava ??= events.findIndex((e) => e.kind === 'lava');
    if (change.remove(lava)) await check(change.time);
    const vent = change.sample(120, -110);
    if (vent.lava > 0) console.warn('BUG: removed lava still covers the ground');
  };
  await check(45);
  return engine;
}

ready(start());
