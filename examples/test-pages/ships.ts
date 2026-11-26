// Ships riding the sea test page: a whole night-harbour scene for @margoengine/water/ships, using only public APIs.
// A ship (a test primitive hull of boxes, no model asset) steams a curve on a wind-raised sea with its mast-head and
// stern lamps lit and a harbour light on shore; its Kelvin wake, bow wave and foam are drawn by ShipWakes, it rides the
// swell through a Floater on WaveQuery, and a small boat rides the swell and the ship's wake, throwing bow spray through
// ShipSplash into a VFX. The buttons play, seek, step, and move the look rows; the page checks after each one that a
// seek draws the same wake as stepping there, that both hulls float, and that the lamps ride the ship.
import { ready } from './page-harness';
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { Floater, ShipSplash, ShipWakes } from '@margoengine/water/ships';
import { SHIP_LOOKS, applyShipSettings, applyWaterSettings } from '@margoengine/water/settings';
import { VFX } from '@margoengine/vfx';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

const hull = { length: 40, beam: 8, draft: 3, entrance: 22 };
// A slow turn: 6 m/s on a 300 m circle.
const course = (t: number): [number, number] => [300 * Math.sin(t / 50), 300 * (1 - Math.cos(t / 50)) - 150];

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, {
    camera: { position: [-60, 45, -170], target: [40, 0, -120], near: 0.5, far: 6000 },
  });
  // Dusk: a low cool light, so the lamps' glints read.
  engine.lighting.direction.set([0.3, 0.25, 0.2, 0.4]);
  engine.lighting.radiance.set([0.35, 0.4, 0.55, 0.06]);
  const sea = Water.attach(engine, { size: [1200, 1200], segments: 512, wind: { speed: 4, direction: [1, 0.4] } });
  const wakes = ShipWakes.attach(engine, {
    surface: sea,
    ships: [
      {
        hull,
        path: course,
        lamps: [
          { position: [0, 14, 4], intensity: 120 },
          { position: [0, 5, -19], color: [1, 1, 0.95], intensity: 60 },
        ],
      },
    ],
    lamps: [{ position: [60, 10, -260], color: [1, 0.85, 0.6], intensity: 900 }],
  });
  const ship = wakes.ships[0];
  // The test primitive hull: a box of the waterline's length and beam with a deckhouse, its origin at the waterline.
  const steel = new PbrMaterial({ color: [0.12, 0.13, 0.15], roughness: 0.6 });
  const shipHull = engine
    .createMesh()
    .setGeometry(box(hull.beam, 6, hull.length))
    .setMaterial(steel);
  const house = engine
    .createMesh()
    .setGeometry(box(6, 5, 10))
    .setMaterial(new PbrMaterial({ color: [0.7, 0.68, 0.62], roughness: 0.5 }));
  const ride = new Floater({ hull, position: [course(0)[0], 0, course(0)[1]] });
  const boat = new Floater({ hull: { length: 6, beam: 2, draft: 0.5 }, position: [30, 0, -120], heading: 80 });
  const dinghy = engine
    .createMesh()
    .setGeometry(box(2, 1, 6))
    .setMaterial(new PbrMaterial({ color: [0.6, 0.2, 0.1], roughness: 0.7 }));
  const spray = VFX.attach(engine, {
    capacity: 20000,
    rate: 0,
    size: 0.12,
    lifetime: [0.6, 1.4],
    color: [0.9, 0.95, 1, 0.8],
    turbulence: 0,
  });
  const splash = new ShipSplash({ floater: boat, particles: spray });

  let playing = false,
    query: WaveQuery | undefined,
    capturing = false,
    last = performance.now();
  // One frame: ride the last captured sea, place the meshes, draw, and capture the sea for the next frame.
  const frame = (delta: number) => {
    const p = course(wakes.time + delta);
    if (query) {
      ride.update(query, delta, { position: [p[0], 0, p[1]], heading: ship.pose.heading });
      ship.follow(ride, ship.pose.speed);
      boat.update(query, delta);
      splash.update(3);
    }
    const [hx, hy, hz] = ride.position;
    shipHull.setPosition([hx, hy, hz]).setQuaternion(ride.quaternion());
    house.setPosition([hx, hy + 5, hz]).setQuaternion(ride.quaternion());
    dinghy.setPosition(boat.position).setQuaternion(boat.quaternion());
    engine.render({ delta });
    if (!capturing) {
      capturing = true;
      void WaveQuery.capture(sea).then((q) => ((query = q), (capturing = false)));
    }
  };
  const loop = (now: number) => {
    const delta = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) frame(delta);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      frame(0);
      await WaveQuery.capture(sea).then((q) => (query = q));
    }
  };
  // Frames the ship from abeam and astern of it, so its bow wave, waterline foam and wake fill the view.
  const frameShip = () => {
    const [x, z] = course(wakes.time),
      a = (ship.pose.heading * Math.PI) / 180;
    engine.camera.position = [x - Math.sin(a) * 90 + Math.cos(a) * 60, 32, z - Math.cos(a) * 90 - Math.sin(a) * 60];
    engine.camera.target = [x, 0, z];
  };
  const check = async (what: string) => {
    frameShip();
    await settle();
    if (ride.aground || boat.aground) console.warn(`BUG: a hull found no water after ${what}`);
    if (![ride.pitch, ride.roll, boat.pitch, boat.roll].every(Number.isFinite))
      console.warn(`BUG: a hull pose is not finite after ${what}`);
    const lamps = wakes.lampPositions();
    if (lamps.length !== 3) console.warn(`BUG: ${lamps.length} lamps drawn, not 3`);
    const mast = lamps[0];
    if (Math.hypot(mast[0] - ride.position[0], mast[2] - ride.position[2]) > 20)
      console.warn('BUG: the mast-head lamp left the ship');
    say(
      `${what}: wake clock ${wakes.time.toFixed(1)} s, ship heading ${ship.pose.heading.toFixed(1)} degrees, pitch ${((ride.pitch * 180) / Math.PI).toFixed(2)}, roll ${((ride.roll * 180) / Math.PI).toFixed(2)}.`,
    );
  };
  // A point on the track a ship length behind the stern, in the turbulent wake.
  const probe = () => {
    const p = course(wakes.time - 60 / 6);
    return wakes.sample(p[0], p[1]);
  };

  button('btnPlay').onclick = () => {
    playing = !playing;
    say(playing ? 'Playing.' : 'Paused.');
  };
  button('btnSeek').onclick = async () => {
    playing = false;
    wakes.setTime(60);
    await check('Seek to 60 s');
    if (!(probe().foam > 0.2)) console.warn(`BUG: no turbulent wake behind the ship (${probe().foam})`);
  };
  button('btnStep').onclick = async () => {
    playing = false;
    wakes.setTime(60);
    const seek = probe();
    wakes.setTime(50);
    for (let i = 0; i < 300; i++) wakes.onPreUpdate(1 / 30);
    const stepped = probe();
    if (Math.abs(stepped.height - seek.height) > 1e-6 || Math.abs(stepped.foam - seek.foam) > 1e-6)
      console.warn(`BUG: stepping to 60 s drew another wake than a seek (${stepped.height} against ${seek.height})`);
    await check('Stepped to 60 s');
  };
  button('btnNight').onclick = async () => {
    applyShipSettings(wakes, SHIP_LOOKS.calmNight, splash);
    applyWaterSettings(sea, { windSpeed: 2 });
    await check('Calm night');
    if (wakes.look.lampRoughness !== SHIP_LOOKS.calmNight.lampRoughness)
      console.warn('BUG: the calm night look did not set the lamp roughness');
  };
  button('btnStorm').onclick = async () => {
    applyShipSettings(wakes, SHIP_LOOKS.heavyWeather, splash);
    applyWaterSettings(sea, { windSpeed: 16, whitecaps: null });
    await check('Heavy weather');
    if (splash.sprayRate !== 6000) console.warn('BUG: the heavy weather look did not reach the splash');
  };
  button('btnFollow').onclick = async () => {
    applyShipSettings(wakes, { lampRoughness: null });
    await check('Lamps follow the weather');
    if (wakes.look.lampRoughness !== null)
      console.warn('BUG: lampRoughness null did not hand the glints back to the wind');
  };
  wakes.setTime(30);
  await check('Start');
  return engine;
}

ready(start());
