import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { FogVolumes } from '@margoengine/environment/fog-volumes';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Physics } from '@margoengine/physics';
import { HULL_BREACHES_FIELD, HULL_BREACH_WORDS, HullSolver } from '@margoengine/physics/seakeeping';
import { TracerSolver, TRACER_MATERIALS } from '@margoengine/physics/tracers';
import {
  BODIES_FIELD,
  BODY_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 456;
const rate = 60;
const gravity = 9.81;
const density = 1025;
const cue = 14;
const lasts = 395;
const opens = 0.36;
const closes = 1.64;
const floor = -2.72;
const parcelMass = 0.55;
const camera = { position: [2.6, 1.85, 9.85], target: [-0.15, -0.77, 1.77], fov: 42, near: 0.09, far: 40 };
const fines = TRACER_MATERIALS.ironOre;
const pellets = { density: 3800, diameter: 0.012, shape: 0.85, colour: [0.29, 0.105, 0.065] };
const fineShare = 0.2;
const breach = [-2.31, -0.63, 1.8];
const strip = 0.95;
const flow = {
  medium: 'water',
  cell: [0, 0, 0],
  sample(_x, _y, _z, _t, out) {
    out.velocity = [0.62, 0, 0.21];
    out.temperature = 286;
    out.density = density;
    return out;
  },
};

function cuboid([x0, y0, z0], [x1, y1, z1]) {
  return {
    vertices: Float64Array.of(
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ),
    indices: Uint32Array.of(
      0,
      3,
      2,
      0,
      2,
      1,
      4,
      5,
      6,
      4,
      6,
      7,
      0,
      1,
      5,
      0,
      5,
      4,
      3,
      7,
      6,
      3,
      6,
      2,
      0,
      4,
      7,
      0,
      7,
      3,
      1,
      2,
      6,
      1,
      6,
      5,
    ),
  };
}

export async function oreWorld(open) {
  await Physics.load();
  const world = new PhysicsWorld({
    memory: worldMemory(false),
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
  });
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / rate, gravity: [0, -gravity, 0] });
  const hullMass = density * 8.4 * 3.6 * 1.07;
  const body = physics.addBody(null, {
    colliders: { shape: 'box', halfExtents: [4.2, 1.055, 1.8], mass: hullMass },
  });
  const hull = new HullSolver();
  const tracers = new TracerSolver();
  const loaded = 3.5 * 3.26 * 0.74 * 0.6 * 5200;
  const cargo = { material: 'ironOre', diameter: 0.012, mass: loaded };
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [
        {
          row: body.row,
          mesh: cuboid([-4.2, -1.07, -1.8], [4.2, 1.04, 1.8]),
          compartments: [
            {
              mesh: cuboid([-3.95, -1.0, -1.63], [-0.45, 0.85, 1.63]),
              permeability: 0.6,
              water: 0.6 * 3.5 * 3.26 * 1.45,
              cargo,
            },
          ],
          openings: [
            {
              from: 0,
              to: 'outside',
              centre: breach,
              normal: [0, 0, 1],
              width: strip,
              height: 0.32,
              opens: open ? opens : lasts / rate + 1,
              closes: open ? closes : lasts / rate + 2,
            },
          ],
        },
      ],
      sea: { density, elevation: () => 0 },
      slamming: false,
      greenWater: false,
      stations: 12,
      memory: 8,
    })
    .add(tracers, {
      water: flow,
      waterDensity: density,
      bed: -floor,
      particleMass: parcelMass,
      capacity: 3600,
      horizontalDiffusivity: 0.044,
      verticalDiffusivity: 0.0012,
      breachMixes: [
        {
          body: body.row,
          opening: 0,
          fractions: [
            { material: fines, fraction: fineShare },
            { material: pellets, fraction: 1 - fineShare },
          ],
        },
      ],
    });
  world.couple(['hull', 'rigid'], 'staggered');
  return { world, physics, body, hull, tracers, loaded };
}

export function outflow(take) {
  const port = take.hull.exportPorts(take.world.tick).find(({ field }) => field === HULL_BREACHES_FIELD.name);
  if (port?.region.type !== 'f64') throw new Error('Read the accepted f64 hull breach.');
  const words = regionWords(take.world.memory, port.region);
  return words[0] === 0 ? undefined : Array.from(words.subarray(1, 1 + HULL_BREACH_WORDS));
}

