// Margo implementation of the parity environment scenes (../parity.js, area 'environment'): @margoengine/environment
// (HDR, EXR, IBL prefilter, fog, volumetric fog), @margoengine/sky and @margoengine/tonemap.
import { engineRuntime } from '@margoengine/core/extension';
import { LIGHT } from '../catalog.js';
import { app, engineFor, floor, meshes, palette } from '../margo.js';

const ms = (s) => +(performance.now() - s).toFixed(1);
const stillCamera = { fov: 45, near: 0.1, far: 100, target: [0, 0, 0], at: () => [0, 0, 3] };
const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

/**
 * Materials textures upload when a material that uses them is drawn (there is no separate upload call), so a task
 * puts the texture on one small unlit quad, draws one frame and waits for the GPU.
 */
async function uploader(canvas, marks) {
  const engine = await engineFor(canvas, stillCamera, 16, marks),
    { UnlitMaterial, Texture, createMesh } = await import('@margoengine/materials'),
    { planeGeometry } = await import('@margoengine/geometry'),
    material = new UnlitMaterial({ color: '#ffffff' });
  createMesh(engine, planeGeometry(0.2, 0.2), material);
  material.map = new Texture({ data: new Float32Array(16 * 4), width: 4, height: 4, format: 'rgba16float' });
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  let last;
  return {
    engine,
    Texture,
    async upload(texture) {
      material.map = texture;
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
      last?.dispose();
      last = texture;
    },
    get last() {
      return last;
    },
  };
}

/** A float-image load task: `parse(bytes)` to linear RGBA floats, uploaded as an rgba16float texture. */
async function floatLoad(canvas, data, marks, parse) {
  const up = await uploader(canvas, marks),
    s = performance.now(),
    bytes = await fetchBytes(data.url);
  marks.buildMs = ms(s);
  let size;
  return {
    async task() {
      const { width, height, data: pixels } = parse(bytes);
      size = [width, height];
      await up.upload(new up.Texture({ data: pixels, width, height, format: 'rgba16float' }, { colorSpace: 'linear' }));
    },
    output: () => {
      const t = up.last?.gpuTexture(up.engine.gpu);
      return { width: size?.[0], height: size?.[1], format: t?.format };
    },
    info: () => ({
      note: 'rgba16float (three: HalfFloatType); Margo uploads on first draw: one frame with a small quad',
    }),
  };
}

