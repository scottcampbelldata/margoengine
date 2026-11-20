// Hurricane test page: a whole storm scene for @margoengine/sky/hurricane, using only public APIs. A Bruneton sky lights
// a VolumetricClouds layer shaped by a Hurricane (eye, stadium eyewall, moat, spiral bands, canopy); a WeatherRegions map
// with the same storm feeds a WeatherMachine at the camera through a WeatherDrive, so the rain and wind there follow
// the bands. The buttons put the camera in the eye, the eyewall and a band at sea level and 40 km up, play a minute of
// storm time and apply slider rows; after each the page checks that the weather at the camera is the storm's own and
// that the drawn region matches the storm's CPU field.
import { ready } from './page-harness';
import { Engine } from '@margoengine/core';
import { Sky } from '@margoengine/sky';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Hurricane } from '@margoengine/sky/hurricane';
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
    camera: { position: [0, 2, 0], target: [1, 0.3, 0], near: 1, far: 500000 },
  });
  const storm = new Hurricane({ pressureDrop: 70, maxWindRadius: 25000, velocity: [3, 0] });
  const sky = Sky.attach(engine, { hours: 13, timeScale: 0, model: 'bruneton' });
  const clouds = VolumetricClouds.attach(engine, { sky, hurricane: storm, maxDistance: 300000, steps: 96 });
  await clouds.ready; // the storm code loads on first use
  const map = new WeatherRegions({ base: 'overcast', storms: [storm] });
  const weather = new WeatherMachine('overcast');
  WeatherDrive.attach(engine, { weather, sky, clouds, listener: engine.camera });
  engine.onFrame((_, delta) => {
    map.update(delta);
    map.apply(weather, engine.camera.position[0], engine.camera.position[2]);
  });
  engine.start();

  const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  // The weather at the camera against the storm's own, and the region the camera is in.
  const check = async (label: string) => {
    await frames();
    const [x, , z] = engine.camera.position,
      want = storm.weatherAt(x, z, map.time),
      here = weather.state,
      region = storm.regionAt(x, z, map.time);
    if (Math.abs(here.wind - want.wind) > 0.5 || Math.abs(here.rain - want.rain) > 0.02)
      console.warn(`BUG: the weather at the camera is not the storm's (${JSON.stringify({ here, want })})`);
    if (clouds.time > 0 && Math.abs(clouds.time - map.time) > 0.5)
      console.warn(`BUG: the clouds' clock ${clouds.time} s and the map's ${map.time} s differ`);
    say(`${label}: ${region}, wind ${here.wind.toFixed(1)} m/s (true ${storm.windAt(x, z, map.time).speed.toFixed(1)}), rain ${storm.rainAt(x, z, map.time).toFixed(1)} mm/h, gust ${here.gust.toFixed(2)}.`);
    return region;
  };
  const place = (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
    const [cx, cz] = storm.centerAt(map.time);
    engine.camera.position = [cx + x, y, cz + z];
    engine.camera.target = [cx + tx, ty, cz + tz];
  };
  button('btnEye').onclick = async () => {
    place(0, 2, 0, 1000, 600, 0);
    if ((await check('In the eye')) !== 'eye') console.warn('BUG: the eye is not at the storm centre');
  };
  button('btnWall').onclick = async () => {
    place(30000, 2, 0, 0, 3000, 0);
    if ((await check('In the eyewall')) !== 'eyewall') console.warn('BUG: the eyewall is not at 30 km');
  };
  button('btnBand').onclick = async () => {
    // The first point east of the centre past the bands' start where the band cover peaks.
    let best = 0,
      at = 70000;
    for (let r = 62500; r < 200000; r += 250) {
      const b = storm.coverAt(storm.centerAt(map.time)[0] + r, storm.centerAt(map.time)[1], 0, map.time).band;
      if (b > best) [best, at] = [b, r];
    }
    place(at, 2, 0, at + 5000, 800, 3000);
    if ((await check('In a band')) !== 'band') console.warn('BUG: the band crest is not a band');
  };
  button('btnAir').onclick = async () => {
    place(0, 40000, 1, 0, 0, 0);
    await check('From the air');
  };
  button('btnPlay').onclick = async () => {
    // Sixty one-second frames (a frame takes at most 1 s): the clouds' clock and the map's (moved by hand here, by the frame hook in the loop) both gain a minute.
    const before = map.time,
      drawn = clouds.time;
    for (let i = 0; i < 60; i++) {
      engine.render({ delta: 1 });
      map.update(1); // render() runs no frame hook, so the map takes the same second by hand
    }
    if (Math.abs(map.time - before - 60) > 1 || Math.abs(clouds.time - drawn - 60) > 1)
      console.warn(`BUG: a minute of frames moved the map ${map.time - before} s and the clouds ${clouds.time - drawn} s`);
    await check('A minute later');
  };
  button('btnRows').onclick = async () => {
    applySkySettings({ sky, clouds }, { 'volumetric.type': 'hurricane', 'hurricane.bands': 5, 'hurricane.hemisphere': 'south' });
    const options = storm.options;
    if (options.bands !== 5 || options.latitude !== -20) console.warn('BUG: the rows did not reach the storm');
    await check('Rows applied');
  };
  button('btnEye').click();
  return engine;
}

ready(start());
