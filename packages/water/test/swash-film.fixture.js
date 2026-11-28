import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, sphereGeometry, toGeometry } from '@margoengine/geometry';
import { geometryData } from '@margoengine/geometry/utils';
import { Material, Texture, createMesh } from '@margoengine/materials';
import { bedSurface } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { SurfSolver } from '@margoengine/physics/surf';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { Tonemap } from '@margoengine/tonemap';
import { Water } from '@margoengine/water';
import { WaveQuery } from '@margoengine/water/query';
import { ShallowWaterSurface } from '@margoengine/water/shallow-surface';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const columns = 46;
const rows = 5;
const size = [46, 12];
const origin = [0, -6];
// Extend the view laterally using the physical grid's periodic alongshore boundary.
const renderRows = rows * 3;
const renderSize = [size[0], size[1] * 3];
const renderOrigin = [origin[0], -renderSize[1] / 2];
const dx = size[0] / columns;
const dz = size[1] / rows;
const seed = 7;
const cue = 16;
const lead = 38;
const high = 46;
const end = 52;
const wetWindow = 18;
const mark = [33.5, 0];
const visibleDepth = 0.003; // Water's existing cutoff for a drawn sheet.
const width = 768;
const height = 456;
const camera = { position: [39.1, 6.5, 5.6], target: [30.8, 0.15, -0.9], fov: 38, near: 0.2, far: 94 };

function wrap(z) {
  return z - size[1] * Math.floor((z - origin[1]) / size[1]);
}

function makeBed() {
  const elevation = new Float64Array((columns + 1) * (rows + 1));
  for (let i = 0; i <= columns; i++) {
    for (let j = 0; j <= rows; j++) {
      const x = i * dx;
      const z = origin[1] + j * dz;
      elevation[i * (rows + 1) + j] = -1.2 + 0.045 * x + 0.024 * Math.cos(2 * Math.PI * (z / size[1] + 0.26));
    }
  }
  return bedSurface({ columns, rows, width: size[0], depth: size[1], centre: [size[0] / 2, 0] }, elevation);
}

function makeTake(bed, groups) {
  // Long-wave run-up from short-wave groups, as in Roelvink et al. (2009), doi:10.1016/j.coastaleng.2009.08.006.
  const hydro = new ShallowWaterSolver();
  const surf = new SurfSolver();
  const world = new PhysicsWorld({ rate: { num: 1, den: 1 }, seed, gravity: [0, -9.81, 0], memory: worldMemory(false) })
    .add(hydro, { bed, level: 0, roughness: 0.022, sides: { minX: { sea: 0 }, minZ: 'periodic', maxZ: 'periodic' } })
    .add(surf, {
      water: hydro,
      incident: { height: 0.62, period: 7, direction: 0.12 },
      groups,
      directions: 8,
      alongshore: 'periodic',
    })
    .couple(['surf', 'water'], 'staggered');
  return {
    world,
    hydro,
    surf,
    initial: world.takeSnapshot(),
    initialVolume: hydro.volume(),
    frame: 0,
    recorded: new Map(),
  };
}

