import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { computeVertexNormals, cylinderGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { geometryData } from '@margoengine/geometry/utils';
import { Physics } from '@margoengine/physics';
import { NonlinearSea } from '@margoengine/physics/rogue';
import { HullSolver } from '@margoengine/physics/seakeeping';
import { jonswap } from '@margoengine/physics/waves';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';
import { seaMotion } from './seakeeping-film.fixture.js';
import { launchHull } from './wave-impact-film.fixture.js';

const rate = 60;
const gravity = [0, -9.81, 0];
const depth = 28;
const cue = 18;
const event = { position: [0, 0], time: 4, crest: 1.35 };
const duration = 264;
const width = 768;
const height = 456;
const cells = [81, 65];
const size = [90.72, 72.8];
const origin = size.map((meters) => -meters / 2);
const camera = { position: [6.7, 3.9, 10.6], target: [-0.45, 0.55, 0], fov: 37, near: 0.13, far: 180 };

function spectrum() {
  const frequencies = Float64Array.from({ length: 21 }, (_, i) => 0.12 + 0.017 * i);
  const directions = Float64Array.from({ length: 24 }, (_, i) => -Math.PI + (i * 2 * Math.PI) / 24);
  return jonswap(
    { height: 0.72, period: 4.35, direction: 0.82, peakedness: 4.5 },
    { frequencies, directions, energy: new Float64Array(frequencies.length * directions.length), depth, density: 1000 },
    -gravity[1],
  );
}

function launch(waveSpectrum, ship, focused) {
  // A NewWave design crest is specified in space and time. See Tromans, Anaturk and Hagemeijer (1991),
  // A New Model For The Kinematics Of Large Ocean Waves, OnePetro ISOPE-I-91-154.
  // Johannessen and Swan (2001), doi:10.1098/rspa.2000.0702, studied the dynamic laboratory counterpart.
  const sea = new NonlinearSea({ spectrum: waveSpectrum, components: 12, seed: 52, rogues: focused ? [event] : false });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity, memory: worldMemory(false) });
  const physics = new Physics(null, { fixedTimestep: 1 / rate, gravity, arena: world.arena });
  const body = physics.addBody(null, {
    position: [-0.25, 0, 0],
    colliders: { shape: 'box', halfExtents: [2.55, 0.33, 0.87], mass: ship.mass },
  });
  const hull = new HullSolver();
  world.add(new RigidSolver(), { physics }).add(hull, {
    hulls: [{ row: body.row, mesh: ship.mesh }],
    sea,
    stations: 10,
    memory: 10,
    greenWater: false,
    slamming: false,
  });
  world.couple(['hull', 'rigid'], 'staggered');
  return {
    sea,
    world,
    physics,
    body,
    frame: 0,
    previousVertical: 0,
    initial: world.takeSnapshot(),
    records: new Map(),
  };
}

function drawLaunch(engine, ship) {
  const root = engine.createMesh();
  root.name = 'Coastal survey launch';
  const paint = (color, roughness = 0.73) => new PbrMaterial({ color, roughness });
  const seal = paint('#75433d');
  const stripe = paint('#d9a863');
  const side = paint('#2b4549');
  const deck = paint('#75695e');
  const cabin = paint('#dfd4bf', 0.56);
  const glass = paint('#527274', 0.22);
  const rail = paint('#98a6a2', 0.45);
  const dark = paint('#424942');
  const vertices = Float32Array.from(ship.mesh.vertices);
  const uv = Float32Array.from(ship.uv);
  const full = computeVertexNormals(geometryData(vertices, new Float32Array(vertices.length), uv, ship.mesh.indices));
  [seal, stripe, side, deck].forEach((material, i) => {
    const group = geometryData(vertices, full.normals, uv, Uint32Array.from(ship.finish[i]));
    engine.createMesh(root).setGeometry(toGeometry(group)).setMaterial(material);
  });
  const part = (mesh, material, x, y, z) =>
    engine
      .createMesh(root)
      .setGeometry(mesh)
      .setMaterial(material)
      .setPosition([x - ship.centre, y, z]);
  function slab(a, b, c, material, x, y, z, radius = 0) {
    return part(radius ? toGeometry(roundedBoxGeometry(a, b, c, 2, radius)) : box(a, b, c), material, x, y, z);
  }
  slab(1.54, 0.76, 1.39, cabin, 0.46, 0.56, 0, 0.06);
  slab(1.64, 0.1, 1.55, dark, 0.44, 0.98, 0, 0.035);
  for (const z of [-0.436, 0, 0.436]) slab(0.028, 0.29, 0.38, glass, 1.234, 0.758, z, 0.008);
  for (const z of [-0.705, 0.705]) {
    for (const x of [0.25, 0.812]) slab(0.42, 0.294, 0.028, glass, x, 0.758, z, 0.007);
    slab(1.1, 0.042, 0.039, rail, -1.47, 0.54, z, 0.01);
    for (const x of [-1.98, -1.45, -0.92]) slab(0.032, 0.36, 0.032, rail, x, 0.367, z, 0.006);
  }
  slab(1.31, 0.19, 0.98, deck, -1.62, 0.245, 0, 0.045);
  part(toGeometry(cylinderGeometry(0.027, 0.037, 0.56, 12)), rail, 0.49, 1.29, 0.21);
  slab(0.44, 0.053, 0.062, cabin, 0.49, 1.58, 0.21, 0.017);
  part(toGeometry(cylinderGeometry(0.048, 0.04, 0.2, 10)), stripe, 0.13, 1.09, -0.37);
  return root;
}

