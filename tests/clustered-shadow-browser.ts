// Real-GPU fixture for clustered directional and area-light shadows (scripts/clustered-shadow-gpu-check.js).
// Built imports exercise the published package boundary. `probe` evaluates the production clusterLighting WGSL (the
// declarations a gltf-pro receiver gets) at chosen world points in a compute pass, against the shadow maps the frame
// graph rendered, so shadow factors can be compared with analytic expectations.
import { Engine, PbrMaterial, box } from '../packages/core/dist/extension.js';
import { Clustered } from '../packages/clustered/dist/index.js';
import { LocalShadows } from '../packages/clustered/dist/shadows.js';
import { DirectionalLights } from '../packages/clustered/dist/directional.js';
import { AreaLights } from '../packages/clustered/dist/area.js';
import { AreaShapes } from '../packages/clustered/dist/area-shapes.js';
import { ShadowAtlas } from '../packages/clustered/dist/shadow-atlas.js';
import { CubeProjectorLights } from '../packages/clustered/dist/cube-projector.js';
import { StochasticLights } from '../packages/clustered/dist/stochastic.js';
import { ContactLights } from '../packages/clustered/dist/contact.js';
import { Terrain } from '../packages/terrain/dist/index.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
  UNIFORM: number;
};
declare const GPUMapMode: { READ: number };
declare const GPUShaderStage: { COMPUTE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

type Light = Record<string, unknown>;
type Config = {
  local?: { resolution?: number; bias?: number; normalBias?: number } | false;
  points?: Light[];
  suns?: Light[];
  areas?: Light[];
  shapes?: Light[];
  atlas?: boolean;
  cubes?: unknown[];
  projectors?: unknown[];
  stochastic?: boolean;
  meshes: string[];
  /** Clipmap terrain over x, z in -4..4: flat at y 0 with a ridge 2 high over |x| < 0.5, a LocalShadows caster. */
  terrain?: boolean;
  /** ContactLights options (besides `lights`): contact shadows on the point lights, from the shared scene depth. */
  contact?: Record<string, unknown>;
};
const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 8, 8], target: [0, 0, 0], fov: 50, near: 0.1, far: 100 },
  }),
  errors: string[] = [];
engine.stop();
engine.lighting.radiance[3] = 0;
engine.lighting.ambient!.set([0.05, 0.05, 0.05]);
engine.onError = (error) => errors.push(String(error));
const device = engine.gpu!;
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
const grey = new PbrMaterial({ color: [0.8, 0.8, 0.8], roughness: 1, metalness: 0 });
const meshes: Record<string, ReturnType<typeof engine.createMesh>> = {};
function mesh(name: string, size: [number, number, number], position: [number, number, number]) {
  meshes[name] = engine
    .createMesh()
    .setGeometry(box(...size))
    .setPosition(position)
    .setMaterial(grey);
}
mesh('floor', [8, 0.1, 8], [0, -0.05, 0]); // top at y = 0
mesh('block', [1, 0.5, 1], [0, 1.25, 0]); // y 1 to 1.5
mesh('bar', [1, 0.05, 6], [0, 1.5, 0]); // a long bar, x -0.5 to 0.5, centred at y = 1.5
mesh('ceiling', [8, 0.1, 8], [0, 6.05, 0]); // bottom at y = 6
mesh('topBar', [1, 0.05, 6], [0, 4.5, 0]);
mesh('pebble', [0.4, 0.1, 0.4], [0, 0.05, 0]); // lying on the floor: x and z -0.2 to 0.2, y 0 to 0.1
let lights: Clustered | undefined, local: LocalShadows | undefined, suns: DirectionalLights | undefined;
let areas: AreaLights | undefined,
  terrain: Terrain | undefined,
  contact: ContactLights | undefined,
  shader = '';
