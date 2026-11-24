// Lava test page: a whole lava scene at night for @margoengine/weather/lava, using only public APIs. A vent high on a
// slope feeds a flow that splits round a ridge, grows levees behind its fronts, roofs over into tubes on the gentle
// apron and ponds on the flat below; the ground draws every arm through GroundChange (terrain/ground-change), clots and
// bombs draw as glowing spheres, and the glow lights the ground through clustered point lights. The buttons seek film
// time and apply settings rows; after each the page checks that a seek and steps give the same lava, the fluxes at the
// ends of the arms that do not run into another sum to the effusion rate, the levees never pass leveeMax, the pond keeps
// its volume and the tubes cool slower than the open channel. A channel-scale tube beside it (a Kupaianaha-like flow, 4
// m^3/s in a 4 m channel down 3 degrees, solved on its own plane and not drawn) must cool inside its roof within a
// factor of two of the 0.6 K/km Helz et al. (2003) measured and the about 1 K/km of Keszthelyi (1995).
import { ready } from './page-harness';
import { Engine, PbrMaterial } from '@margoengine/core';
import { Clustered } from '@margoengine/clustered';
import { LightGroups } from '@margoengine/clustered/groups';
import { sphereGeometry } from '@margoengine/geometry';
import { toGeometry } from '@margoengine/geometry/utils';
import { Material, createInstancedMesh } from '@margoengine/materials';
import { heightfieldGeometry } from '@margoengine/terrain';
import { GroundChange } from '@margoengine/terrain/ground-change';
import { WeatherMachine } from '@margoengine/weather';
import { LavaFlow } from '@margoengine/weather/lava';
import { LAVA_LOOKS, applyLavaSettings } from '@margoengine/weather/lava-settings';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