function beach(engine, bed) {
  const positions = [],
    normals = [],
    uv = [],
    faces = [];
  for (let j = 0; j <= renderRows; j++) {
    for (let i = 0; i <= columns; i++) {
      const x = origin[0] + i * dx;
      const z = renderOrigin[1] + j * dz;
      const ground = bed.sample(x, wrap(z));
      positions.push(x, ground.elevation, z);
      normals.push(...ground.normal);
      uv.push(i / columns, j / renderRows);
      if (i === columns || j === renderRows) continue;
      const a = j * (columns + 1) + i;
      const b = a + columns + 1;
      faces.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const scale = 8;
  const texWidth = columns * scale,
    texHeight = renderRows * scale;
  const bytes = new Uint8Array(texWidth * texHeight * 4);
  const sand = new Texture(
    { data: bytes, width: texWidth, height: texHeight },
    { colorSpace: 'srgb', flipY: false, mipmaps: false },
  );
  const mat = new Material({ map: sand, roughness: 0.83 });
  const mesh = createMesh(
    engine,
    geometryData(
      Float32Array.from(positions),
      Float32Array.from(normals),
      Float32Array.from(uv),
      Uint32Array.from(faces),
    ),
    mat,
  );
  function update(wet) {
    // Twomey, Bohren and Mergenthaler (1986), doi:10.1364/AO.25.000431, measured the reflectance loss of wet sand.
    // These two art swatches convey the accepted wet/dry mark. They are not a fitted material model.
    for (let j = 0; j < texHeight; j++) {
      const row = Math.floor(j / scale) * columns;
      const z = (j + 0.5) / scale;
      for (let i = 0; i < texWidth; i++) {
        const x = (i + 0.5) / scale;
        const colour = wet[row + Math.floor(i / scale)] ? [128, 105, 83] : [184, 160, 126];
        const grain = (((i * 37 + j * 17 + ((i * j) % 61)) % 29) - 14) * 0.33;
        const strata = 3 * Math.sin(2.4 * x + Math.sin(z * 2.7)) + 2 * Math.cos(z * 5 - x * 4);
        bytes.set(
          [colour[0] + grain + strata, colour[1] + grain + strata, colour[2] + grain + strata, 255],
          4 * (j * texWidth + i),
        );
      }
    }
    sand.update();
  }
  return {
    update,
    dispose() {
      mesh.dispose();
      mat.dispose();
      sand.dispose();
    },
  };
}

function shoreProps(engine, bed) {
  const stone = new PbrMaterial({ color: '#706860', roughness: 0.97 });
  const darkStone = new PbrMaterial({ color: '#595653', roughness: 0.95 });
  const rock = toGeometry(sphereGeometry(1, 14, 8));
  for (const [x, z, rx, ry, rz, turn] of [
    [35.7, -2.9, 0.43, 0.23, 0.38, -0.15],
    [36.13, -2.5, 0.58, 0.35, 0.43, 0.23],
    [36.57, -3.15, 0.31, 0.16, 0.27, -0.12],
    [35.44, -1.93, 0.21, 0.12, 0.19, 0.2],
  ]) {
    const ground = bed.sample(x, z).elevation;
    engine
      .createMesh()
      .setGeometry(rock)
      .setScale([rx, ry, rz])
      .setPosition([x, ground + ry * 0.34, z])
      .setQuaternion([0, Math.sin(turn / 2), 0, Math.cos(turn / 2)])
      .setMaterial(turn > 0 ? stone : darkStone);
  }
  const wood = new PbrMaterial({ color: '#604c3c', roughness: 0.86 });
  const lime = new PbrMaterial({ color: '#d1c1a0', roughness: 0.69 });
  const shaft = toGeometry(cylinderGeometry(0.045, 0.056, 0.72, 12));
  const x = 32.5,
    z = -3.77;
  const y = bed.sample(x, z).elevation;
  engine
    .createMesh()
    .setGeometry(shaft)
    .setPosition([x, y + 0.24, z])
    .setMaterial(wood);
  for (let step = 0; step < 5; step++) {
    const stripe = toGeometry(cylinderGeometry(0.054 - 0.0016 * step, 0.054 - 0.0016 * step, 0.03, 12));
    engine
      .createMesh()
      .setGeometry(stripe)
      .setPosition([x, y + 0.105 + 0.09 * step, z])
      .setMaterial(lime);
  }
  engine
    .createMesh()
    .setGeometry(box(0.16, 0.065, 0.115))
    .setPosition([x, y + 0.61, z])
    .setMaterial(wood);
}

export async function setupSwashFilm() {
  const bed = makeBed();
  const active = makeTake(bed, true);
  const steady = makeTake(bed, false);
  let selected = active;
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#93a9a9';
  engine.lighting.direction.set([-0.51, 0.55, 0.61, 2.1]);
  engine.lighting.radiance.set([1, 0.93, 0.81, 1]);
  engine.lighting.ambient.set([0.43, 0.51, 0.58]);
  const ground = beach(engine, bed);
  shoreProps(engine, bed);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.12 });
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  gpu.pushErrorScope('validation');
  const terrain = gpu.createTexture({
    size: [columns, renderRows],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const cells = Array.from({ length: columns * renderRows }, (_, i) => [
    origin[0] + ((i % columns) + 0.5) * dx,
    wrap(renderOrigin[1] + (Math.floor(i / columns) + 0.5) * dz),
  ]);
  gpu.queue.writeTexture(
    { texture: terrain },
    Float32Array.from(cells, ([x, z]) => bed.sample(x, z).elevation),
    { bytesPerRow: columns * 4 },
    [columns, renderRows],
  );
  const water = Water.attach(engine, {
    height: -2,
    size: [92, 72],
    segments: 192,
    terrain: { heightmap: () => terrain, origin: renderOrigin, size: renderSize },
    waves: [{ direction: [1, 0], amplitude: 0, wavelength: 7 }],
    color: [0.024, 0.123, 0.14],
    foamDistance: 0.065,
    chop: 0,
    whitecaps: 0,
  });
  const source = {
    shape: { columns, rows: renderRows, width: renderSize[0], depth: renderSize[1], centre: active.hydro.shape.centre },
    sample: (x, z, out) => selected.hydro.sample(x, wrap(z), out),
  };
  const mirror = ShallowWaterSurface.attach(engine, { surface: water, source });
  const picture = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: picture } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const output = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  const dry = new Array(cells.length).fill(false);
  ground.update(dry);
  let checkpoint;

  function seek(take, frame, action) {
    if (action === 'restore' || frame < take.frame) {
      const saved = action === 'restore' ? checkpoint : { bytes: take.initial.bytes, frame: 0 };
      take.world.restoreSnapshot(saved.bytes);
      take.frame = saved.frame;
    }
    if (frame > take.frame) take.world.advance((take.frame = frame));
    const state = take.world.takeSnapshot();
    const earlier = take.recorded.get(frame);
    if (earlier && (earlier.length !== state.bytes.length || earlier.some((b, i) => b !== state.bytes[i])))
      throw new Error('Restore the exact accepted hydro volume, surf transport and wet-sand history.');
    take.recorded.set(frame, state.bytes);
    if (action === 'save') checkpoint = { bytes: state.bytes, frame };
    return state.hash;
  }

  function screenPoint(x, z) {
    const y = bed.sample(x, z).elevation;
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      ((1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * width) / 2,
      ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * height) / 2,
    ];
  }

  async function sample({ editFrame, mode, dryLook = false, query = false, action }) {
    const frame = Math.max(0, Math.min(end, editFrame - cue));
    selected = mode === 'steady' ? steady : active;
    const hash = seek(selected, frame, action);
    const { hydro, surf, world, initialVolume } = selected;
    const wet = cells.map(
      ([x, z]) => surf.wetSand(x, z, wetWindow) && (!dryLook || hydro.sample(x, z).depth >= visibleDepth),
    );
    let shoreline = 0;
    let trace = 0;
    let waterOnSand = 0;
    for (let i = 0; i < columns; i++) {
      const x = origin[0] + (i + 0.5) * dx;
      const q = hydro.sample(x, 0);
      if (q.depth >= 0.01) shoreline = x;
      if (q.depth < 0.005 && surf.wetSand(x, 0, wetWindow)) trace++;
      if (bed.sample(x, 0).elevation > 0) waterOnSand += q.depth * dx;
    }
    ground.update(wet);
    water.resetTime();
    water.setTime(world.time);
    draw();
    draw();
    const commands = gpu.createCommandEncoder();
    commands.copyTextureToBuffer({ texture: picture }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
    gpu.queue.submit([commands.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const rgba = new Uint8ClampedArray(readback.getMappedRange()).slice();
    readback.unmap();
    output.putImageData(new ImageData(rgba, width, height), 0, 0);
    const heightQuery = query ? await WaveQuery.capture(water) : undefined;
    const runUp = surf.runUp(mark);
    return {
      hash,
      frame,
      shoreline,
      trace,
      waterOnSand,
      mark: {
        ...hydro.sample(...mark),
        wet: surf.wetSand(...mark, wetWindow),
        pixel: screenPoint(...mark),
        drawn: heightQuery?.heightAt(...mark) ?? null,
      },
      backwash: hydro.sample(25.5, 0).velocity[0],
      incomingHeight: surf.waveHeight(20.5, 0),
      runUp: Number.isFinite(runUp) ? runUp : null,
      budget: hydro.budget,
      volume: hydro.volume(),
      initialVolume,
      image: encoded.toDataURL('image/png').split(',')[1],
    };
  }

  await waitForPipelines(draw);
  return {
    cue,
    lead,
    high,
    end,
    sample,
    async dispose() {
      mirror.dispose();
      ground.dispose();
      terrain.destroy();
      picture.destroy();
      readback.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { errors, validation };
    },
  };
}
