// Plant states test page: a hillside of pines and grass for @margoengine/scatter/states, using only public APIs. A
// FireFront burns across one half and a GroundChange lays flood mud and a burn scar on the other; one PlantStates map
// reads both and every plant that is left standing is scorched, charred, stripped or mud-marked where it stands. The
// buttons run the fire, move the ground's film time, paint a drought tint, apply look rows and reset the map; after each
// the page reads the map back and warns with BUG when a burnt or flooded cell holds nothing.
import { ready } from './page-harness';
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { heightfieldGeometry } from '@margoengine/terrain';
import { toGeometry } from '@margoengine/geometry/utils';
import { GroundChange } from '@margoengine/terrain/ground-change';
import { Scatter } from '@margoengine/scatter';
import { PlantStates, PLANT_STATE_LOOKS, applyPlantStateSettings, fireSource } from '@margoengine/scatter/states';
import { FireFront } from '@margoengine/vfx/fire-front';

// examples/tsconfig.json type-checks this page without @webgpu/types, so the two WebGPU flag namespaces are declared here.
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

const status = document.getElementById('status')!;
const say = (text: string) => (status.textContent = text);
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const hills = (x: number, z: number) => 0.04 * z + 1.5 * Math.sin(x * 0.05) * Math.cos(z * 0.04);
const grid = { size: [160, 160] as [number, number], origin: [-80, -80] as [number, number], resolution: 160 };
const bounds = [-80, -80, 80, 80] as const;

async function start() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  const engine = await Engine.create(canvas, { camera: { position: [0, 60, 110], target: [0, 0, 0], near: 0.5, far: 1000 } });
  engine.lighting.direction.set([0.5, 0.7, 0.3, 3]);
  const ground = engine
    .createMesh()
    .setGeometry(toGeometry(heightfieldGeometry(hills, grid)))
    .setMaterial(new PbrMaterial({ color: [0.3, 0.27, 0.2], roughness: 0.9 }));
  const change = GroundChange.attach(engine, ground, {
    grid,
    events: [
      { kind: 'mud', shore: [[10, 80], [80, 80]], land: 'left', reach: 50, thickness: 0.3, duration: 60, drying: 600 },
      { kind: 'burn', ignition: [40, -40], rate: 0.2, duration: 200 },
    ],
  });
  const fire = FireFront.attach(engine, { ground: hills, origin: [-80, -80], size: [80, 160], cell: 2, fuel: 'FM4', ignitions: [{ at: [-40, 0] }] });
  const states = PlantStates.create(engine, { bounds, resolution: 160, fire: fireSource(fire), ground: change.plantCovers() });
  const pines = states.plant({ crownBase: 1.5, trunkRadius: 0.12, stiffness: 2e4 }),
    grass = states.plant({ stiffness: 0.02, trunkRadius: 0 });
  const tree = box(0.25, 3, 0.25);
  Scatter.attach(engine, tree, { count: 1600, area: [160, 160], scale: [0.8, 1.4], material: new PbrMaterial({ color: [0.1, 0.3, 0.08] }), ...change.scatterGround(), states: pines });
  Scatter.attach(engine, box(0.05, 0.5, 0.05), { count: 40000, area: [160, 160], blades: {}, material: new PbrMaterial({ color: [0.25, 0.4, 0.1] }), ...change.scatterGround(), states: grass });
  engine.start();

  // The map back from the GPU: the fire layer's scorch at the ignition and the water mark on the mud shore.
  const check = async (what: string) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const device = engine.gpu!,
      map = states.map!,
      out = device.createBuffer({ size: map.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(map, 0, out, 0, map.size);
    device.queue.submit([encoder.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(out.getMappedRange().slice(0));
    out.destroy();
    const cell = (x: number, z: number) => Math.floor(z + 80) * 160 + Math.floor(x + 80),
      n = 160 * 160,
      scorch = data[8 + cell(-40, 0) * 4],
      mud = data[8 + (n + cell(40, 75)) * 4];
    say(`${what}: scorch ${scorch.toFixed(2)} m at the ignition, water mark ${mud.toFixed(2)} m on the shore.`);
    return { scorch, mud };
  };
  button('btnFire').onclick = async () => {
    fire.settle();
    if (!((await check('Fire run')).scorch > 0)) console.warn('BUG: the burnt ignition cell holds no scorch height');
  };
  button('btnGround').onclick = async () => {
    change.setTime(400);
    if (!((await check('Ground at 400 s')).mud > 0)) console.warn('BUG: the mud shore holds no water mark');
  };
  button('btnPaint').onclick = async () => {
    states.paint([-80, -80, 0, 80], [0.45, 0.38, 0.15], 0.6);
    await check('Drought paint');
  };
  button('btnConifer').onclick = async () => {
    applyPlantStateSettings(states, pines, PLANT_STATE_LOOKS.conifer);
    await check('Conifer rows');
  };
  button('btnReset').onclick = async () => {
    states.reset();
    await check('Reset');
  };
  return engine;
}

ready(start());