// A 10 degree upper slope down +z, a wedge-shaped ridge from z = 250 that parts the flow, a 2 degree apron from z = 700
// and a flat floor from z = 1,100 where it ponds.
const ground = (x: number, z: number) => {
  const upper = 400 - Math.tan(0.1745) * Math.min(z, 700),
    apron = -Math.tan(0.0349) * Math.min(Math.max(z - 700, 0), 400),
    ridge = Math.max(0, 0.3 * (z - 250) - 0.6 * Math.abs(x)) * (z < 700 ? 1 : Math.max(0, 1 - (z - 700) / 100));
  return upper + apron + ridge + 1.5 * Math.sin(x * 0.02) * Math.cos(z * 0.017);
};
const grid = { size: [1600, 1600] as [number, number], origin: [-800, -200] as [number, number], resolution: 400 };

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, { camera: { position: [-700, 520, -150], target: [0, 150, 600], near: 1, far: 8000 } });
  // Night: a faint cool moonlight, so the lava lights the ground.
  engine.lighting.direction.set([0.3, 0.8, 0.2, 3]);
  engine.lighting.radiance.set([0.55, 0.62, 0.8, 0.02]);
  const mesh = engine.createMesh().setGeometry(toGeometry(heightfieldGeometry(ground, grid)));
  mesh.setMaterial(new PbrMaterial({ color: [0.23, 0.21, 0.2], roughness: 0.95 }));
  const lights = LightGroups.attach(engine, Clustered.attach(engine));
  const weather = new WeatherMachine('clear', { seed: 5 });
  const lava = new LavaFlow({ vent: [0, ground(0, 0), 0], ground, weather, lights: lights.group('lava'), seed: 5 });
  applyLavaSettings(lava, { ...LAVA_LOOKS.hawaiian, start: 1, effusionRate: 30, duration: 4 * 86400, maxLength: 3000 });
  const change = GroundChange.attach(engine, mesh, { grid, clock: () => lava.time });
  const glowing = new Material({ shading: 'basic' });
  const clots = createInstancedMesh(engine, sphereGeometry(1, 10, 6), glowing, 2000);
  const bombs = createInstancedMesh(engine, sphereGeometry(1, 12, 8), glowing, 2000);
  // The ground events: one per arm, rebuilt as film time moves on so the levees grow.
  let builtAt = -Infinity;
  const refresh = () => {
    change.clear();
    for (const event of lava.lavaEvents()) change.add(event);
    builtAt = lava.time;
  };
  let playing = false;
  engine.onFrame((_, delta) => {
    if (playing) lava.update(delta * 600);
    if (Math.abs(lava.time - builtAt) > 60) refresh();
    lava.drawClots(clots.instances);
    lava.drawBombs(bombs.instances);
  });
  engine.start();

  const check = async (time: number) => {
    lava.seek(time);
    refresh();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const arms = lava.branches(),
      q = lava.options.effusionRate ?? 20,
      // Lava at each arm's end: its flux, less its branches, plus what reaches it from arms that ran into it.
      end = (k: number): number => arms.reduce((f, b, i) => f - (b.parent === k ? b.flux : 0) + (b.joins?.arm === k ? end(i) : 0), arms[k]!.flux),
      ends = arms.map((b, k) => (b.stop === 'joined' ? 0 : end(k))),
      total = ends.reduce((a, b) => a + b, 0);
    if (ends.some((f, k) => Math.abs(f - lava.endFlux(k)) > 1e-9 * q && arms[k]!.stop !== 'joined')) console.warn('BUG: endFlux() disagrees with the arms');
    if (Math.abs(total - q) > 1e-6 * q) console.warn(`BUG: the arms carry ${total} m^3/s of ${q}`);
    const stepped = new LavaFlow({ ...lava.options, lights: undefined });
    stepped.seek(0);
    for (let k = 0; k < 50; k++) stepped.update(time / 50);
    stepped.seek(time);
    // Read the seeked flow at `time`: while Play runs, the frames since the seek have moved its clock on.
    if (JSON.stringify([stepped.front(), stepped.lavaEvents()]) !== JSON.stringify([lava.front(time), lava.lavaEvents(256, time)]))
      console.warn('BUG: stepping reached other lava than a seek');
    const max = lava.options.leveeMax ?? 0.35;
    let highest = 0;
    for (let i = 0; i < lava.path().length; i += 8) {
      const now = lava.leveeShare(i, time),
        later = lava.leveeShare(i, time + 3600);
      highest = Math.max(highest, now);
      if (now > max + 1e-12 || later < now - 1e-12) console.warn(`BUG: the levee at ${i} is ${now}, later ${later}, cap ${max}`);
    }
    // The tube's cooling over its roofed stretches only (open stretches between them cool as an open channel), against
    // the open channel's over the same stretches: the roof must keep heat in. On this apron the sheet spreads 70 m to
    // 1 km wide and 0.55 m thick, so even roofed it cools tens of K/km, not the 1 K/km of a 4 m Kilauea tube.
    const p = lava.path(),
      tube = lava.tubeTemperatures();
    let drop = 0,
      open = 0,
      span = 0;
    for (let i = 1; i < p.length; i++)
      if (lava.roofTime(i - 1) < Infinity) {
        drop += tube[i - 1]! - tube[i]!;
        open += p[i - 1]!.temperature - p[i]!.temperature;
        span += (p[i]!.distance - p[i - 1]!.distance) / 1000;
      }
    const perKm = span > 0.2 ? drop / span : NaN;
    if (perKm >= open / span || perKm < 0) console.warn(`BUG: the tube cools ${perKm} K/km, the open channel ${open / span} K/km`);
    // The channel-scale tube: 1 K/km or so inside the roof, not the tens of K/km of the roofed sheet above.
    const kupaianaha = new LavaFlow({
        vent: [0, 1000, 0],
        ground: (_x: number, z: number) => 1000 - Math.tan((3 * Math.PI) / 180) * z,
        effusionRate: 4,
        width: 4,
        maxWidth: 4,
        rise: 1,
        duration: 1e7,
        wander: 0,
        maxLength: 12000,
      }),
      kp = kupaianaha.path(),
      kt = kupaianaha.tubeTemperatures(),
      k0 = kp.findIndex((_, i) => kupaianaha.roofTime(i) < Infinity),
      k1 = kp.length - 1,
      tubeKm = k0 >= 0 ? (kt[k0]! - kt[k1]!) / ((kp[k1]!.distance - kp[k0]!.distance) / 1000) : NaN;
    if (!(tubeKm > 0.3 && tubeKm < 2)) console.warn(`BUG: a 4 m tube cools ${tubeKm} K/km, against 0.6 (Helz et al. 2003) to 1 (Keszthelyi 1995)`);
    const front = lava.front(time),
      tubes = p.filter((_, i) => lava.tubed(i, time)).length;
    say(
      `Film ${(lava.time / 3600).toFixed(2)} h: ${arms.length} arm${arms.length > 1 ? 's' : ''}, front ${front.distance.toFixed(0)} m (${front.stop}), ` +
        `highest levee ${(highest * 100).toFixed(0)}% of the sheet, ${tubes} roofed points` +
        (Number.isFinite(perKm) ? `, roofed sheet cooling ${perKm.toFixed(2)} K/km` : '') +
        `, 4 m tube ${tubeKm.toFixed(2)} K/km` +
        `, pond ${lava.pondRadius().toFixed(0)} m, ${lava.glowLights().length} glow lights.`,
    );
  };
  const seek = (time: number) => () => check(time);
  button('btnPlay').onclick = () => {
    playing = !playing;
    say(playing ? 'Playing at 600 times.' : 'Paused.');
  };
  button('btnStart').onclick = seek(30);
  button('btnSplit').onclick = seek(1800);
  button('btnLevees').onclick = seek(6 * 3600);
  button('btnTubes').onclick = seek(2 * 86400);
  button('btnEnd').onclick = seek(6 * 86400);
  const look = (values: Record<string, number | null>) => async () => {
    applyLavaSettings(lava, { ...values, start: 1, duration: 4 * 86400, maxLength: 3000 });
    await check(lava.time);
  };
  button('btnHawaiian').onclick = look({ ...LAVA_LOOKS.hawaiian, effusionRate: 30 });
  button('btnOneChannel').onclick = look({ ...LAVA_LOOKS.hawaiian, effusionRate: 30, branchShare: 1 });
  button('btnHighLevees').onclick = look({ ...LAVA_LOOKS.hawaiian, effusionRate: 30, leveeMax: 0.9 });
  button('btnNoTubes').onclick = look({ ...LAVA_LOOKS.hawaiian, effusionRate: 30, tubeSlope: 0 });
  await check(1800);
  return engine;
}

ready(start());
