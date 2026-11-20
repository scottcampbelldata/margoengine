// Air load test page: smoke, ash and sea spray in the weather of @margoengine/weather, using only public APIs. A coast
// (a ground and a row of headland pillars beside a Water sea to the horizon) under a Sky whose fog follows a
// WeatherDrive; the drive takes spray from the sea's wind, thicker near a surf line, ash from an Eruption attached 40
// km upwind, and smoke from the weather rows. The buttons apply the weather looks, walk the camera to the breakers and
// out to sea, start the eruption and blow its ash over the coast; after each the page checks that the visibility the
// drive reports is Koschmieder's over the load, that the sun is dimmed grey by ash and spray and reddened by smoke, and
// that with no load the sky's fog and sun are untouched.
import { ready } from './page-harness';
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Sky } from '@margoengine/sky';
import { Water } from '@margoengine/water';
import { PostStack } from '@margoengine/post/stack';
import { Tonemap } from '@margoengine/tonemap';
import { WeatherMachine, airExtinction, visibility } from '@margoengine/weather';
import { WeatherDrive } from '@margoengine/weather/drive';
import { Eruption } from '@margoengine/weather/eruption';
import { WEATHER_LOOKS, applyWeatherSettings } from '@margoengine/weather/settings';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, { camera: { position: [0, 6, -400], target: [0, 4, 2000], near: 0.5, far: 100000 } });
  const stack = PostStack.attach(engine, [new Tonemap()]);
  // Land south of z = 0, the sea north of it; the breakers run along z = 60.
  engine.createMesh().setGeometry(box(6000, 2, 3000)).setMaterial(new PbrMaterial({ color: '#7a7058', roughness: 0.95 })).setPosition([0, -1, -1500]);
  for (const [x, z] of [[-300, -200], [250, -600], [-120, -1000], [400, -1500]])
    engine.createMesh().setGeometry(box(30, 80, 30)).setMaterial(new PbrMaterial({ color: '#8d8270', roughness: 0.8 })).setPosition([x, 40, z]);
  Water.attach(engine, { size: [6000, 6000], segments: 64, horizon: true });
  const sky = new Sky({ hours: 15, timeScale: 0, lighting: {}, atmosphere: {}, fog: { depth: () => stack.depthTexture, falloff: 'exp', start: 0 } });
  engine.use(sky);
  const weather = new WeatherMachine('clear', { seed: 5 });
  const surf: [number, number][] = [[-3000, 60], [3000, 60]];
  const drive = WeatherDrive.attach(engine, { weather, listener: engine.camera, surf });
  // A Plinian eruption 40 km to the south; the wind carries its ash north over the coast.
  const eruption = Eruption.attach(engine, { vent: [0, 0, -40000], start: 1e9, weather, seed: 5 });
  engine.start();

  const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const check = async (label: string) => {
    await settle();
    const s = drive.settings!,
      state = { ...weather.state, ash: s.ash, spray: s.spray, smoke: s.smoke, dust: s.dust },
      want = visibility(state),
      sun = sky.options.atmosphere?.sunColor,
      fog = sky.options.fog?.color;
    if (Math.abs(s.visibility / want - 1) > 1e-9) console.warn(`BUG: the drive reports ${s.visibility} m, Koschmieder over the load gives ${want} m`);
    if (Math.abs(airExtinction(state) * s.visibility - 3.912) > 1e-6) console.warn('BUG: visibility is not 3.912 over the extinction');
    const load = s.smoke + s.ash + s.spray;
    if (load === 0 && sun !== undefined) console.warn('BUG: no smoke, ash or spray, yet the sun colour was written');
    if (sun && s.smoke === 0 && (sun[0] !== sun[1] || sun[1] !== sun[2])) console.warn(`BUG: ash and spray must dim the sun grey, got ${sun}`);
    if (sun && s.smoke > 0 && !(sun[0] > sun[2])) console.warn(`BUG: smoke must redden the sun, got ${sun}`);
    say(
      `${label}: visibility ${(s.visibility / 1000).toFixed(2)} km; smoke ${s.smoke.toFixed(2)}, ash ${s.ash.toFixed(2)}, spray ${s.spray.toFixed(2)}; sun ${sun ? sun.map((v) => v.toFixed(2)).join(' ') : 'untouched'}; fog ${fog ? fog.map((v) => v.toFixed(2)).join(' ') : 'its own colour'}.`,
    );
  };
  const look = (label: string, values: Record<string, number | null>) => async () => {
    applyWeatherSettings(weather, values);
    await check(label);
  };
  const place = (label: string, z: number) => async () => {
    engine.camera.position = [0, 6, z];
    engine.camera.target = [0, 4, z + 2400];
    await check(label);
  };
  button('btnClear').onclick = look('Clear', {});
  button('btnSea').onclick = look('Sea spray', WEATHER_LOOKS.seaSpray);
  button('btnSurf').onclick = look('Surf haze', WEATHER_LOOKS.surfHaze);
  button('btnGale').onclick = look('A gale off the sea, spray from the wind', { storm: 0, wind: 22, gust: 0.5, cloud: 0.5 });
  button('btnBreakers').onclick = place('At the breakers', 40);
  button('btnInland').onclick = place('8 km inland', -8000);
  button('btnSmoke').onclick = look('Wildfire smoke', WEATHER_LOOKS.wildfireSmoke);
  button('btnAsh').onclick = look('Ash fall', WEATHER_LOOKS.ashfall);
  button('btnDark').onclick = look('Darkness at noon', WEATHER_LOOKS.ashDarkness);
  button('btnErupt').onclick = async () => {
    applyWeatherSettings(weather, { storm: 0, wind: 12, windDirection: 0, gust: 0.2 });
    eruption.options.start = 0;
    eruption.seek(5400);
    await check('Ninety minutes into the eruption, its ash over the coast');
    if (!(drive.settings!.ash > 0)) console.warn('BUG: the eruption upwind left no ash at the camera');
  };
  await check('Clear');
  return engine;
}

ready(start());
