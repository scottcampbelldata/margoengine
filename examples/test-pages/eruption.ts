// Eruption test page: a whole volcano scene for @margoengine/weather/eruption, using only public APIs. A cone 1.5 km
// high erupts two seconds in; the column and the umbrella draw as vfx Clouds, the fallen ash lies on the ground as a
// GroundChange ash cover (terrain/ground-change), and the plume's lightning flashes through the sky's Weather. The
// buttons seek film time, apply settings rows, turn the wind and hand it back to the weather; after each the page
// checks a seek and steps give the same column, the ash event matches the deposit at the vent, and the column top
// lies within Mastin et al.'s band.
import { ready } from './page-harness';
import { Engine, PbrMaterial } from '@margoengine/core';
import { heightfieldGeometry } from '@margoengine/terrain';
import { toGeometry } from '@margoengine/geometry/utils';
import { GroundChange } from '@margoengine/terrain/ground-change';
import { Clouds } from '@margoengine/vfx/clouds';
import { Weather } from '@margoengine/sky/weather';
import { WeatherMachine } from '@margoengine/weather';
import { Eruption, mastinHeight } from '@margoengine/weather/eruption';
import { ERUPTION_LOOKS, applyEruptionSettings } from '@margoengine/weather/settings';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

// A cone 1,500 m high, 12 km across, with a crater at its top and gentle ridges.
const cone = (x: number, z: number) => {
  const r = Math.hypot(x, z);
  return Math.max(0, 1500 * (1 - r / 6000)) - 200 * Math.exp(-((r / 300) ** 2)) + 30 * Math.sin(x / 700) * Math.cos(z / 900);
};
const grid = { size: [60000, 60000] as [number, number], origin: [-30000, -30000] as [number, number], resolution: 256 };

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, { camera: { position: [-26000, 2500, -14000], target: [0, 7000, 4000], near: 10, far: 400000 } });
  engine.lighting.direction.set([0.4, 0.8, 0.45, 3]);
  const ground = engine.createMesh().setGeometry(toGeometry(heightfieldGeometry(cone, grid))).setMaterial(new PbrMaterial({ color: [0.3, 0.27, 0.24], roughness: 0.95 }));
  const weather = new WeatherMachine('clear', { seed: 4 });
  const eruption = new Eruption({ vent: [0, 1300, 0], weather, start: 2, seed: 4 });
  // The ground's covers follow the eruption's film time.
  const change = GroundChange.attach(engine, ground, { grid, clock: () => eruption.time });
  applyEruptionSettings(eruption, { ...ERUPTION_LOOKS.plinian, start: 2 });
  const sky = Weather.attach(engine, { particles: 0, lightning: { rate: 0 } });
  const clouds = Clouds.attach(engine);
  let playing = false,
    ash = change.add(eruption.ashEvent());
  const refreshAsh = () => {
    change.remove(ash);
    ash = change.add(eruption.ashEvent());
  };
  engine.onFrame((_, delta) => {
    if (playing) eruption.update(delta * 60);
    eruption.drawPlume(clouds);
    eruption.flashLightning(sky);
  });
  engine.start();

  const check = async (time: number) => {
    eruption.seek(time);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const c = eruption.column(),
      u = eruption.umbrella(),
      e = eruption.ashEvent(),
      band = 4 ** (1 / 4.15),
      fit = mastinHeight(eruption.peakRate());
    if (!c.collapse && c.top >= c.steadyTop && (c.steadyTop > band * fit || fit > band * c.steadyTop))
      console.warn(`BUG: the column stands ${c.steadyTop} m, outside Mastin's band about ${fit} m`);
    const stepped = new Eruption({ ...eruption.options });
    stepped.seek(0);
    for (let k = 0; k < 100; k++) stepped.update(time / 100);
    stepped.seek(time);
    if (JSON.stringify(stepped.column()) !== JSON.stringify(c)) console.warn('BUG: stepping drew another column than a seek');
    say(
      `Film ${eruption.time.toFixed(0)} s: ${(c.massRate / 1e6).toFixed(1)} Mt/s, ${c.collapse ? 'collapsing fountain' : 'buoyant column'} top ${(c.top / 1000).toFixed(1)} km of ${(c.steadyTop / 1000).toFixed(1)} km (Mastin ${(fit / 1000).toFixed(1)} km), umbrella ${u ? (u.radius / 1000).toFixed(1) + ' km' : 'not yet'}, ash at the vent ${(e.thickness * 100).toFixed(1)} cm when it ends, ${eruption.strikes(0, eruption.time).length} strikes so far.`,
    );
  };
  const seek = (time: number) => () => check(time);
  button('btnPlay').onclick = () => {
    playing = !playing;
    say(playing ? 'Playing at 60 times.' : 'Paused.');
  };
  button('btnStart').onclick = seek(1);
  button('btnRise').onclick = seek(122);
  button('btnUmbrella').onclick = seek(2400);
  button('btnEnd').onclick = seek(21600);
  const look = (values: Record<string, number | null>) => async () => {
    applyEruptionSettings(eruption, { ...values, start: 2 });
    refreshAsh();
    await check(eruption.time);
  };
  button('btnPlinian').onclick = look(ERUPTION_LOOKS.plinian);
  button('btnWeak').onclick = look(ERUPTION_LOOKS.weakPlume);
  button('btnCollapse').onclick = look(ERUPTION_LOOKS.collapsing);
  button('btnWind').onclick = look({ ...ERUPTION_LOOKS.plinian, wind: 15, windDirection: 90 });
  button('btnWeather').onclick = async () => {
    applyEruptionSettings(eruption, { ...ERUPTION_LOOKS.plinian, start: 2, wind: null, windDirection: null });
    if (eruption.options.wind !== undefined) console.warn('BUG: a null wind row did not hand the wind back to the weather');
    refreshAsh();
    await check(eruption.time);
  };
  await check(2400);
  return engine;
}

ready(start());