export function oreReceipt(take) {
  const { tracers } = take;
  const regions = [
    { mass: 0, water: 0, bed: 0, weightedX: 0, weightedY: 0, count: 0 },
    { mass: 0, water: 0, bed: 0, weightedX: 0, weightedY: 0, count: 0 },
  ];
  const particles = [...tracers.particlesOf()];
  for (const particle of particles) {
    const material = tracers.materialList[particle.material];
    const id = material.diameter === pellets.diameter ? 1 : 0;
    if (material.diameter !== (id === 1 ? pellets.diameter : fines.diameter) || particle.state === 'surface')
      throw new Error('This submerged source needs exactly the two authored sinking ore classes.');
    const region = regions[id];
    region.mass += particle.mass;
    region[particle.state] += particle.mass;
    region.weightedX += particle.mass * particle.position[0];
    region.weightedY += particle.mass * particle.position[1];
    region.count++;
  }
  const centroid = regions.map((lane) =>
    lane.mass > 0 ? [lane.weightedX / lane.mass, lane.weightedY / lane.mass] : [0, 0],
  );
  return { particles, regions, centroid, budget: tracers.budget, materials: tracers.materialList };
}

function studyHull(engine) {
  const root = engine.createMesh();
  root.name = 'Loaded civil ore barge';
  const paint = (color, roughness = 0.78) => new PbrMaterial({ color, roughness });
  const shell = paint('#3a5660');
  const oxide = paint('#8e503f');
  const steel = paint('#515a59');
  const plate = paint('#c4ae85');
  const rail = paint('#c9c9b7', 0.58);
  const gasket = paint('#293c42');
  const brace = paint('#726958');
  function slab([a, b, c], at, material, bevel = 0) {
    const geometry = bevel ? toGeometry(roundedBoxGeometry(a, b, c, 2, bevel)) : box(a, b, c);
    return engine.createMesh(root).setGeometry(geometry).setPosition(at).setMaterial(material);
  }
  slab([8.4, 2.11, 3.6], [0, -0.015, 0], shell);
  slab([8.39, 0.94, 0.065], [0, -0.6, 1.795], oxide, 0.019);
  slab([8.39, 0.18, 0.071], [0, 0.045, 1.793], steel, 0.016);
  slab([8.31, 0.075, 3.51], [0, 1.068, 0], steel, 0.023);
  for (const x of [-2.16, 2.05]) {
    slab([2.86, 0.145, 2.51], [x, 1.175, 0], gasket, 0.027);
    slab([2.73, 0.104, 2.4], [x, 1.278, 0], plate, 0.028);
    for (const delta of [-0.83, 0, 0.83]) slab([0.046, 0.038, 2.27], [x + delta, 1.343, 0], brace);
  }
  // The shell collar is the exact rectangle of the authored outflow port.
  for (const side of [-1, 1]) {
    slab([0.044, 0.41, 0.054], [breach[0] + side * (strip / 2 + 0.022), breach[1], 1.841], steel, 0.01);
    slab([strip, 0.042, 0.054], [breach[0], breach[1] + side * 0.18, 1.841], steel, 0.01);
  }
  const shutter = slab([strip, 0.34, 0.03], [breach[0], breach[1], 1.858], gasket, 0.01);
  for (const side of [-1, 1]) {
    const z = side * 1.685;
    for (const x of [-3.88, -2.84, -1.2, 0, 1.2, 2.84, 3.88]) slab([0.034, 0.32, 0.036], [x, 1.26, z], rail, 0.009);
    slab([7.82, 0.041, 0.042], [0, 1.414, z], rail, 0.012);
  }
  return { root, shutter };
}

