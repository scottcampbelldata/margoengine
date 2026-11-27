// A scaled straight quay with an incoming finite-depth packet. The low sill is a controlled renderer fixture.
import { box, EngineKernel, PbrMaterial } from '/packages/core/dist/index.js';
import { FiniteQuayWake, QuayWakeBoundary } from '/packages/physics/dist/loads.js';
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

// A finite face separates two wet cells. The diagonal at the corner has a shorter open route on
// one side of the X-first tie, and the dry block has no opaque mesh to conceal a shader leak.
export async function createFiniteWakeMaskScene(canvas) {
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 9, 0.21], target: [0, 0, 0], fov: 57, near: 0.08, far: 26 },
  });
  engine.gpu.pushErrorScope('validation');
  engine.scene.background = '#b12b64';
  const cells = [6, 6];
  const plane = 36;
  const wet = new Uint8Array(plane * 2).fill(1);
  for (const offset of [0, plane]) {
    wet[offset + 1 + 6] = 0;
    wet[offset + 1 + 2 * 6] = 0;
  }
  const openX = new Float64Array(plane * 2).fill(1);
  const openZ = new Float64Array(plane * 2).fill(1);
  openX[2 + 3 * 6] = 0;
  openZ[3 + 2 * 6] = 0.25;
  const wake = new FiniteQuayWake();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wake, {
    cells,
    cellSize: 1,
    origin: [-3, -3],
    depths: [0, 0.5, 2],
    wet,
    openX,
    openZ,
    initial: (x, z) => [x === -0.5 && z === -0.5 ? 0.92 : x > 1 ? 0.45 : 0.2, 0],
  });
  const water = Water.attach(engine, { size: [8, 8], segments: 64, sea: { waveComponents: () => 0 } });
  const effect = WaterWake.attach(engine, { surface: water, wake });
  const render = async () => {
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
  };
  await render();

  const compare = async () => {
    const { vertices } = await WaveQuery.capture(water);
    let maxHeightError = 0;
    let maxNormalError = 0;
    const corner = {};
    for (let i = 0; i < vertices.length; i += 12) {
      const x = vertices[i + 3],
        z = vertices[i + 7];
      const {
        height,
        slope: [sx, sz],
      } = wake.sample(x, z);
      const norm = Math.hypot(sx, 1, sz);
      maxHeightError = Math.max(maxHeightError, Math.abs(vertices[i + 1] - height));
      maxNormalError = Math.max(
        maxNormalError,
        Math.hypot(vertices[i + 4] + sx / norm, vertices[i + 5] - 1 / norm, vertices[i + 6] + sz / norm),
      );
      if (x === 0 && z === 0) corner.tie = vertices[i + 1];
      if (x === 0.125 && z === 0.25) corner.closed = vertices[i + 1];
      if (x === 0.25 && z === 0.125) corner.open = vertices[i + 1];
      if (x === 0.125 && z === 0.75) corner.oneSidedX = vertices[i + 4];
    }
    return { maxHeightError, maxNormalError, corner, vertices: vertices.length / 12 };
  };
  const initial = await compare();
  world.advance(1);
  await render();
  const stepped = await compare();
  const toPixel = ([x, z]) => {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[11] * z + m[15];
    return [
      Math.floor((((m[0] * x + m[8] * z + m[12]) / w) * 0.5 + 0.5) * canvas.width),
      Math.floor((0.5 - ((m[1] * x + m[9] * z + m[13]) / w) * 0.5) * canvas.height),
    ];
  };
  const probes = { dry: toPixel([-1.5, -1.5]), wet: toPixel([-1.5, 0.65]), beyond: toPixel([3.5, 0.65]) };
  return {
    receipt: { initial, stepped, probes },
    async drawWithoutMask() {
      effect.dispose();
      WaterWake.attach(engine, { surface: water, wake: { grid: wake.grid, heights: () => wake.heights() } });
      await render();
    },
    async drawBackground() {
      water.dispose();
      await render();
    },
    async dispose() {
      const validation = await engine.gpu.popErrorScope();
      engine.dispose();
      return validation?.message ?? null;
    },
  };
}