export const builders = {
  async 'p-hdr-load'(canvas, data, marks) {
    const { parseHDR } = await import('@margoengine/environment');
    return floatLoad(canvas, data, marks, parseHDR);
  },

  async 'p-exr-load'(canvas, data, marks) {
    const { parseEXR } = await import('@margoengine/environment');
    const job = await floatLoad(canvas, data, marks, parseEXR);
    return {
      ...job,
      info: () => ({ note: `${job.info().note}; BrightRings.exr is ZIP-compressed, not PIZ as the spec says` }),
    };
  },

  async 'p-pmrem'(canvas, data, marks) {
    const engine = await engineFor(canvas, stillCamera, 16, marks),
      s = performance.now(),
      { parseHDR, Environment } = await import('@margoengine/environment'),
      image = parseHDR(await fetchBytes(data.url));
    // One build outside the timing compiles the prefilter pipelines (three's PMREMGenerator is warmed the same way).
    (await Environment.create(engine, image)).dispose();
    await engine.gpu.queue.onSubmittedWorkDone();
    marks.buildMs = ms(s);
    let last;
    return {
      async task() {
        const environment = await Environment.create(engine, image);
        await engine.gpu.queue.onSubmittedWorkDone();
        last?.dispose();
        last = environment;
      },
      output: () => ({ width: image.width, height: image.height, irradianceSH: last?.sh?.irradiance?.length ?? null }),
      info: () => ({
        note: 'Environment.create: GGX-prefiltered specular mips, L2 SH irradiance and a BRDF LUT (three PMREM: specular cubeUV only)',
      }),
    };
  },

  async 'p-pmrem-refresh'(canvas, data, marks) {
    const engine = await engineFor(canvas, stillCamera, 16, marks),
      s = performance.now(),
      { parseHDR, Environment } = await import('@margoengine/environment'),
      image = parseHDR(await fetchBytes(data.url)),
      // The HDR goes to the GPU once, outside the timing, and its cube is the source of the environment under test.
      decoded = await Environment.create(engine, image),
      environment = await Environment.create(engine, { texture: decoded.cubeTexture }, { keepSource: true });
    await environment.refresh();
    await engine.gpu.queue.onSubmittedWorkDone();
    marks.buildMs = ms(s);
    return {
      async task() {
        await environment.refresh();
        await engine.gpu.queue.onSubmittedWorkDone();
      },
      output: () => ({
        width: image.width,
        height: image.height,
        irradianceSH: environment.sh.irradiance.length,
      }),
      info: () => ({
        note: 'Environment.refresh: mips, GGX-prefiltered specular and L2 SH from a GPU cube (three PMREM: specular cubeUV only)',
      }),
    };
  },

  async 'p-fog'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { Fog } = await import('@margoengine/environment');
    meshes(engine, data, palette(data));
    Fog.attach(engine, { color: data.fog.color, density: data.fog.density });
    marks.buildMs = ms(s);
    return app(engine, () => {}, { camera: data.camera });
  },

  async 'p-volumetric'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [{ Shadows }, { VolumetricFog }, { Tonemap }] = await Promise.all([
        import('@margoengine/shadows'),
        import('@margoengine/environment/volumetric'),
        import('@margoengine/tonemap'),
      ]),
      { density, scattering, steps } = data.medium;
    Tonemap.attach(engine); // neutral: the default display curve; gives the fog its scene depth
    const shadows = Shadows.attach(engine, { resolution: 2048, cascades: 1, filter: 'pcf', distance: data.extent * 2 });
    shadows.add(floor(engine, data.floor), { static: true });
    for (const mesh of meshes(engine, data, palette(data))) shadows.add(mesh);
    VolumetricFog.attach(engine, {
      density,
      color: [scattering, scattering, scattering],
      anisotropy: 0,
      grid: [160, 90, steps],
      shadows,
    });
    marks.buildMs = ms(s);
    return app(engine, () => {}, {
      camera: data.camera,
      note: `froxel volume (160 x 90 x ${steps} slices, screen-size independent) instead of a half-resolution ${steps}-step raymarch; core batches, fog passes not counted`,
    });
  },

  async 'p-sky'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { Sky, sunDirectionFromAngles } = await import('@margoengine/sky');
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const sun = new Float32Array(3),
      sky = Sky.attach(engine, { turbidity: data.sky.turbidity, timeScale: 0, sunDirection: [0, 1, 0] }),
      update = (t) => {
        sunDirectionFromAngles(180, 10 + 30 * Math.sin(t * 0.2), sun);
        sky.options.sunDirection = [sun[0], sun[1], sun[2]];
      };
    update(0);
    marks.buildMs = ms(s);
    return app(engine, update, {
      camera: data.camera,
      note: 'Preetham sky; Margo exposes turbidity only (Rayleigh and Mie coefficients are fixed in its model)',
    });
  },

  async 'p-tonemap'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { Tonemap } = await import('@margoengine/tonemap');
    engineRuntime(engine).lighting.direction.set([...LIGHT.direction, data.intensity]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    Tonemap.attach(engine, { curve: 'acescg', exposure: 0 }); // exposure in stops: 0 = three's toneMappingExposure 1
    marks.buildMs = ms(s);
    return app(engine, () => {}, {
      camera: data.camera,
      note: "Tonemap 'acescg' (ACES fitted RRT/ODT, AP1) against three's ACESFilmicToneMapping; curves differ",
    });
  },
};
