// A scaled straight quay with an incoming finite-depth packet. The low sill is a controlled renderer fixture.
import { box, EngineKernel, PbrMaterial } from '/packages/core/dist/index.js';
import { QuayWakeBoundary } from '/packages/physics/dist/loads.js';
import { SpectralSea, WakeSolver } from '/packages/physics/dist/sea.js';
import { PhysicsWorld } from '/packages/physics/dist/world.js';
import { PostStack } from '/packages/post/dist/stack.js';
import { Tonemap } from '/packages/tonemap/dist/index.js';
import { VFX } from '/packages/vfx/dist/index.js';
import { Water } from '/packages/water/dist/index.js';
import { WaveQuery } from '/packages/water/dist/query.js';
import { wallOvertoppingSpawn, WaterWake } from '/packages/water/dist/wake.js';

const depth = 2.5;
const wallZ = 0;
const crest = 0.11;
const cellSize = 0.125;

function packet(x, z) {
  const k = (2 * Math.PI) / 1.8;
  const omega = Math.sqrt(9.81 * k * Math.tanh(k * depth));
  const distance = z - 2.1;
  const envelope = 0.08 * Math.exp(-0.5 * ((distance / 0.73) ** 2 + (x / 1.17) ** 2));
  // The negative potential quadrature launches towards decreasing Z, into the wet face.
  return [envelope * Math.cos(k * distance), (-9.81 / omega) * envelope * Math.sin(k * distance)];
}

function prepareWake(reflect) {
  const boundary = new QuayWakeBoundary({ wallZ });
  const wake = new WakeSolver();
  const options = { cells: [64, 64], cellSize, depth, density: 1000, sponge: 5, initial: packet };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(
    wake,
    reflect ? boundary.wakeParams(options) : { ...options, initial: (x, z) => (z >= wallZ ? packet(x, z) : [0, 0]) },
  );
  const wall = () => boundary.sampleWall(wake, 0);
  const initial = world.takeSnapshot();
  let previous = wall(),
    peak = previous.height,
    maxNormal = 0,
    spawn,
    hash;
  for (let frame = 1; frame <= 160; frame++) {
    world.advance(frame);
    const next = wall();
    peak = Math.max(peak, next.height);
    maxNormal = Math.max(maxNormal, Math.abs(next.velocity[2]));
    const event = wallOvertoppingSpawn(previous, next, [0, crest, wallZ]);
    if (!spawn && event) spawn = { frame, ...event };
    if (spawn && frame === spawn.frame + 1) hash = world.hash();
    previous = next;
  }
  const seek = (frame) => {
    world.restoreSnapshot(initial.bytes);
    world.advance(frame);
    return world.hash();
  };
  return { wake, spawn, peak, maxNormal, seek, hash };
}

export async function createQuayOvertoppingScene(canvas) {
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    camera: { position: [1.8, 0.8, 2.35], target: [0, 0.07, 0.05], fov: 37, near: 0.08, far: 26 },
  });
  engine.gpu.pushErrorScope('validation');
  engine.scene.background = '#8eacb8';
  engine.lighting.direction.set([0.44, 0.8, 0.28, 1.3]);
  engine.lighting.radiance.set([0.97, 0.94, 0.9, 0.22]);
  engine.lighting.ambient.set([0.4, 0.47, 0.52]);
  engine
    .createMesh()
    .setGeometry(box(3.8, 0.8, 0.9))
    .setMaterial(new PbrMaterial({ color: '#364349', roughness: 0.85 }))
    .setPosition([0, crest - 0.4, wallZ - 0.45]);

  const wall = prepareWake(true);
  const incident = prepareWake(false);
  if (!wall.spawn) throw new Error('This incident packet must overtop the reflecting low sill.');
  const frame = wall.spawn.frame + 1;
  const replay = wall.seek(frame);
  incident.seek(frame);
  const sea = new SpectralSea({
    waves: {
      frequencies: Float64Array.of(0.5, 1),
      directions: Float64Array.of(0, Math.PI),
      energy: new Float64Array(4),
      depth,
      density: 1000,
    },
  });
  const stack = PostStack.attach(engine, [new Tonemap({ curve: 'agx' })]);
  const water = Water.attach(engine, {
    size: [5.2, 5.2],
    segments: 72,
    sea,
    foamDistance: 0.025,
    color: [0.012, 0.045, 0.055],
    whitecaps: 0,
    depth: () => stack.depthTexture,
    sceneColor: () => stack.sceneTexture,
  });
  water.setTime(frame / 60);
  const render = async (delta = 0) => {
    engine.render({ delta });
    await engine.gpu.queue.onSubmittedWorkDone();
  };
  let effect = WaterWake.attach(engine, { surface: water, wake: incident.wake, minWetZ: wallZ });
  await render();
  const open = (await WaveQuery.capture(water)).vertices;
  const drawReflection = (withImageDomain) => {
    effect.dispose();
    effect = WaterWake.attach(engine, {
      surface: water,
      wake: wall.wake,
      minWetZ: withImageDomain ? undefined : wallZ,
    });
    return render();
  };
  await drawReflection(false);
  const reflected = (await WaveQuery.capture(water)).vertices;
  let maxDifference = 0,
    maxError = 0,
    nodes = 0;
  for (let i = 0; i < reflected.length; i += 12) {
    const x = reflected[i + 3],
      z = reflected[i + 7];
    if (Math.abs(x) > 0.5 || z < wallZ || z > wallZ + 0.44) continue;
    const expected = wall.wake.sample(x, z).height;
    maxDifference = Math.max(maxDifference, Math.abs(reflected[i + 1] - open[i + 1]));
    maxError = Math.max(maxError, Math.abs(reflected[i + 1] - expected));
    nodes++;
  }
  const spray = VFX.attach(engine, {
    capacity: 96,
    rate: 0,
    color: [0.9, 0.97, 1, 0.82],
    size: 0.025,
    lifetime: [0.25, 0.45],
    turbulence: 0,
  });
  return {
    receipt: {
      incident: { peak: incident.peak, spawn: incident.spawn, maxNormal: incident.maxNormal },
      reflected: { peak: wall.peak, spawn: wall.spawn, maxNormal: wall.maxNormal },
      maxDifference,
      maxError,
      nodes,
      hash: wall.hash,
      replay,
    },
    drawReflection,
    async showSpray() {
      const { position, velocity, fraction } = wall.spawn;
      // Billboards stand for unresolved droplets. Their launch is the accepted wall-crossing velocity.
      spray.burst(48, { position, velocity, spread: 0.09, emissionExtent: [0.075, 0, 0.012] });
      await render((2 - fraction) / 60);
    },
    async dispose() {
      const validation = await engine.gpu.popErrorScope();
      spray.dispose();
      effect.dispose();
      water.dispose();
      engine.dispose();
      return validation?.message ?? null;
    },
  };
}
