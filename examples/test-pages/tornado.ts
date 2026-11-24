// Tornado test page: a whole storm scene for @margoengine/sky/tornado, using only public APIs. A Bruneton sky lights a
// supercell's storm deck (VolumetricClouds, type 'storm', its base at the tornado's cloud base) with the tornado under
// it (TornadoCloud: funnel, wall cloud, turning base, debris cloud) crossing the ground along a path; a WeatherRegions
// map with the same tornado feeds a WeatherMachine at the camera through a WeatherDrive, so the wind and rain there
// follow the vortex. The buttons put the camera in the inflow, on the rear flank and near the core, play a minute,
// turn the funnel from a rope to a wedge with slider rows, and check after each that the weather at the camera is the
// tornado's own and that the drawn region matches its CPU field.
import { ready } from './page-harness';
import { Engine } from '@margoengine/core';
import { Sky } from '@margoengine/sky';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Tornado, TornadoCloud } from '@margoengine/sky/tornado';
import { applySkySettings } from '@margoengine/sky/settings';
import { WeatherMachine } from '@margoengine/weather';
import { WeatherRegions } from '@margoengine/weather/regions';
import { WeatherDrive } from '@margoengine/weather/drive';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, {
    camera: { position: [0, 2, 4000], target: [0, 400, 0], near: 1, far: 200000 },
  });
  const twister = new Tornado({
    path: [
      [0, -1500, 0],
      [120, 0, -200],
      [240, 1500, 0],
    ],
    pressureDrop: 85,
    coreRadius: 160,
    meander: 40,
  });
  const sky = Sky.attach(engine, { hours: 17, timeScale: 0, model: 'bruneton' });
  const clouds = VolumetricClouds.attach(engine, { sky, type: 'storm', bottom: 1000, maxDistance: 120000, steps: 96 });
  const storm = TornadoCloud.attach(engine, { tornado: twister, sky });
  await storm.ready; // the tornado's shader loads on first use
  const map = new WeatherRegions({ base: 'storm', storms: [twister] });
  const weather = new WeatherMachine('storm');
  WeatherDrive.attach(engine, { weather, sky, clouds, listener: engine.camera });
  engine.onFrame((_, delta) => {
    map.update(delta);
    map.apply(weather, engine.camera.position[0], engine.camera.position[2]);
  });
  engine.start();

  const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const check = async (label: string) => {
    await frames();
    const [x, , z] = engine.camera.position,
      want = twister.weatherAt(x, z, map.time),
      here = weather.state,
      region = twister.regionAt(x, z, map.time);
    if (Math.abs(here.wind - want.wind) > 0.5 || Math.abs(here.rain - want.rain) > 0.02)
      console.warn(`BUG: the weather at the camera is not the tornado's (${JSON.stringify({ here, want })})`);
    if (Math.abs(storm.time - map.time) > 0.5)
      console.warn(`BUG: the tornado's clock ${storm.time} s and the map's ${map.time} s differ`);
    say(
      `${label}: ${region}, wind ${here.wind.toFixed(1)} m/s (true ${twister.windAt(x, z, map.time).speed.toFixed(1)}), rain ${twister.rainAt(x, z, map.time).toFixed(1)} mm/h, pressure ${twister.pressureAt(x, z, map.time).toFixed(1)} hPa, funnel ${(2 * twister.funnelRadiusAt(0, map.time)).toFixed(0)} m wide at the ground.`,
    );
    return region;
  };
  const place = (x: number, y: number, z: number) => {
    const [cx, cz] = twister.centerAt(map.time);
    engine.camera.position = [cx + x, y, cz + z];
    engine.camera.target = [cx, 400, cz];
  };
  button('btnInflow').onclick = async () => {
    // The inflow: 4 km ahead of the motion (the rain curtain wraps round the sides and the back).
    const m = twister.motionAt(map.time),
      l = Math.hypot(m[0], m[1]) || 1;
    place((m[0] / l) * 4000, 2, (m[1] / l) * 4000);
    if ((await check('In the inflow')) !== 'inflow') console.warn('BUG: 4 km ahead is not the inflow');
  };
  button('btnRear').onclick = async () => {
    // The rear flank: two wall-cloud radii behind the motion.
    const m = twister.motionAt(map.time),
      l = Math.hypot(m[0], m[1]) || 1,
      r = 2 * twister.resolved.wallRadius;
    place((-m[0] / l) * r, 2, (-m[1] / l) * r);
    if ((await check('On the rear flank')) !== 'rearFlank') console.warn('BUG: the rear flank has no rain');
  };
  button('btnCore').onclick = async () => {
    place(250, 2, 0);
    await check('Beside the core');
  };
  button('btnPlay').onclick = async () => {
    const before = map.time,
      drawn = storm.time;
    for (let i = 0; i < 60; i++) {
      engine.render({ delta: 1 });
      map.update(1); // render() runs no frame hook, so the map takes the same second by hand
    }
    if (Math.abs(map.time - before - 60) > 1 || Math.abs(storm.time - drawn - 60) > 1)
      console.warn(`BUG: a minute of frames moved the map ${map.time - before} s and the tornado ${storm.time - drawn} s`);
    await check('A minute later');
  };
  button('btnRope').onclick = async () => {
    applySkySettings({ sky, tornado: storm }, { 'tornado.coreRadius': 35, 'tornado.pressureDrop': 75, 'tornado.meander': 120 });
    if (twister.options.coreRadius !== 35) console.warn('BUG: the rows did not reach the tornado');
    await check('A rope');
  };
  button('btnWedge').onclick = async () => {
    applySkySettings({ sky, tornado: storm }, { 'tornado.coreRadius': 500, 'tornado.pressureDrop': 120 });
    if (!(twister.funnelRadiusAt(0) > 300)) console.warn('BUG: a wedge is not wide at the ground');
    await check('A wedge');
  };
  button('btnInflow').click();
  return engine;
}

ready(start());