export async function setupRogueFilm() {
  await Physics.load();
  const ship = launchHull();
  const base = spectrum();
  const focused = launch(base, ship, true);
  const plain = launch(base, ship, false);
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#839ba1';
  engine.lighting.direction.set([-0.54, 0.38, 0.73, 2.3]);
  engine.lighting.radiance.set([0.98, 0.94, 0.87, 1]);
  engine.lighting.ambient.set([0.47, 0.56, 0.63]);
  const model = drawLaunch(engine, ship);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.18 });

  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  gpu.pushErrorScope('validation');
  const terrain = gpu.createTexture({
    size: cells,
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  gpu.queue.writeTexture(
    { texture: terrain },
    new Float32Array(cells[0] * cells[1]).fill(-depth),
    { bytesPerRow: cells[0] * 4 },
    cells,
  );
  const water = Water.attach(engine, {
    size,
    height: 0,
    segments: 148,
    terrain: { heightmap: () => terrain, origin, size },
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 18 }],
    color: [0.025, 0.105, 0.148],
    transparency: 0.1,
    whitecaps: 0,
    foamDistance: 0.012,
    chop: 0,
  });
  let shownSea = focused.sea;
  let seconds = 0;
  const source = {
    shape: { columns: cells[0], rows: cells[1], width: size[0], depth: size[1], centre: [0, 0] },
    sample(x, z, out) {
      out.surface = shownSea.elevation(x, z, seconds);
      out.depth = depth + out.surface;
      // This is a film surface resample. The mirror adds no shallow-water transport.
      out.velocity[0] = out.velocity[1] = 0;
      return out;
    },
  };
  const mirror = ShallowWaterSurface.attach(engine, { surface: water, source });
  const texture = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: texture } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const output = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  let checkpoint;

  function seek(take, frame, action) {
    if (action === 'restore') {
      take.world.restoreSnapshot(checkpoint.state.bytes);
      take.frame = checkpoint.frame;
      take.previousVertical = checkpoint.previousVertical;
    } else if (frame < take.frame) {
      take.world.restoreSnapshot(take.initial.bytes);
      take.frame = 0;
      take.previousVertical = 0;
    }
    if (frame > take.frame) {
      // Read the adjacent accepted velocity so the receipt measures the net loading applied to the rigid body.
      take.world.advance(frame - 1);
      take.previousVertical = take.body.linearVelocity[1];
      take.world.advance(frame);
      take.frame = frame;
    }
    const state = take.world.takeSnapshot();
    const first = take.records.get(frame);
    if (first && (first.length !== state.bytes.length || first.some((byte, i) => byte !== state.bytes[i])))
      throw new Error('Reproduce the exact accepted state of the coupled launch before drawing it.');
    take.records.set(frame, state.bytes);
    if (action === 'save') checkpoint = { state, frame, previousVertical: take.previousVertical };
    return state;
  }

  async function sample({ shotFrame, mode, action, query = false }) {
    const frame = Math.max(0, Math.min(duration, shotFrame - cue));
    const take = mode === 'plain' ? plain : focused;
    const state = seek(take, frame, action);
    const motion = seaMotion(take);
    const pose = mode === 'plain-pose' ? (seek(plain, frame), seaMotion(plain)) : motion;
    model.setPosition(pose.position).setQuaternion(pose.rotation);
    shownSea = take.sea;
    seconds = take.world.time;
    water.resetTime();
    water.setTime(seconds);
    draw();
    draw();
    const command = gpu.createCommandEncoder();
    command.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
    gpu.queue.submit([command.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const rgba = new Uint8ClampedArray(readback.getMappedRange()).slice();
    readback.unmap();
    output.putImageData(new ImageData(rgba, width, height), 0, 0);
    const verticalLoad = ship.mass * ((take.body.linearVelocity[1] - take.previousVertical) * rate - gravity[1]);
    return {
      hash: state.hash,
      motion,
      verticalLoad,
      crest: shownSea.elevation(...event.position, seconds),
      slopes: [-3.36, 3.36].map((x) => shownSea.elevation(x, 0, seconds)),
      renderedCrest: query ? (await WaveQuery.capture(water)).heightAt(...event.position) : undefined,
      image: encoded.toDataURL('image/png').split(',')[1],
    };
  }

  await waitForPipelines(draw);
  return {
    cue,
    duration,
    focus: event.time * rate,
    crest: event.crest,
    mass: ship.mass,
    sample,
    async dispose() {
      mirror.dispose();
      terrain.destroy();
      texture.destroy();
      readback.destroy();
      focused.physics[Symbol.dispose]();
      plain.physics[Symbol.dispose]();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}
