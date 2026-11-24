// Owner/lifetime fixture for @margoengine/voxel-pathtracer. A tracer is an engine plugin that compiles a trace pipeline
// and keeps scene, accumulation and readback buffers on the device until dispose(); the subclasses and the composed and
// mesh tracers add their own geometry words and kernel text. Entries, each attached with a scene that exercises its
// feature (the five plugins and DenoiseML after `ready` settles and one off-screen image is rendered, so a render's buffers are released
// too; the mesh and composed tracers are waited for once per leaf, see `wrapped`):
// - VoxelPathTracer, ResampledVoxelPathTracer, GuidedVoxelPathTracer, MediaVoxelPathTracer, SpectralVoxelPathTracer:
//   plugins, returned as they are.
// - MeshPathTracer and ComposedVoxelPathTracer (with every feature, and with the glTF PBR mesh feature): wrappers over an
//   inner tracer plugin and a Wasm geometry builder; tied to a plugin registration that releases the wrapper the way a
//   scene or engine disposal does (ownedByEngine).
// - DenoiseML: the learned denoiser's weight buffer, pipeline and lifetime signal, after one denoise.
// Not entries: the preset, material, atmosphere, sky, MagicaVoxel and viewport functions are pure functions of their
// input, and `studio` and `preview` only compute budgets and presets.
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const transform = (x, y, z, sx = 1, sy = 1, sz = 1) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];
const slab = (id, voxel) => ({ id, revision: 1, size: [4, 4, 4], voxels: new Uint8Array(64).fill(voxel) });
const material = [
  { id: 1, type: 'diffuse', color: [0.8, 0.6, 0.4] },
  { id: 2, type: 'emit', color: [1, 1, 1], emission: 4 },
  { id: 3, type: 'media', color: [0.5, 0.5, 0.5], density: 0.5, extinction: [1, 2, 3] },
];
const voxels = (extra = {}) => ({
  revision: 1,
  models: [slab('floor', 1), slab('lamp', 2), slab('fog', 3)],
  instances: [
    { id: 'floor', modelId: 'floor', matrix: transform(-2, -1, -2) },
    { id: 'lamp', modelId: 'lamp', matrix: transform(-2, 1, -2, 1, 0.25, 1) },
    { id: 'fog', modelId: 'fog', matrix: transform(-1, -1, -1, 0.5, 0.5, 0.5) },
  ],
  materials: material,
  ...extra,
});
const triangle = {
  id: 'triangle',
  material: 1,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};
const meshes = (extra = {}) =>
  voxels({ meshes: [{ ...triangle, uvs: new Float32Array([0, 0, 1, 0, 0, 1]) }], ...extra });
const pbr = () =>
  meshes({
    pbrMaterials: [
      { id: 1, metallicFactor: 0, baseColorTexture: { width: 1, height: 1, data: new Uint8Array([128, 64, 32, 255]) } },
    ],
  });
const image = { width: 4, height: 4, samples: 1, seed: 7, jitter: false, aovs: true };
const limit = () => AbortSignal.timeout(120000);

export const leafPerEntry = true;
// The trace kernel takes 100 to 270 s to compile on the Direct3D 11 route of the WebGL2 layer (the cold times in
// tests/compat-d3d11-case-seconds.json), and every case makes new devices, past the leaf's 180 s; on the Vulkan route a
// case takes seconds, as the package's own compose-browser.mjs runs it on Windows. Read by scripts/check-owner-lifetime-browser.mjs.
export const compatAngle = 'vulkan';

export async function fixtures(load = (entry) => import(entry)) {
  const { VoxelPathTracer } = await load('../dist/index.js');
  const { ResampledVoxelPathTracer } = await load('../dist/resampled.js');
  const { GuidedVoxelPathTracer } = await load('../dist/guiding.js');
  const { MediaVoxelPathTracer } = await load('../dist/media.js');
  const { SpectralVoxelPathTracer } = await load('../dist/spectral.js');
  const { MeshPathTracer } = await load('../dist/mesh.js');
  const { ComposedVoxelPathTracer } = await load('../dist/compose.js');
  const { resampledEmitters } = await load('../dist/resampled.js');
  const { triangleMeshes } = await load('../dist/mesh.js');
  const { coloredMedia } = await load('../dist/media.js');
  const { causticGuiding } = await load('../dist/guiding.js');
  const { spectralTransport } = await load('../dist/spectral.js');
  const { meshPBR } = await load('../dist/mesh-pbr.js');
  const { DenoiseML } = await load('../dist/denoise-ml.js');
  const plugin = (name, Tracer, options = {}, scene = voxels) => ({
    name,
    async create({ engine }) {
      const tracer = Tracer.attach(engine, { scene: scene(), denoise: false, ...options });
      await tracer.ready;
      await tracer.renderImage({ ...image, signal: limit() });
      return { plugin: tracer, dispose: () => tracer.dispose() };
    },
  });
  // A mesh kernel's trace pipeline takes 20 to 60 s to compile cold on native WebGPU, past the 20 s the harness gives a
  // frame to wait for pipelines, and about 3 s once the browser's shader cache has it. So the first of each is awaited
  // here (outside that wait); the later cases of the leaf find it cached, and wait in the harness's own frames. Each
  // case also replaces its scene once (a second geometry build and upload) before it is released.
  const cold = new Set();
  const wrapped = (name, make, next = meshes) => ({
    name,
    async create({ engine, scene }) {
      const tracer = await make(engine);
      if (!cold.has(name)) {
        await tracer.ready;
        cold.add(name);
      }
      await tracer.setScene(next());
      return ownedByEngine(scene, name, () => tracer.dispose());
    },
  });
  return [
    plugin('VoxelPathTracer', VoxelPathTracer),
    plugin('ResampledVoxelPathTracer', ResampledVoxelPathTracer, { candidates: 4 }),
    plugin('GuidedVoxelPathTracer', GuidedVoxelPathTracer),
    plugin('MediaVoxelPathTracer', MediaVoxelPathTracer),
    plugin('SpectralVoxelPathTracer', SpectralVoxelPathTracer),
    wrapped('MeshPathTracer', (engine) =>
      MeshPathTracer.create(engine, { scene: meshes(), denoise: false, signal: limit() }),
    ),
    wrapped('ComposedVoxelPathTracer', (engine) =>
      ComposedVoxelPathTracer.create(engine, {
        scene: meshes(),
        denoise: false,
        features: [resampledEmitters(), triangleMeshes(), coloredMedia(), causticGuiding(), spectralTransport()],
        signal: limit(),
      }),
    ),
    wrapped(
      'ComposedVoxelPathTracer.meshPBR',
      (engine) =>
        ComposedVoxelPathTracer.create(engine, {
          scene: pbr(),
          denoise: false,
          features: [meshPBR()],
          signal: limit(),
        }),
      pbr,
    ),
    {
      name: 'DenoiseML',
      async create({ engine, scene }) {
        const denoiser = await DenoiseML.create(engine, { signal: limit() });
        const count = 16;
        await denoiser.denoise(
          {
            width: 4,
            height: 4,
            color: new Float32Array(count * 3).fill(1),
            albedo: new Float32Array(count * 3).fill(0.5),
            normal: new Float32Array(count * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)),
            samples: 1,
          },
          { signal: limit() },
        );
        return ownedByEngine(scene, 'DenoiseML', () => denoiser.dispose());
      },
    },
  ];
}