const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = ([a, b, c], [x, y, z]) => [b * z - c * y, c * x - a * z, a * y - b * x];
const unit = (v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

function seabed(engine) {
  // The broad planar floor is the same bed level used by the tracer boundary. Raised rocks are behind the ore field.
  const floorMaterial = new PbrMaterial({ color: '#637478', roughness: 0.94 });
  const gravel = new PbrMaterial({ color: '#56666a', roughness: 0.98 });
  const slab = engine
    .createMesh()
    .setGeometry(box(48, 0.18, 28))
    .setPosition([0, floor - 0.09, 0])
    .setMaterial(floorMaterial);
  slab.name = 'Sediment bed at −2.72 m';
  const rock = toGeometry(sphereGeometry(1, 12, 8));
  for (const [x, z, sx, sy, sz] of [
    [-5.8, -1.1, 0.96, 0.24, 0.48],
    [-6.5, 0, 1.22, 0.32, 0.67],
    [4.65, -0.65, 1.12, 0.21, 0.58],
    [-3.1, -1.9, 0.6, 0.2, 0.39],
    [2.75, -1.82, 0.49, 0.16, 0.29],
    [5.5, 0.6, 0.89, 0.17, 0.44],
  ]) {
    engine
      .createMesh()
      .setGeometry(rock)
      .setScale([sx, sy, sz])
      .setPosition([x, floor + sy * 0.41, z])
      .setMaterial(gravel);
  }
}

const plumeOrigin = [-6.5, -2.73, -0.5];
const plumeCorner = [6.5, 0.01, 6.6];
const plumeGrid = [36, 16, 24];

function concentration(take, receipt) {
  const { mass, colour } = take.tracers.concentration(plumeOrigin, plumeCorner, plumeGrid);
  const cellVolume = plumeCorner.reduce((v, x, i) => (v * (x - plumeOrigin[i])) / plumeGrid[i], 1);
  let sampledMass = 0;
  const colourMass = [0, 0, 0];
  for (let i = 0; i < mass.length; i++) {
    const m = mass[i] * cellVolume;
    sampledMass += m;
    for (let k = 0; k < 3; k++) colourMass[k] += m * colour[i * 3 + k];
  }
  const painted = receipt.regions[0].water + receipt.regions[1].water;
  if (Math.abs(sampledMass - painted) > Math.max(1e-6, 1e-6 * painted))
    throw new Error('Sample the entire accepted suspended plume in its declared optical grid.');
  return {
    mass: sampledMass,
    colour: sampledMass > 0 ? colourMass.map((x) => x / sampledMass) : [0, 0, 0],
  };
}

export async function setupBreachOre() {
  const active = await oreWorld(true);
  const sealed = await oreWorld(false);
  const takes = { active, sealed };
  for (const take of [active, sealed]) {
    take.initial = take.world.takeSnapshot();
    take.frame = 0;
    take.lost = 0;
    take.records = new Map();
  }
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:768px;height:456px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { exactSize: [width, height], backend: 'webgpu', camera });
  engine.scene.background = '#233d48';
  engine.lighting.direction.set([0.37, 0.63, 0.68, 1.95]);
  engine.lighting.radiance.set([0.97, 0.91, 0.78, 1]);
  engine.lighting.ambient.set([0.49, 0.6, 0.64]);
  const ship = studyHull(engine);
  seabed(engine);
  const particleShape = toGeometry(sphereGeometry(1, 9, 6));
  const pelletMaterial = new PbrMaterial({ color: pellets.colour, roughness: 0.75 });
  const samples = [];
  Tonemap.attach(engine);
  const cloud = new FogVolumes();
  const fog = VolumetricFog.attach(engine, {
    density: 0.038,
    height: -0.1,
    heightFalloff: 2,
    color: [0.31, 0.59, 0.65],
    ambient: [0.38, 0.5, 0.53],
    grid: [64, 40, 56],
    range: 14,
    temporal: 0,
    anisotropy: 0.25,
  });
  const labelRenderer = TextRenderer.attach(engine);
  const film = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const note = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const forward = unit(sub(camera.target, camera.position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = unit(cross(right, forward));
  const at = (x, y) => camera.target.map((v, i) => v + x * right[i] + y * up[i]);
  const label = (text, x, y, font, fontSize, color) =>
    labelRenderer.add(
      new Text({
        text,
        position: at(x, y),
        font,
        fontSize,
        color,
        billboard: true,
        onTop: true,
      }),
    );
  label('Ore from a breached hold', -4.83, 2.98, film, 0.235, '#e9ddd0');
  label('Suspended fines and settling taconite', -4.82, 2.7, note, 0.123, '#cfd9d6');
  const totals = label('', -4.82, -2.97, note, 0.123, '#e1d9cc');

  const dev = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  dev.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  dev.pushErrorScope('validation');
  const draw = async () => {
    engine.render({ delta: 0 });
    await dev.queue.onSubmittedWorkDone();
  };

  const mistRadius = 0.525;
  const mistEdge = 0.22;
  // Geometric interception area for a sphere of diameter d: particle mass / density divided by sphere volume,
  // times projected area. Normalize the optical volume to this area. The smoothstep edge is a mixture of
  // spheres at depths u * mistEdge with weights 6u(1-u), whose first three moments are 1/2, 3/10, 1/5.
  const areaPerKg = 3 / (2 * fines.density * fines.diameter);
  const mistIntegral =
    ((4 * Math.PI) / 3) *
    (mistRadius ** 3 - 1.5 * mistRadius ** 2 * mistEdge + 0.9 * mistRadius * mistEdge ** 2 - 0.2 * mistEdge ** 3);
  function paint(receipt, visibility) {
    const fineVolumes = [];
    const waterCount = receipt.regions[0].count;
    let shown = 0;
    for (const particle of receipt.particles) {
      const isCoarse = receipt.materials[particle.material].diameter === pellets.diameter;
      if (!isCoarse) {
        if (particle.state === 'water' && visibility !== 'no-fines') {
          fineVolumes.push({
            shape: 'sphere',
            center: particle.position,
            radius: mistRadius,
            edge: mistEdge,
            density: (particle.mass * areaPerKg) / mistIntegral,
            color: fines.colour,
          });
        }
        continue;
      }
      if (visibility === 'no-pellets') continue;
      if (!samples[shown]) samples[shown] = engine.createMesh().setGeometry(particleShape).setMaterial(pelletMaterial);
      // One inspection glyph has the projected area of the grains in its accepted dry-mass parcel.
      const radius = Math.sqrt((particle.mass * 3) / (2 * Math.PI * pellets.density * pellets.diameter));
      const [x, y, z] = particle.position;
      samples[shown]
        .setPosition([x, particle.state === 'bed' ? y + radius : y, z])
        .setScale([radius, radius, radius]).visible = true;
      shown++;
    }
    for (let i = shown; i < samples.length; i++) samples[i].visible = false;
    cloud.volumes = fineVolumes;
    if (visibility === 'all' && fineVolumes.length !== waterCount)
      throw new Error('Draw every accepted suspended fine parcel.');
    return {
      shown,
      opticalMass: (fineVolumes.reduce((sum, volume) => sum + volume.density, 0) * mistIntegral) / areaPerKg,
    };
  }

  function position(take) {
    const port = take.world.fields.port(BODIES_FIELD.name);
    if (port?.region.layout !== 2 || port.region.type !== 'f32')
      throw new Error('Draw the accepted hull pose from its layout-2 port.');
    const bodies = regionWords(take.world.memory, port.region);
    const row = take.body.row * BODY_WORDS;
    ship.root
      .setPosition(Array.from(bodies.subarray(row, row + 3)))
      .setQuaternion(Array.from(bodies.subarray(row + 3, row + 7)));
  }

  let checkpoint;
  function restore(take, snapshot, frame, lost) {
    take.world.restoreSnapshot(snapshot.bytes);
    take.frame = frame;
    take.lost = lost;
  }

  async function render(shotFrame, mode, action, visibility = 'all') {
    const take = takes[mode];
    const target = Math.max(0, Math.min(lasts, shotFrame - cue));
    if (action === 'restore') restore(take, checkpoint.snapshot, checkpoint.frame, checkpoint.lost);
    else if (target < take.frame) restore(take, take.initial, 0, 0);
    while (take.frame < target) {
      take.world.advance(++take.frame);
      take.lost += (outflow(take)?.[12] ?? 0) / rate;
    }
    const state = take.world.takeSnapshot();
    const earlier = take.records.get(target);
    if (earlier && (earlier.length !== state.bytes.length || earlier.some((x, i) => x !== state.bytes[i])))
      throw new Error('Restore and re-advance the exact physical hull and mixed ore state.');
    take.records.set(target, state.bytes);
    if (action === 'save') checkpoint = { snapshot: state, frame: take.frame, lost: take.lost };
    position(take);
    const time = take.world.time;
    const held = takes[mode].hull.floodedCompartments(take.body.row)?.[0];
    if (!held) throw new Error('Read the accepted ore inventory of the loaded hold.');
    ship.shutter.visible = mode === 'sealed' || time < opens || time >= closes;
    const receipt = oreReceipt(take);
    const opt = concentration(take, receipt);
    const visual = paint(receipt, visibility);
    const { regions, centroid, budget } = receipt;
    totals.text = 'Suspended ' + budget.water.toFixed(1) + ' kg  /  On bed ' + budget.bed.toFixed(1) + ' kg';
    // Initialize the capture target with the same clear field before each separately directed sample.
    fog.options.volumes = undefined;
    fog.resetTime();
    await draw();
    fog.options.volumes = cloud;
    await draw();
    return {
      hash: state.hash,
      time,
      ot: ship.shutter.visible,
      lost: take.lost,
      retained: held.cargoMass,
      regions,
      centroid,
      budget,
      opt,
      visual,
    };
  }
  await render(0, 'active');
  await waitForPipelines(draw, { ready: () => !!fog.texture });
  return {
    render,
    cue,
    lasts,
    opens,
    closes,
    rate,
    fineShare,
    parcelMass,
    floor,
    areaPerKg,
    openedMass: active.loaded,
    fineColour: fines.colour,
    pelletColour: pellets.colour,
    source: () => outflow(active),
    async dispose() {
      fog.dispose();
      cloud.dispose();
      labelRenderer.dispose();
      active.physics[Symbol.dispose]();
      sealed.physics[Symbol.dispose]();
      const validation = (await dev.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}