let shapes: AreaShapes | undefined;
let cookies: CubeProjectorLights | undefined;
let stochastic: StochasticLights | undefined;
const ridge = new Float32Array(64 * 64).map((_, i) => (Math.abs(((i % 64) + 0.5) / 8 - 4) < 0.5 ? 2 : 0));
function terrainTextures(gpu: GPUDevice) {
  const heightmap = gpu.createTexture({
      size: [64, 64],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }),
    layers = gpu.createTexture({
      size: [1, 1, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  gpu.queue.writeTexture({ texture: heightmap }, ridge, { bytesPerRow: 256 }, [64, 64]);
  gpu.queue.writeTexture(
    { texture: layers },
    new Uint8Array(16).fill(200),
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1, 4],
  );
  return { heightmap, layers };
}
engine.frameGraph.add({
  name: 'clustered-shadow:capture',
  order: -2.5,
  execute(c) {
    if (c.backend === 'webgpu') shader = c.shader;
  },
});
function scene(config: Config) {
  for (const plugin of [contact, stochastic, cookies, shapes, terrain, areas, suns, local, lights]) plugin?.dispose();
  contact = undefined;
  stochastic = undefined;
  cookies = undefined;
  shapes = undefined;
  terrain = areas = suns = local = undefined;
  for (const [name, m] of Object.entries(meshes)) m.visible = config.meshes.includes(name);
  lights = Clustered.attach(engine, { grid: [4, 4, 4] });
  lights.setLights((config.points ?? []) as never);
  if (config.local !== false) {
    local = config.atlas
      ? ShadowAtlas.attach(engine, { lights, resolution: 512, minResolution: 32, maxResolution: 128, ...(config.local ?? {}) })
      : LocalShadows.attach(engine, { lights, resolution: 512, ...(config.local ?? {}) });
    for (const name of config.meshes) local.add(meshes[name]);
  }
  if (config.terrain) {
    terrain = Terrain.attach(engine, {
      textures: terrainTextures,
      layers: Array.from({ length: 4 }, () => ({ height: [-10, 10] as const, slope: [0, 1] as const, scale: 1 })),
      origin: [-4, -4],
      size: [8, 8],
      heightScale: 1,
      cellSize: 0.0625,
      levels: 4,
    });
    local?.add(terrain);
  }
  if (config.suns) (suns = DirectionalLights.attach(engine, { lights })).setLights(config.suns as never);
  if (config.areas) (areas = AreaLights.attach(engine, { lights })).setLights(config.areas as never);
  if (config.shapes) (shapes = AreaShapes.attach(engine, { lights })).setLights(config.shapes as never);
  if (config.cubes || config.projectors) {
    cookies = CubeProjectorLights.attach(engine, { lights });
    if (config.cubes) cookies.setCubes(config.cubes as never);
    if (config.projectors) cookies.setProjectors(config.projectors as never);
  }
  if (config.stochastic) stochastic = StochasticLights.attach(engine, { lights, quad: false, temporal: false });
  if (config.contact) contact = ContactLights.attach(engine, { lights, ...config.contact });
}
async function scoped<T>(work: () => T | Promise<T>): Promise<T> {
  device.pushErrorScope('validation');
  let result: T;
  try {
    result = await work();
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return result!;
}
const kinds: Record<number, GPUBindGroupLayoutEntry> = {};
for (const binding of [4, 14, 151, 155]) kinds[binding] = { binding, visibility: 0, buffer: { type: 'uniform' } };
for (const binding of [5, 6, 7, 17, 28, 141, 142, 143, 145, 150, 152])
  kinds[binding] = { binding, visibility: 0, buffer: { type: 'read-only-storage' } };
for (const binding of [15, 29])
  kinds[binding] = { binding, visibility: 0, texture: { sampleType: 'depth', viewDimension: '2d-array' } };
for (const binding of [16, 30]) kinds[binding] = { binding, visibility: 0, sampler: { type: 'comparison' } };
const probeCode = /* wgsl */ `
struct ProbePoint {position:vec4f,normal:vec4f}
@group(1) @binding(0) var<storage,read> probePoints:array<ProbePoint>;
@group(1) @binding(1) var<storage,read_write> probeOut:array<vec4f>;
@group(1) @binding(2) var<uniform> probeEye:vec4f;
@compute @workgroup_size(64) fn probeMain(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&probePoints)){return;}
  let p=probePoints[id.x];
  probeOut[id.x]=vec4f(clusterLighting(vec2f(0.5),p.position.xyz,normalize(p.normal.xyz),probeEye.xyz,vec3f(1),1.0,0.0,vec3f(0.04),1.0),1);
}`;
async function messages(code: string): Promise<string[]> {
  const info = await device.createShaderModule({ code }).getCompilationInfo();
  return info.messages.filter((m) => m.type !== 'info').map((m) => `${m.type}: ${m.message} (line ${m.lineNum})`);
}
(window as unknown as { clusteredShadowFixture: unknown }).clusteredShadowFixture = {
  errors,
  async scene(config: Config) {
    await scoped(() => scene(config));
  },
  /** Renders `frames` frames; returns LocalShadows' stats after the last and the lit shader core meshes drew with. */
  async render(frames = 1) {
    return scoped(() => {
      for (let i = 0; i < frames; i++) engine.render();
      return { stats: local ? { ...local.stats } : undefined, shader };
    });
  },
  /** ContactLights.setStrengths of the current scene. */
  contactStrengths(values: (number | null)[]) {
    contact!.setStrengths(values);
  },
  /** Moves the camera (camera-fitted cascades follow it). */
  camera(position: [number, number, number], target: [number, number, number] = [0, 0, 0]) {
    engine.camera.position = position;
    engine.camera.target = target;
  },
  /** WGSL compilation messages (warnings and errors) of the captured core shader and of the probe shader. */
  async compile() {
    return {
      core: await messages(shader),
      probe: await messages(lights!.pbr(0).declarations + probeCode),
    };
  },
  /** clusterLighting at each [x, y, z, nx, ny, nz] point (white Lambert-like base, roughness 1), RGB per point. */
  async probe(points: number[][]) {
    return scoped(async () => {
      const declarations = lights!.pbr(0).declarations,
        entries = lights!.bindings(),
        module = device.createShaderModule({ code: declarations + probeCode }),
        layout0 = device.createBindGroupLayout({
          entries: entries.map((e) => ({ ...kinds[e.binding], visibility: GPUShaderStage.COMPUTE })),
        }),
        layout1 = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          ],
        }),
        pipeline = device.createComputePipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout0, layout1] }),
          compute: { module, entryPoint: 'probeMain' },
        }),
        data = new Float32Array(points.length * 8);
      points.forEach((p, i) => data.set([p[0], p[1], p[2], 1, p[3], p[4], p[5], 0], i * 8));
      const input = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        output = device.createBuffer({
          size: points.length * 16,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
        eye = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        read = device.createBuffer({
          size: points.length * 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      try {
        device.queue.writeBuffer(input, 0, data);
        device.queue.writeBuffer(eye, 0, new Float32Array([...engine.camera.position, 1]));
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: layout0, entries }));
        pass.setBindGroup(
          1,
          device.createBindGroup({
            layout: layout1,
            entries: [
              { binding: 0, resource: { buffer: input } },
              { binding: 1, resource: { buffer: output } },
              { binding: 2, resource: { buffer: eye } },
            ],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(points.length / 64));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, read, 0, points.length * 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(read.getMappedRange().slice(0));
        read.unmap();
        return points.map((_, i) => [values[i * 4], values[i * 4 + 1], values[i * 4 + 2]]);
      } finally {
        for (const buffer of [input, output, eye, read]) buffer.destroy();
      }
    });
  },
  cubes(entries: unknown[]) {
    cookies!.setCubes(entries as never);
  },
  dispose() {
    for (const plugin of [contact, stochastic, cookies, shapes, terrain, areas, suns, local, lights]) plugin?.dispose();
    engine.dispose();
  },
};
