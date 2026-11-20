// Iceberg and sea ice test page: a whole night North Atlantic scene for @margoengine/water/ice, using only public APIs.
// A glacial berg (a test-page shape, no model asset) floats at its own waterline on a wind-raised sea under a low moon,
// riding the swell through an Iceberg; its IceMaterial is wet as high as the waves reach and notched at the waterline;
// BergFoam whitens the water round it and BergSpray throws spray off its weather face into a VFX; a field of pancake
// ice and brash and a few floes ride the swell and drift with the wind. The buttons play, seek, step and move the look
// rows; the page checks after each one that the berg floats at the density ratio, that a seek lays out the same sea
// ice as stepping there, and that the rows reach their targets.
import { ready } from './page-harness';
import { Engine } from '@margoengine/core';
import { createInstancedMesh, createMesh } from '@margoengine/materials';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { BergFoam, BergSpray, IceMaterial, Iceberg, SeaIce } from '@margoengine/water/ice';
import { ICE_LOOKS, applyIceSettings, applyWaterSettings } from '@margoengine/water/settings';
import { VFX } from '@margoengine/vfx';
import { bergShape, brashShape, floeShape, pancakeShape } from './ice-shapes';

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, {
    camera: { position: [-160, 40, -150], target: [0, 15, 0], near: 0.5, far: 8000 },
  });
  // A low moon behind the berg, so the light shows through its edges.
  engine.lighting.direction.set([0.45, 0.35, 0.8, 1.2]);
  engine.lighting.radiance.set([0.55, 0.62, 0.8, 0.08]);
  const sea = Water.attach(engine, { size: [1600, 1600], segments: 512, wind: { speed: 9, direction: [1, 0.25] } });

  const shape = bergShape(160, 80);
  const ice = new IceMaterial();
  const berg = new Iceberg({ mesh: shape, material: ice, heading: 30 });
  const bergMesh = createMesh(engine, shape, ice);
  const foam = BergFoam.attach(engine, { surface: sea, bergs: [berg] });
  const vfx = VFX.attach(engine, { capacity: 20000, rate: 0, size: 0.2, lifetime: [0.8, 2], color: [0.9, 0.95, 1, 0.8], turbulence: 0 });
  const spray = new BergSpray({ berg, particles: vfx, waveDirection: [1, 0.25] });

  // Sea ice: pancakes and brash downwind of the berg, floes beyond.
  const wind = { speed: 9, direction: [1, 0.25] as [number, number] };
  const fields = [
    { field: new SeaIce({ kind: 'pancake', centre: [120, 40], size: [160, 160], wind, seed: 1, maxPieces: 12000 }), shape: pancakeShape() },
    { field: new SeaIce({ kind: 'brash', centre: [70, -30], size: [60, 60], wind, seed: 2 }), shape: brashShape() },
    { field: new SeaIce({ kind: 'floe', centre: [420, 0], size: [500, 500], wind, seed: 3 }), shape: floeShape() },
  ];
  const seaIce = new IceMaterial({ notch: false, look: { wetHeight: 0.15, scallopDepth: 0.1, blueIce: 0.1, subsurface: 0.5 } });
  const instanced = fields.map(({ field, shape }) => createInstancedMesh(engine, shape, seaIce, field.pieces.length));

  let playing = false,
    query: WaveQuery | undefined,
    capturing = false,
    last = performance.now();
  const frame = (delta: number) => {
    if (query) {
      berg.update(query, delta);
      spray.update(query, delta);
      fields.forEach(({ field }, i) => field.update(query!, delta).writeInstances(instanced[i].instances));
    } else for (const { field } of fields) field.setTime(field.time + delta);
    bergMesh.root.setPosition(berg.position);
    bergMesh.root.setQuaternion(berg.quaternion());
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
  const check = async (what: string) => {
    await settle();
    const b = berg.buoyancy;
    if (Math.abs(b.submergedFraction - 900 / 1027) > 1e-6) console.warn(`BUG: the berg floats with ${b.submergedFraction} under water, not 900 / 1027`);
    if (berg.floater.aground) console.warn(`BUG: the berg found no water after ${what}`);
    const water = query?.heightAt(berg.floater.position[0], berg.floater.position[2]);
    if (water !== undefined && Math.abs(berg.floater.position[1] - water) > 3) console.warn(`BUG: the berg's waterline is ${berg.floater.position[1]} m against the sea's ${water} m`);
    say(
      `${what}: ${(b.submergedFraction * 100).toFixed(1)}% under water, draft ${b.draft.toFixed(1)} m, freeboard ${b.freeboard.toFixed(1)} m, ` +
        `${b.stable ? 'stable' : 'UNSTABLE'} (GM roll ${b.rollMetacentricHeight.toFixed(1)} m, pitch ${b.pitchMetacentricHeight.toFixed(1)} m), sea ice clock ${fields[0].field.time.toFixed(1)} s, ` +
        `${fields.map((f) => f.field.pieces.length).join(' / ')} pancakes / brash / floes.`,
    );
  };

  button('btnPlay').onclick = () => {
    playing = !playing;
    say(playing ? 'Playing.' : 'Paused.');
  };
  button('btnSeek').onclick = async () => {
    playing = false;
    for (const { field } of fields) field.setTime(60);
    await check('Seek to 60 s');
  };
  button('btnStep').onclick = async () => {
    playing = false;
    const probe = new SeaIce({ kind: 'pancake', centre: [120, 40], size: [160, 160], wind, seed: 1, maxPieces: 12000 });
    const flat = { sample: () => ({ height: 0 }) };
    probe.setTime(50);
    for (let i = 0; i < 300; i++) probe.update(flat, 1 / 30);
    const seek = new SeaIce({ kind: 'pancake', centre: [120, 40], size: [160, 160], wind, seed: 1, maxPieces: 12000 }).setTime(60).update(flat, 0);
    let worst = 0;
    for (let k = 0; k < probe.matrices.length; k++) worst = Math.max(worst, Math.abs(probe.matrices[k] - seek.matrices[k]));
    if (worst > 1e-3) console.warn(`BUG: stepping to 60 s laid out other sea ice than a seek (${worst} m)`);
    for (const { field } of fields) field.setTime(60);
    await check('Stepped 50 to 60 s');
  };
  button('btnCalm').onclick = async () => {
    applyIceSettings({ material: ice, foam, spray, seaIce: fields[0].field, water: sea }, ICE_LOOKS.calmNight);
    applyWaterSettings(sea, { windSpeed: 3 });
    await check('Calm night');
    if (ice.look.blueIce !== 0.4) console.warn('BUG: the calm night look did not reach the ice');
  };
  button('btnGale').onclick = async () => {
    for (const { field } of fields) applyIceSettings({ seaIce: field, water: sea }, ICE_LOOKS.gale);
    applyIceSettings({ material: ice, foam, spray, water: sea }, ICE_LOOKS.gale);
    applyWaterSettings(sea, { windSpeed: 20 });
    await check('Gale');
    if (spray.sprayRate !== 8000 || foam.look.waveHeight !== 7) console.warn('BUG: the gale look did not reach the foam and spray');
  };
  button('btnFollow').onclick = async () => {
    for (const { field } of fields) applyIceSettings({ seaIce: field, water: sea }, { driftWind: null, waveHeight: null });
    applyIceSettings({ foam, water: sea }, { waveHeight: null });
    await check('Follow the weather');
    if (foam.look.waveHeight !== null || fields[0].field.wind.speed !== sea.wind?.speed) console.warn('BUG: null rows did not hand the foam and the drift back to the wind');
  };
  button('btnClose').onclick = async () => {
    // Close on the waterline at the weather face: the notch, the wet band and the foam.
    const [x, z] = spray.face();
    engine.camera.position = [x - 30, 5, z - 18];
    engine.camera.target = [x, 2, z];
    await check('Close on the waterline');
  };
  await check('Start');
  return engine;
}

ready(start());
